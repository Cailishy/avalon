import { type Server, type Socket } from "socket.io";
import { createHash } from "node:crypto";
import { RoomManager, type RoomTimingOptions, type RoomLimits } from "./roomManager";
import { TokenBucket, protectGameEvents } from "./security";
import { VoiceService } from "./voice";
import type { IncomingMessage } from "node:http";
import type { RoomStore } from "./roomStore";
import { RoomPersistence } from "./roomPersistence";
import { COMMAND_TTL_MS, PROTOCOL_VERSION, needsPhase, type CommandEvent, type GameAck } from "../shared/protocol";
import { CommandCapacityError, type CommandReceipt } from "./commandReceipt";

type AckPayload = GameAck;
type AuthedPayload = { roomCode: string; playerId: string; sessionToken: string };

export interface SocketRuntimeOptions {
  lobbyDisconnectGraceMs?: number;
  timing?: RoomTimingOptions;
  limits?: RoomLimits;
  address?: (req: IncomingMessage) => string;
  voice?: VoiceService;
  store?: RoomStore;
}

export interface SocketRuntime {
  rooms: RoomManager;
  publish: (roomCode: string) => void;
  close: () => Promise<void>;
  isHealthy: () => boolean;
}

export function attachSocketHandlers(io: Server, localUrls: string[], options: SocketRuntimeOptions = {}): SocketRuntime {
  const playerSockets = new Map<string, string>();
  const socketPlayers = new Map<string, string>();
  const lobbyDisconnectTimers = new Map<string, NodeJS.Timeout>();
  const lobbyDisconnectGraceMs = options.lobbyDisconnectGraceMs ?? 3000;
  const rooms = new RoomManager(localUrls, publish, options.timing, options.limits);
  const origins = new Map<string, string>();
  const roomAttempts = new TokenBucket(30, 0.5);
  const eventTraffic = { global: new TokenBucket(1000, 300, 1), addresses: new TokenBucket(120, 40) };
  const voice = options.voice ?? new VoiceService();
  const persistence = new RoomPersistence(rooms, origins, options.store);
  let closing = false;
  let activeCommand: { codes: Set<string>; effects: Array<() => void> } | null = null;
  const checkpointTimer = setInterval(() => persistence.checkpoint(), 1000);
  checkpointTimer.unref();
  const cleanupTimer = setInterval(() => {
    if (!persistence.healthy) return;
    try {
      for (const expired of rooms.cleanupExpiredRooms()) {
        persistence.save(expired.code);
        for (const playerId of expired.playerIds) notifyAndUnbindPlayer(playerId, expired.code, "room:dissolved", { message: "房间已超时关闭。" });
        voice.remove(expired.code);
        origins.delete(expired.code);
      }
      for (const code of origins.keys()) if (!rooms.getRoom(code)) { origins.delete(code); voice.remove(code); }
    } catch { if (persistence.healthy) console.error("Room cleanup failed."); }
  }, 60_000);
  cleanupTimer.unref();

  io.on("connection", (socket) => {
    const address = options.address?.(socket.request) ?? socket.handshake.address;
    protectGameEvents(socket, address, roomAttempts, eventTraffic);
    socket.emit("server:hello", { protocolVersion: PROTOCOL_VERSION });
    socket.on("clock:sync", (_payload: object, ack: (value: unknown) => void) => {
      const serverReceivedAt = Date.now();
      ack({ ok: true, protocolVersion: PROTOCOL_VERSION, serverReceivedAt, serverSentAt: Date.now() });
    });
    socket.on("command:status", (payload: { requestId: string; event: CommandEvent; sessionToken?: string }, ack: (value: unknown) => void) => {
      try {
        rooms.assertHealthy();
        const receipt = persistence.receipt(commandOwner(socket, payload.event, payload.sessionToken), payload.requestId);
        ack({ ok: true, result: receipt?.event === payload.event ? receipt.result : null });
      } catch { ack({ ok: false, error: "操作结果暂时无法核对，请稍后重试。" }); }
    });
    socket.on("room:create", (payload: { name: string; targetPlayerCount?: number }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "room:create", payload, ack, () => {
        for (const code of origins.keys()) if (!rooms.getRoom(code)) origins.delete(code);
        if ([...origins.values()].filter(value => value === address).length >= 5) throw new Error("当前来源的活跃房间已达上限。");
        const result = rooms.createRoom(payload.name, payload.targetPlayerCount);
        origins.set(result.roomCode, address);
        bindSocket(socket.id, result.roomCode, result.playerId);
        publish(result.roomCode);
        return result;
      });
    });

    socket.on("room:join", (payload: { roomCode: string; name: string }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "room:join", payload, ack, () => {
        const result = rooms.joinRoom(payload.roomCode, payload.name);
        bindSocket(socket.id, result.roomCode, result.playerId);
        publish(result.roomCode);
        return result;
      });
    });

    socket.on("room:addAI", (payload: AuthedPayload & { count: number }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "room:addAI", payload, ack, () => {
        rooms.addAIPlayers(payload.roomCode, payload.playerId, payload.sessionToken, payload.count);
        publish(payload.roomCode);
        return {};
      });
    });

    socket.on("room:setPlayerCount", (payload: AuthedPayload & { targetPlayerCount: number }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "room:setPlayerCount", payload, ack, () => {
        rooms.setTargetPlayerCount(payload.roomCode, payload.playerId, payload.sessionToken, payload.targetPlayerCount);
        publish(payload.roomCode);
        return {};
      });
    });

    socket.on("player:setReady", (payload: AuthedPayload & { ready: boolean }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "player:setReady", payload, ack, () => {
        rooms.setPlayerReady(payload.roomCode, payload.playerId, payload.sessionToken, payload.ready);
        publish(payload.roomCode);
        return {};
      });
    });

    socket.on("room:rejoin", (payload: AuthedPayload, ack: (result: AckPayload) => void) => {
      runAck(ack, () => {
        const { result } = rooms.syncPlayerSession(payload.roomCode, payload.playerId, payload.sessionToken);
        bindSocket(socket.id, result.roomCode, result.playerId);
        publish(result.roomCode);
        return result;
      });
    });

    socket.on("room:sync", (payload: AuthedPayload, ack: (result: AckPayload) => void) => {
      runAck(ack, () => {
        const { result, connectedChanged } = rooms.syncPlayerSession(payload.roomCode, payload.playerId, payload.sessionToken);
        bindSocket(socket.id, result.roomCode, result.playerId);
        if (connectedChanged) publish(result.roomCode);
        else sendStateToSocket(socket.id, result.roomCode, result.playerId);
        return {};
      });
    });

    socket.on("room:start", (payload: AuthedPayload, ack: (result: AckPayload) => void) => {
      runCommand(socket, "room:start", payload, ack, () => {
        rooms.startRoom(payload.roomCode, payload.playerId, payload.sessionToken);
        publish(payload.roomCode);
        rooms.simulateAI(payload.roomCode);
        return {};
      });
    });

    socket.on("player:kick", (payload: AuthedPayload & { targetId: string }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "player:kick", payload, ack, () => {
        const removed = rooms.kickPlayer(payload.roomCode, payload.playerId, payload.sessionToken, payload.targetId);
        saveRoom(payload.roomCode);
        notifyAndUnbindPlayer(removed.id, payload.roomCode, "room:removed", { message: "你已被房主移出房间。" });
        publish(payload.roomCode);
        return {};
      });
    });

    socket.on("room:dissolve", (payload: AuthedPayload, ack: (result: AckPayload) => void) => {
      runCommand(socket, "room:dissolve", payload, ack, () => {
        const removedPlayers = rooms.dissolveRoom(payload.roomCode, payload.playerId, payload.sessionToken);
        saveRoom(payload.roomCode);
        afterCommit(() => voice.remove(payload.roomCode));
        origins.delete(payload.roomCode);
        for (const player of removedPlayers) {
          notifyAndUnbindPlayer(player.id, payload.roomCode, "room:dissolved", { message: "房主已解散房间。" });
        }
        return {};
      });
    });

    socket.on("room:restart", (payload: AuthedPayload, ack: (result: AckPayload) => void) => {
      runCommand(socket, "room:restart", payload, ack, () => {
        rooms.restartRoom(payload.roomCode, payload.playerId, payload.sessionToken);
        publish(payload.roomCode);
        return {};
      });
    });

    socket.on("room:leave", (payload: AuthedPayload, ack: (result: AckPayload) => void) => {
      runCommand(socket, "room:leave", payload, ack, () => {
        const changedRoomCode = rooms.leaveRoom(payload.roomCode, payload.playerId, payload.sessionToken);
        saveRoom(payload.roomCode);
        unbindSocket(socket.id, payload.playerId, payload.roomCode);
        if (changedRoomCode) {
          publish(changedRoomCode);
          rooms.simulateAI(changedRoomCode);
        }
        return {};
      });
    });

    socket.on("team:propose", (payload: AuthedPayload & { team: string[]; questIndex?: number }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "team:propose", payload, ack, () => {
        rooms.proposeTeam(payload.roomCode, payload.playerId, payload.sessionToken, payload.team, payload.questIndex);
        publish(payload.roomCode);
        rooms.simulateAI(payload.roomCode);
        return {};
      });
    });

    socket.on("vote:submit", (payload: AuthedPayload & { approved: boolean }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "vote:submit", payload, ack, () => {
        rooms.submitVote(payload.roomCode, payload.playerId, payload.sessionToken, payload.approved);
        publish(payload.roomCode);
        rooms.simulateAI(payload.roomCode);
        return {};
      });
    });

    socket.on("mission:submit", (payload: AuthedPayload & { failed: boolean }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "mission:submit", payload, ack, () => {
        rooms.submitMission(payload.roomCode, payload.playerId, payload.sessionToken, payload.failed);
        publish(payload.roomCode);
        rooms.simulateAI(payload.roomCode);
        return {};
      });
    });

    socket.on("assassin:choose", (payload: AuthedPayload & { targetId: string }, ack: (result: AckPayload) => void) => {
      runCommand(socket, "assassin:choose", payload, ack, () => {
        rooms.chooseAssassinTarget(payload.roomCode, payload.playerId, payload.sessionToken, payload.targetId);
        publish(payload.roomCode);
        return {};
      });
    });

    socket.on("speech:end", (payload: AuthedPayload, ack: (result: AckPayload) => void) => {
      runCommand(socket, "speech:end", payload, ack, () => {
        rooms.endSpeech(payload.roomCode, payload.playerId, payload.sessionToken);
        publish(payload.roomCode);
        rooms.simulateAI(payload.roomCode);
        return {};
      });
    });

    socket.on("voice:join", async (payload: AuthedPayload, ack: (result: unknown) => void) => {
      try {
        if (closing) throw new Error("服务正在重启，请稍后重连。");
        rooms.validatePlayerSession(payload.roomCode, payload.playerId, payload.sessionToken);
        const room = rooms.getRoom(payload.roomCode);
        if (!room) throw new Error("房间不存在。");
        const access = await voice.join(room, payload.playerId);
        if (socket.data.playerId !== payload.playerId || socket.data.roomCode !== payload.roomCode || rooms.getRoom(payload.roomCode) !== room || voice.policy(room, payload.playerId).epoch !== access.epoch) throw new Error("语音会话已更新，请重试。");
        ack({ ok: true, access });
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : "语音连接失败。" });
      }
    });

    socket.on("disconnect", () => {
      if (closing || !persistence.healthy) return;
      const playerId = socketPlayers.get(socket.id);
      if (!playerId) return;
      socketPlayers.delete(socket.id);
      if (playerSockets.get(playerId) === socket.id) {
        playerSockets.delete(playerId);
      }
      const roomCode = rooms.disconnectPlayer(playerId);
      if (roomCode) {
        try { publish(roomCode); } catch { return; }
        rooms.simulateAI(roomCode);
        scheduleLobbyDisconnectRemoval(playerId);
      }
    });
  });

  function bindSocket(socketId: string, roomCode: string, playerId: string): void {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return;
    clearLobbyDisconnectRemoval(playerId);

    const previousPlayerId = socketPlayers.get(socketId);
    const previousRoomCode = socket.data.roomCode as string | undefined;
    if (previousPlayerId && previousPlayerId !== playerId) {
      if (playerSockets.get(previousPlayerId) === socketId) {
        playerSockets.delete(previousPlayerId);
        const disconnectedRoom = rooms.disconnectPlayer(previousPlayerId);
        if (disconnectedRoom) {
          publish(disconnectedRoom);
          rooms.simulateAI(disconnectedRoom);
          scheduleLobbyDisconnectRemoval(previousPlayerId);
        }
      }
      socketPlayers.delete(socketId);
    }

    const previousSocketId = playerSockets.get(playerId);
    if (previousSocketId && previousSocketId !== socketId) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      socketPlayers.delete(previousSocketId);
      if (previousSocket) {
        const roomToLeave = previousSocket.data.roomCode as string | undefined;
        if (roomToLeave) previousSocket.leave(roomToLeave);
        previousSocket.data.roomCode = undefined;
        previousSocket.data.playerId = undefined;
      }
    }

    if (previousRoomCode && previousRoomCode !== roomCode) {
      socket.leave(previousRoomCode);
    }
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    socketPlayers.set(socketId, playerId);
    playerSockets.set(playerId, socketId);
  }

  function unbindSocket(socketId: string, playerId: string, roomCode?: string): void {
    if (activeCommand) { activeCommand.effects.push(() => unbindSocket(socketId, playerId, roomCode)); return; }
    clearLobbyDisconnectRemoval(playerId);
    const socket = io.sockets.sockets.get(socketId);
    if (socket && roomCode) socket.leave(roomCode);
    if (playerSockets.get(playerId) === socketId) {
      playerSockets.delete(playerId);
    }
    if (socketPlayers.get(socketId) === playerId) {
      socketPlayers.delete(socketId);
    }
    if (socket) {
      socket.data.roomCode = undefined;
      socket.data.playerId = undefined;
    }
  }

  function notifyAndUnbindPlayer(playerId: string, roomCode: string, event: "room:removed" | "room:dissolved", payload: { message: string }): void {
    if (activeCommand) { activeCommand.effects.push(() => notifyAndUnbindPlayer(playerId, roomCode, event, payload)); return; }
    const socketId = playerSockets.get(playerId);
    if (!socketId) return;
    io.to(socketId).emit(event, payload);
    unbindSocket(socketId, playerId, roomCode);
  }

  function scheduleLobbyDisconnectRemoval(playerId: string): void {
    clearLobbyDisconnectRemoval(playerId);
    const originalRoomCode = rooms.roomCodes().find(code => rooms.getRoom(code)?.players.some(player => player.id === playerId));
    const timer = setTimeout(() => {
      lobbyDisconnectTimers.delete(playerId);
      if (closing || !persistence.healthy || playerSockets.has(playerId)) return;
      const changedRoomCode = rooms.removeDisconnectedLobbyPlayer(playerId);
      try {
        if (originalRoomCode) persistence.save(originalRoomCode);
        if (changedRoomCode) publish(changedRoomCode);
      } catch { return; }
    }, lobbyDisconnectGraceMs);
    lobbyDisconnectTimers.set(playerId, timer);
  }

  function clearLobbyDisconnectRemoval(playerId: string): void {
    const timer = lobbyDisconnectTimers.get(playerId);
    if (!timer) return;
    clearTimeout(timer);
    lobbyDisconnectTimers.delete(playerId);
  }

  function publish(roomCode: string): void {
    if (activeCommand) { activeCommand.codes.add(roomCode); return; }
    rooms.assertHealthy();
    persistence.save(roomCode);
    const room = rooms.getRoom(roomCode);
    if (!room) { voice.remove(roomCode); origins.delete(roomCode); return; }
    const voiceChanged = voice.update(room);
    io.to(roomCode).emit("room:state", rooms.getPublicState(roomCode));
    for (const player of room.players) {
      const socketId = playerSockets.get(player.id);
      if (!socketId) continue;
      io.to(socketId).emit("player:privateState", rooms.getPrivateState(roomCode, player.id));
      if (voiceChanged) io.to(socketId).emit("voice:policy", voice.policy(room, player.id));
    }
  }

  function saveRoom(code: string): void {
    if (activeCommand) activeCommand.codes.add(code);
    else persistence.save(code);
  }

  function afterCommit(effect: () => void): void {
    if (activeCommand) activeCommand.effects.push(effect);
    else effect();
  }

  function runCommand(socket: Socket, event: CommandEvent, value: object, ack: (result: GameAck) => void, action: () => object): void {
    const payload = value as Record<string, unknown> & { requestId: string; issuedAt: number; phaseId?: string };
    try {
      if (closing) throw new Error("服务正在重启，请稍后重连。");
      rooms.assertHealthy();
      if (payload.issuedAt < Date.now() - COMMAND_TTL_MS || payload.issuedAt > Date.now() + 30_000) {
        ack({ ok: false, code: "REQUEST_EXPIRED", error: "操作已过期或时间未校准，请同步后重新操作。" });
        return;
      }
      const entry = event === "room:create" || event === "room:join";
      const owner = commandOwner(socket, event, payload.sessionToken);
      const fingerprint = createHash("sha256").update(JSON.stringify({ event, payload })).digest("hex");
      const previous = persistence.receipt(owner, payload.requestId);
      if (previous) {
        if (previous.event !== event || previous.fingerprint !== fingerprint) {
          ack({ ok: false, code: "REQUEST_CONFLICT", error: "请求编号已用于其他操作，请同步后重试。" });
          return;
        }
        const saved = previous.result;
        if (entry && saved.ok && saved.roomCode && saved.playerId && saved.sessionToken && rooms.getRoom(saved.roomCode)?.players.some(player => player.id === saved.playerId)) {
          if (socket.data.playerId && socket.data.playerId !== saved.playerId) throw new Error("请先离开当前房间。");
          rooms.syncPlayerSession(saved.roomCode, saved.playerId, saved.sessionToken);
          bindSocket(socket.id, saved.roomCode, saved.playerId);
          publish(saved.roomCode);
        }
        ack(saved);
        return;
      }
      persistence.ensureCommandCapacity(owner);
      const transaction = { codes: new Set<string>(), effects: [] as Array<() => void> };
      activeCommand = transaction;
      let result: GameAck;
      try {
        if (entry ? Boolean(socket.data.playerId) : socket.data.playerId !== payload.playerId || socket.data.roomCode !== payload.roomCode) throw new Error(entry ? "请先离开当前房间。" : "请先恢复当前玩家会话。");
        if (needsPhase(event) && rooms.getRoom(String(payload.roomCode))?.phaseId !== payload.phaseId) {
          result = { ok: false, code: "STALE_PHASE", error: "游戏阶段已更新，请按当前页面重新操作。" };
        } else result = { ok: true, ...action() };
      } catch (error) {
        if (transaction.codes.size) throw error;
        result = { ok: false, error: error instanceof Error ? error.message : "操作失败。" };
      } finally { activeCommand = null; }
      const receipt: CommandReceipt = { owner, requestId: payload.requestId, event, fingerprint, expiresAt: payload.issuedAt + COMMAND_TTL_MS, result };
      persistence.commit(transaction.codes, receipt);
      transaction.effects.forEach(effect => effect());
      transaction.codes.forEach(code => publish(code));
      ack(result);
    } catch (error) {
      activeCommand = null;
      ack({ ok: false, ...(error instanceof CommandCapacityError ? { code: "RATE_LIMITED" } : {}), error: error instanceof Error ? error.message : "操作失败。" });
    }
  }

  function sendStateToSocket(socketId: string, roomCode: string, playerId: string): void {
    rooms.assertHealthy();
    const room = rooms.getRoom(roomCode);
    if (!room) return;
    io.to(socketId).emit("room:state", rooms.getPublicState(roomCode));
    io.to(socketId).emit("player:privateState", rooms.getPrivateState(roomCode, playerId));
    io.to(socketId).emit("voice:policy", voice.policy(room, playerId));
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    clearInterval(checkpointTimer);
    clearInterval(cleanupTimer);
    for (const timer of lobbyDisconnectTimers.values()) {
      clearTimeout(timer);
    }
    lobbyDisconnectTimers.clear();
    persistence.close();
    rooms.close();
    playerSockets.clear();
    socketPlayers.clear();
    origins.clear();
    await voice.close();
  }

  function runAck<T extends object>(ack: ((result: AckPayload & T) => void) | undefined, action: () => T): void {
    executeAck(ack, () => {
      if (closing) throw new Error("服务正在重启，请稍后重连。");
      rooms.assertHealthy();
      return action();
    });
  }

  return { rooms, publish, close, isHealthy: () => !closing && persistence.healthy };
}

function commandOwner(socket: Socket, event: string, token: unknown): string {
  const entry = event === "room:create" || event === "room:join";
  return createHash("sha256").update(entry ? socket.request.headers.cookie ?? socket.id : String(token)).digest("hex");
}

function executeAck<T extends object>(ack: ((result: AckPayload & T) => void) | undefined, fn: () => T): void {
  const send = (result: AckPayload & T) => {
    if (typeof ack === "function") ack(result);
  };
  try {
    send({ ok: true, ...fn() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败。";
    send({ ok: false, error: message } as AckPayload & T);
  }
}
