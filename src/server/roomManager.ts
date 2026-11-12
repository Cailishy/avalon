import crypto, { randomBytes } from "node:crypto";
import {
  ASSASSINATION_DURATION_MS,
  assertPlayerCount,
  buildRoles,
  getTeamSize,
  isForcedLaunch,
  MISSION_RESULT_DURATION_MS,
  PROPOSAL_REJECTION_DURATION_MS,
  ROLE_DEFS,
  ROLE_REVEAL_DURATION_MS,
  TEAM_SELECTION_DURATION_MS,
  type PrivatePlayerState,
  type PublicRoomState,
  type TimerKind,
  type Winner,
  type WinnerDetails,
} from "../shared/game";
import { GameError } from "../shared/errors";
import { clearRoomAI, scheduleRoomAI } from "./roomAI";
import { RoomRecovery } from "./roomRecovery";
import { roomFromSnapshot, type RoomSnapshot, type SavedTimer } from "./infrastructure/roomSnapshot";
import type { PlayerInternal, RoomInternal, RoomTimerInternal } from "./roomTypes";
import { privatePlayerState, publicRoomState } from "./roomViews";
import { evaluateMission, evaluateProposalVote, forcedProposalHistory, type ProposalVoteDecision } from "./domain/roomRules";
import type { JoinResult, RemovedPlayer, SessionSyncResult } from "./domain/roomContracts";
import { buildSpeechOrder, findNextLeaderIndex, nextOpenQuestIndex, resolveQuestIndex } from "./domain/roomFlow";

export type { JoinResult, RemovedPlayer, SessionSyncResult } from "./domain/roomContracts";
const VOTE_TIMER_MS = 30_000;
const MISSION_TIMER_MS = 30_000;
const SPEECH_TIMER_MS = 60_000;
const AI_NAMES = ["云", "清", "星", "北", "月", "青", "南", "林", "墨", "江", "松", "长"].flatMap(prefix =>
  ["舟", "岚", "河", "羽", "溪", "川", "影", "棠", "雪", "歌"].map(suffix => `${prefix}${suffix}`),
);

export interface Ack {
  ok: boolean;
  error?: string;
}

export interface RoomTimingOptions {
  revealDurationMs?: number;
  resultDurationMs?: number;
  proposalResultDurationMs?: number;
}

export interface RoomLimits {
  maxRooms?: number;
  offlineTtlMs?: number;
  resultTtlMs?: number;
  codeLength?: number;
}

type RandomSource = () => number;

function secureRandom(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

export class RoomManager {
  private rooms = new Map<string, RoomInternal>();
  private playerToRoom = new Map<string, string>();
  private storageFailed = false;
  private recovery = new RoomRecovery((room, timer, remainingMs) => this.resumeRecoveredRoom(room, timer, remainingMs));

  constructor(
    private readonly localUrls: string[],
    private onRoomChanged?: (roomCode: string) => void,
    private readonly timing: RoomTimingOptions = {},
    private readonly limits: RoomLimits = {},
    private readonly random: RandomSource = secureRandom,
  ) {}

  assertHealthy(): void {
    if (this.storageFailed) throw new GameError("STORAGE_UNAVAILABLE", "对局保存不可用，服务已暂停，请联系房主或管理员。");
  }

  halt(): void {
    this.storageFailed = true;
    this.close();
  }

  setRoomChangeListener(listener: ((roomCode: string) => void) | undefined): void {
    this.onRoomChanged = listener;
  }

  roomCodes(): string[] { return [...this.rooms.keys()]; }

  roomCodeOf(playerId: string): string | null { return this.playerToRoom.get(playerId) ?? null; }

  restoreRooms(snapshots: RoomSnapshot[], checkpointAt: number): string[] {
    if (this.rooms.size || snapshots.length > (this.limits.maxRooms ?? 200)) throw new Error("Invalid recovery state.");
    const expired: string[] = [];
    const now = Date.now();
    for (const snapshot of snapshots) {
      const offlineSince = snapshot.idleSince ?? checkpointAt;
      if (now - offlineSince >= (this.limits.offlineTtlMs ?? 600000) || (snapshot.completedAt !== null && now - snapshot.completedAt >= (this.limits.resultTtlMs ?? 1800000))) {
        expired.push(snapshot.code);
        continue;
      }
      if (snapshot.players.some(player => this.playerToRoom.has(player.id))) throw new Error("Duplicate recovered player.");
      const room = roomFromSnapshot(snapshot, this.localUrls);
      this.rooms.set(room.code, room);
      room.players.forEach(player => this.playerToRoom.set(player.id, room.code));
      this.recovery.begin(room, snapshot, Math.min(now, checkpointAt));
    }
    return expired;
  }

  private resumeRecoveredRoom(room: RoomInternal, timer: SavedTimer | null, remainingMs: number): void {
    if (this.rooms.get(room.code) !== room || this.storageFailed) return;
    if (room.phase === "lobby") {
      for (const player of [...room.players]) if (!player.connected && !player.isAI) this.removeLobbyPlayer(room, player.id);
    } else {
      if (timer) this.startPhaseTimer(room, timer.kind, timer.label, timer.durationMs, timer.speakerId, remainingMs);
      this.resolveOfflinePlayerActions(room);
    }
    this.notifyRoomChanged(room.code);
  }

  createRoom(name: string, targetPlayerCount = 5): JoinResult {
    this.assertHealthy();
    if (this.rooms.size >= (this.limits.maxRooms ?? 200)) throw new Error("当前房间已达上限，请稍后再试。");
    const normalizedTargetPlayerCount = this.normalizePlayerCount(targetPlayerCount);
    const code = this.uniqueRoomCode();
    const player = this.createPlayer(name, true, false, 0);
    const room: RoomInternal = {
      phaseId: `phase_${randomBytes(16).toString("hex")}`,
      revision: 0,
      instanceId: randomBytes(16).toString("hex"),
      code,
      hostId: player.id,
      targetPlayerCount: normalizedTargetPlayerCount,
      phase: "lobby",
      players: [player],
      leaderIndex: 0,
      questIndex: 0,
      rejectCount: 0,
      score: { success: 0, fail: 0 },
      proposal: [],
      votes: new Map(),
      missionVotes: new Map(),
      history: [],
      winner: null,
      winnerReason: "",
      localUrls: this.localUrls,
      timer: null,
      speechOrder: [],
      speechIndex: 0,
      speechNextLeaderIndex: null,
      idleSince: null,
      completedAt: null,
    };
    this.rooms.set(code, room);
    this.playerToRoom.set(player.id, code);
    return { roomCode: code, playerId: player.id, sessionToken: player.sessionToken };
  }

  joinRoom(code: string, name: string): JoinResult {
    const room = this.requireRoom(code);
    if (room.recovery) throw new GameError("ROOM_RECOVERING", "房间正在恢复连接，请稍候。");
    if (room.phase !== "lobby") throw new Error("游戏已经开始，不能加入。");
    if (room.players.length >= room.targetPlayerCount) throw new Error("房间人数已满。");
    const safeName = this.normalizePlayerName(name);
    if (room.players.some((player) => player.name.toLocaleLowerCase() === safeName.toLocaleLowerCase())) {
      throw new Error("房间内已有同名玩家。");
    }

    const player = this.createPlayer(safeName, false, false, room.players.length);
    room.players.push(player);
    room.idleSince = null;
    this.playerToRoom.set(player.id, room.code);
    return { roomCode: room.code, playerId: player.id, sessionToken: player.sessionToken };
  }

  addAIPlayers(code: string, hostId: string, token: string, count: number): void {
    const room = this.requireAuthedRoom(code, hostId, token);
    this.assertHost(room, hostId);
    if (room.phase !== "lobby") throw new Error("只能在大厅添加 AI。");
    if (!Number.isInteger(count) || count < 1) throw new Error("AI 数量无效。");
    if (room.players.length + count > room.targetPlayerCount) throw new Error("AI 数量会超过目标人数。");

    const names = new Set(room.players.map((player) => player.name.toLocaleLowerCase()));
    for (let i = 0; i < count; i += 1) {
      const availableNames = AI_NAMES.filter(name => !names.has(name.toLocaleLowerCase()));
      const name = availableNames[crypto.randomInt(availableNames.length)];
      names.add(name);
      const aiPlayer = this.createPlayer(name, false, true, room.players.length);
      room.players.push(aiPlayer);
      this.playerToRoom.set(aiPlayer.id, room.code);
    }
  }

  setTargetPlayerCount(code: string, hostId: string, token: string, targetPlayerCount: number): void {
    const room = this.requireAuthedRoom(code, hostId, token);
    this.assertHost(room, hostId);
    if (room.phase !== "lobby") throw new Error("只能在大厅调整人数。");
    const normalizedTargetPlayerCount = this.normalizePlayerCount(targetPlayerCount);
    if (normalizedTargetPlayerCount < room.players.length) throw new Error("目标人数不能少于当前玩家数。");
    room.targetPlayerCount = normalizedTargetPlayerCount;
  }

  setPlayerReady(code: string, playerId: string, token: string, ready: boolean): void {
    if (typeof ready !== "boolean") throw new Error("准备状态无效。");
    const room = this.requireAuthedRoom(code, playerId, token);
    if (room.phase !== "lobby") throw new Error("只能在大厅设置准备状态。");
    const player = this.requirePlayer(room, playerId);
    if (player.isHost) throw new Error("房主不需要准备。");
    player.ready = ready;
  }

  rejoinRoom(code: string, playerId: string, sessionToken: string): JoinResult {
    return this.syncPlayerSession(code, playerId, sessionToken).result;
  }

  validatePlayerSession(code: string, playerId: string, sessionToken: string): void {
    this.requireAuthedRoom(code, playerId, sessionToken);
  }

  syncPlayerSession(code: string, playerId: string, sessionToken: string): SessionSyncResult {
    const room = this.requireRoom(code);
    const player = this.requirePlayer(room, playerId);
    this.assertToken(player, sessionToken);
    const connectedChanged = !player.connected;
    player.connected = true;
    room.idleSince = null;
    this.recovery.reconnected(room);
    return {
      result: { roomCode: room.code, playerId: player.id, sessionToken: player.sessionToken },
      connectedChanged,
    };
  }

  disconnectPlayer(playerId: string): string | null {
    const roomCode = this.playerToRoom.get(playerId);
    if (!roomCode) return null;

    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const player = room.players.find((candidate) => candidate.id === playerId);
    if (player) {
      player.connected = false;
      this.trackIdleRoom(room);
      if (!room.recovery) this.resolveDisconnectedAction(room, player);
      return room.code;
    }
    return null;
  }

  leaveRoom(code: string, playerId: string, token: string): string | null {
    const room = this.requireAuthedRoom(code, playerId, token, true);
    const player = this.requirePlayer(room, playerId);

    if (room.phase !== "lobby") {
      player.connected = false;
      this.trackIdleRoom(room);
      if (room.phase === "assassin" && player.role === "assassin") {
        this.endGame(room, "good", "刺客已离开房间，放弃刺杀，正方获胜。", { kind: "assassinLeft" });
        return room.code;
      }
      if (room.recovery) {
        room.recovery.expectedPlayerIds = room.recovery.expectedPlayerIds.filter(id => id !== playerId);
        this.recovery.reconnected(room);
        return room.code;
      }
      this.resolveDisconnectedAction(room, player);
      return room.code;
    }

    if (room.recovery) room.recovery.expectedPlayerIds = room.recovery.expectedPlayerIds.filter(id => id !== playerId);
    const changedRoomCode = this.removeLobbyPlayer(room, playerId);
    this.recovery.reconnected(room);
    return changedRoomCode;
  }

  removeDisconnectedLobbyPlayer(playerId: string): string | null {
    const roomCode = this.playerToRoom.get(playerId);
    if (!roomCode) return null;

    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player || room.phase !== "lobby" || player.connected || room.recovery) return null;
    return this.removeLobbyPlayer(room, playerId);
  }

  getRoom(code: string): RoomInternal | null {
    return this.rooms.get(code.toUpperCase()) ?? null;
  }

  markChanged(code: string): void {
    const room = this.getRoom(code);
    if (room) room.revision += 1;
  }

  close(): void {
    for (const room of this.rooms.values()) {
      this.recovery.cancel(room);
      this.clearTimer(room);
      this.clearAISimulation(room);
    }
  }

  cleanupExpiredRooms(now = Date.now()): { code: string; playerIds: string[] }[] {
    if (this.storageFailed) return [];
    const expired: { code: string; playerIds: string[] }[] = [];
    for (const room of this.rooms.values()) {
      const offline = room.idleSince !== null && now - room.idleSince >= (this.limits.offlineTtlMs ?? 10 * 60_000);
      const completed = room.completedAt !== null && now - room.completedAt >= (this.limits.resultTtlMs ?? 30 * 60_000);
      if (!offline && !completed) continue;
      expired.push({ code: room.code, playerIds: room.players.map(player => player.id) });
      this.recovery.cancel(room);
      this.clearTimer(room);
      this.clearAISimulation(room);
      this.rooms.delete(room.code);
      for (const player of room.players) this.playerToRoom.delete(player.id);
    }
    return expired;
  }

  private trackIdleRoom(room: RoomInternal): void {
    if (!room.players.some(player => !player.isAI && player.connected)) room.idleSince ??= Date.now();
  }

  getPublicState(code: string): PublicRoomState {
    return publicRoomState(this.requireRoom(code));
  }

  getPrivateState(code: string, playerId: string): PrivatePlayerState {
    const room = this.requireRoom(code);
    return privatePlayerState(room, this.requirePlayer(room, playerId));
  }

  startRoom(code: string, playerId: string, token: string): void {
    const room = this.requireAuthedRoom(code, playerId, token);
    this.assertHost(room, playerId);
    if (room.phase !== "lobby") throw new Error("游戏已经开始。");
    assertPlayerCount(room.targetPlayerCount);
    if (room.players.length !== room.targetPlayerCount) throw new Error(`需要 ${room.targetPlayerCount} 名玩家才能开始。`);
    if (room.players.some((player) => !player.connected)) throw new Error("所有玩家在线后才能开始。");
    if (room.players.some((player) => !player.isHost && !player.ready)) throw new Error("所有队员准备后才能开始。");

    const roles = buildRoles(room.players.length, this.random);
    room.players.forEach((player, index) => {
      player.role = roles[index];
      player.servantVariant = player.role === "servant" ? crypto.randomInt(2) === 0 ? "male" : "female" : null;
    });
    this.resetGameProgress(room);
    room.leaderIndex = crypto.randomInt(room.players.length);
    room.phase = "reveal";
    this.startPhaseTimer(room, "reveal", "身份揭晓", this.timing.revealDurationMs ?? ROLE_REVEAL_DURATION_MS);
  }

  kickPlayer(code: string, hostId: string, token: string, targetId: string): RemovedPlayer {
    const room = this.requireAuthedRoom(code, hostId, token);
    this.assertHost(room, hostId);
    if (room.phase !== "lobby") throw new Error("只能在大厅踢人。");
    if (targetId === hostId) throw new Error("不能踢出房主。");

    const index = room.players.findIndex((player) => player.id === targetId);
    if (index < 0) throw new Error("玩家不存在。");
    const [removed] = room.players.splice(index, 1);
    this.playerToRoom.delete(removed.id);
    room.players.forEach((player, position) => {
      player.position = position;
    });
    return { id: removed.id, name: removed.name };
  }

  dissolveRoom(code: string, hostId: string, token: string): RemovedPlayer[] {
    const room = this.requireAuthedRoom(code, hostId, token, true);
    this.assertHost(room, hostId);
    const players = room.players.map((player) => ({ id: player.id, name: player.name }));
    this.recovery.cancel(room);
    room.players.forEach(player => this.playerToRoom.delete(player.id));
    this.clearTimer(room);
    this.clearAISimulation(room);
    this.rooms.delete(room.code);
    return players;
  }

  restartRoom(code: string, playerId: string, token: string): void {
    const room = this.requireAuthedRoom(code, playerId, token);
    this.assertHost(room, playerId);
    this.clearTimer(room);
    this.clearAISimulation(room);
    room.phase = "lobby";
    room.phaseId = `phase_${randomBytes(16).toString("hex")}`;
    room.players.forEach((player, position) => {
      player.position = position;
      player.role = null;
      player.servantVariant = null;
      player.ready = player.isAI;
    });
    this.resetGameProgress(room);
  }

  private resetGameProgress(room: RoomInternal): void {
    room.leaderIndex = 0;
    room.questIndex = 0;
    room.rejectCount = 0;
    room.score = { success: 0, fail: 0 };
    room.proposal = [];
    room.votes.clear();
    room.missionVotes.clear();
    room.history = [];
    room.winner = null;
    room.winnerReason = "";
    room.winnerDetails = undefined;
    room.completedAt = null;
    room.speechOrder = [];
    room.speechIndex = 0;
    room.speechNextLeaderIndex = null;
  }

  proposeTeam(code: string, playerId: string, token: string, team: string[], questIndex?: number): void {
    const room = this.requireAuthedRoom(code, playerId, token);
    if (room.phase !== "team") throw new Error("当前不是组队阶段。");
    if (room.players[room.leaderIndex]?.id !== playerId) throw new Error("只有当前领队可以提交队伍。");
    const selectedQuestIndex = resolveQuestIndex({
      requestedIndex: questIndex,
      currentIndex: room.questIndex,
      playerCount: room.players.length,
      history: room.history,
    });
    const expectedSize = getTeamSize(room.players.length, selectedQuestIndex);
    const unique = [...new Set(team)];
    if (unique.length !== expectedSize) throw new Error(`本轮需要选择 ${expectedSize} 名队员。`);
    unique.forEach((id) => {
      const candidate = this.requirePlayer(room, id);
      if (!candidate.connected) throw new Error("不能选择已断线玩家。");
    });

    room.questIndex = selectedQuestIndex;
    room.proposal = unique;
    room.votes.clear();
    if (isForcedLaunch(room.rejectCount, room.players.length)) {
      room.history.push(forcedProposalHistory({ questIndex: room.questIndex, leaderId: playerId, team: room.proposal }));
      this.startMission(room);
      return;
    }
    room.phase = "vote";
    room.votes.set(playerId, true);
    this.startPhaseTimer(room, "vote", "车队投票", VOTE_TIMER_MS);
    this.resolveOfflinePlayerActions(room);
  }

  submitVote(code: string, playerId: string, token: string, approved: boolean): void {
    if (typeof approved !== "boolean") throw new Error("投票选项无效。");
    const room = this.requireAuthedRoom(code, playerId, token);
    if (room.phase !== "vote") throw new Error("当前不是公投阶段。");
    if (room.players[room.leaderIndex]?.id === playerId) throw new Error("队长已自动投赞成票，不能修改。");
    if (room.votes.has(playerId)) throw new Error("你已经投过票。");

    room.votes.set(playerId, approved);
    this.resolveVoteIfComplete(room);
  }

  private resolveVoteIfComplete(room: RoomInternal): void {
    const leaderId = room.players[room.leaderIndex]?.id;
    const decision = evaluateProposalVote({
      playerCount: room.players.length,
      questIndex: room.questIndex,
      leaderId,
      team: room.proposal,
      votes: room.votes,
    });
    if (!decision) return;

    if (decision.accepted) {
      room.history.push(decision.history);
      this.startMission(room);
      return;
    }

    this.rejectProposal(room, decision);
  }

  private startMission(room: RoomInternal): void {
    room.missionVotes.clear();
    room.phase = "mission";
    this.startPhaseTimer(room, "mission", "任务投票", MISSION_TIMER_MS);
    this.resolveOfflinePlayerActions(room);
  }

  private rejectProposal(room: RoomInternal, decision: ProposalVoteDecision): void {
    room.history.push(decision.history);
    room.rejectCount += 1;
    room.proposal = [];
    room.votes.clear();
    this.clearTimer(room);
    this.clearAISimulation(room);
    room.phase = "proposalResult";
    this.startPhaseTimer(room, "proposalResult", "发车结果", this.timing.proposalResultDurationMs ?? PROPOSAL_REJECTION_DURATION_MS);
  }

  submitMission(code: string, playerId: string, token: string, failed: boolean): void {
    if (typeof failed !== "boolean") throw new Error("任务选项无效。");
    const room = this.requireAuthedRoom(code, playerId, token);
    const player = this.requirePlayer(room, playerId);
    if (room.phase !== "mission") throw new Error("当前不是任务阶段。");
    if (!room.proposal.includes(playerId)) throw new Error("只有任务队员可以提交任务牌。");
    if (room.missionVotes.has(playerId)) throw new Error("你已经提交过任务牌。");
    if (failed && (!player.role || ROLE_DEFS[player.role].side !== "evil")) throw new Error("正方玩家不能提交失败牌。");

    room.missionVotes.set(playerId, failed);
    this.resolveMissionIfComplete(room);
  }

  private resolveMissionIfComplete(room: RoomInternal): void {
    const leaderId = room.players[room.leaderIndex]?.id;
    const decision = evaluateMission({
      playerCount: room.players.length,
      questIndex: room.questIndex,
      leaderId,
      team: room.proposal,
      missionVotes: room.missionVotes,
    });
    if (!decision) return;

    if (decision.questFailed) room.score.fail += 1;
    else room.score.success += 1;
    room.history.push(decision.history);

    room.proposal = [];
    room.votes.clear();
    room.missionVotes.clear();
    this.clearTimer(room);
    room.rejectCount = 0;
    room.phase = "missionResult";
    this.startPhaseTimer(room, "missionResult", "任务结果", this.timing.resultDurationMs ?? MISSION_RESULT_DURATION_MS);
  }

  chooseAssassinTarget(code: string, playerId: string, token: string, targetId: string): void {
    const room = this.requireAuthedRoom(code, playerId, token);
    const assassin = this.requirePlayer(room, playerId);
    const target = this.requirePlayer(room, targetId);
    if (room.phase !== "assassin") throw new Error("当前不是刺客阶段。");
    if (assassin.role !== "assassin") throw new Error("只有刺客可以选择目标。");
    if (targetId === playerId) throw new Error("刺客不能选择自己。");
    if (target.role && ROLE_DEFS[target.role].side === "evil") throw new Error("不能刺杀已亮明身份的藏锋者。");
    if (target.role === "merlin") {
      this.endGame(room, "evil", `刺客命中 ${target.name}，梅林阵亡。`, { kind: "assassinHit", targetPlayerId: target.id });
    } else {
      this.endGame(room, "good", `刺客选择了 ${target.name}，梅林安全。`, { kind: "assassinMiss", targetPlayerId: target.id });
    }
  }

  private createPlayer(name: string, isHost: boolean, isAI: boolean, position: number): PlayerInternal {
    const safeName = this.normalizePlayerName(name);
    return {
      id: randomId("p"),
      sessionToken: randomId("s"),
      name: safeName,
      isHost,
      isAI,
      connected: true,
      position,
      ready: isAI,
      role: null,
      servantVariant: null,
    };
  }

  private normalizePlayerName(name: string): string {
    const safeName = name.trim().slice(0, 16);
    if (!safeName) throw new Error("请输入你的名字。");
    return safeName;
  }

  private removeLobbyPlayer(room: RoomInternal, playerId: string): string | null {
    const index = room.players.findIndex((candidate) => candidate.id === playerId);
    if (index < 0) return room.code;
    room.players.splice(index, 1);
    this.playerToRoom.delete(playerId);

    // AI seats cannot host, so a lobby without any human player is closed.
    if (!room.players.some((candidate) => !candidate.isAI)) {
      this.recovery.cancel(room);
      this.clearTimer(room);
      this.clearAISimulation(room);
      this.rooms.delete(room.code);
      room.players.forEach((candidate) => this.playerToRoom.delete(candidate.id));
      return null;
    }

    if (room.hostId === playerId) {
      const clockwise = room.players.map((_, offset) => room.players[(index + offset) % room.players.length]);
      const nextHost = clockwise.find((candidate) => !candidate.isAI)!;
      nextHost.isHost = true;
      room.hostId = nextHost.id;
    }
    room.players.forEach((candidate, position) => {
      candidate.position = position;
    });
    this.trackIdleRoom(room);
    return room.code;
  }

  private requireRoom(code: string): RoomInternal {
    this.assertHealthy();
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new GameError("ROOM_NOT_FOUND", "房间不存在。");
    return room;
  }

  private requirePlayer(room: RoomInternal, playerId: string): PlayerInternal {
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new GameError("PLAYER_NOT_FOUND", "玩家不存在。");
    return player;
  }

  private requireAuthedRoom(code: string, playerId: string, token: string, allowRecovery = false): RoomInternal {
    const room = this.requireRoom(code);
    const player = this.requirePlayer(room, playerId);
    this.assertToken(player, token);
    if (room.recovery && !allowRecovery) throw new GameError("ROOM_RECOVERING", "对局正在恢复连接，请稍候。");
    return room;
  }

  private assertToken(player: PlayerInternal, token: string): void {
    if (player.sessionToken !== token) throw new GameError("SESSION_INVALID", "会话已失效，请重新加入。");
  }

  private assertHost(room: RoomInternal, playerId: string): void {
    if (room.hostId !== playerId) throw new GameError("NOT_AUTHORIZED", "只有房主可以执行此操作。");
  }

  private normalizePlayerCount(count: number): number {
    const normalized = Number(count);
    if (!Number.isInteger(normalized)) throw new Error("阿瓦隆需要 5 到 10 名玩家。");
    assertPlayerCount(normalized);
    return normalized;
  }

  private advanceLeader(room: RoomInternal): void {
    room.leaderIndex = findNextLeaderIndex(room.players, room.leaderIndex);
  }

  private endGame(room: RoomInternal, winner: Winner, reason: string, details: WinnerDetails): void {
    this.recovery.cancel(room);
    this.clearTimer(room);
    this.clearAISimulation(room);
    room.winner = winner;
    room.winnerReason = reason;
    room.winnerDetails = details;
    room.phase = "result";
    room.phaseId = `phase_${randomBytes(16).toString("hex")}`;
    room.completedAt = Date.now();
  }

  private startPhaseTimer(room: RoomInternal, kind: RoomTimerInternal["kind"], label: string, durationMs: number, speakerId?: string, remainingMs = durationMs): void {
    this.clearTimer(room);
    room.phaseId = `phase_${randomBytes(16).toString("hex")}`;
    const deadline = Date.now() + Math.max(0, remainingMs);
    const timeout = setTimeout(() => {
      this.handleTimerExpired(room.code, kind, deadline);
    }, Math.max(0, remainingMs));
    timeout.unref?.();

    room.timer = {
      kind,
      label,
      deadline,
      durationMs,
      speakerId,
      timeout,
    };
  }

  private clearTimer(room: RoomInternal): void {
    if (!room.timer) return;
    clearTimeout(room.timer.timeout);
    room.timer = null;
  }

  private handleTimerExpired(code: string, kind: TimerKind, deadline: number): void {
    const room = this.getRoom(code);
    if (!room || room.timer?.kind !== kind || room.timer.deadline !== deadline) return;

    if (kind === "reveal" && room.phase === "reveal") {
      this.startTeamPhase(room);
      this.notifyRoomChanged(room.code);
      return;
    }
    if (kind === "team" && room.phase === "team") {
      this.advanceLeader(room);
      this.startTeamPhase(room);
      this.notifyRoomChanged(room.code);
      return;
    }
    if (kind === "proposalResult" && room.phase === "proposalResult") {
      this.advanceLeader(room);
      this.startTeamPhase(room);
      this.notifyRoomChanged(room.code);
      return;
    }
    if (kind === "missionResult" && room.phase === "missionResult") {
      if (room.score.fail >= 3) {
        this.endGame(room, "evil", "三个任务失败，反方获胜。", { kind: "missionFailure" });
      } else if (room.score.success >= 3) {
        this.clearAISimulation(room);
        room.phase = "assassin";
        this.startPhaseTimer(room, "assassin", "藏锋者讨论与刺杀", ASSASSINATION_DURATION_MS);
      } else {
        this.startSpeechPhase(room, findNextLeaderIndex(room.players, room.leaderIndex));
      }
      this.notifyRoomChanged(room.code);
      return;
    }

    if (kind === "vote" && room.phase === "vote") {
      const leaderId = room.players[room.leaderIndex]?.id;
      for (const player of room.players) {
        if (player.id === leaderId || room.votes.has(player.id)) continue;
        room.votes.set(player.id, true);
      }
      this.resolveVoteIfComplete(room);
      this.notifyRoomChanged(room.code);
      return;
    }

    if (kind === "mission" && room.phase === "mission") {
      for (const playerId of room.proposal) {
        if (!room.missionVotes.has(playerId)) room.missionVotes.set(playerId, false);
      }
      this.resolveMissionIfComplete(room);
      this.notifyRoomChanged(room.code);
      return;
    }

    if (kind === "speech" && room.phase === "speech") {
      this.advanceSpeech(room);
      this.notifyRoomChanged(room.code);
      return;
    }

    if (kind === "assassin" && room.phase === "assassin") {
      const assassin = room.players.find(player => player.role === "assassin" && player.isAI && player.connected);
      const targets = room.players.filter(player => player.role && ROLE_DEFS[player.role].side === "good");
      if (assassin && targets.length) {
        const target = targets[crypto.randomInt(targets.length)];
        this.chooseAssassinTarget(code, assassin.id, assassin.sessionToken, target.id);
      } else {
        this.endGame(room, "good", "刺客未在规定时间内选择目标，正方获胜。", { kind: "assassinTimeout" });
      }
      this.notifyRoomChanged(room.code);
    }
  }

  private startSpeechPhase(room: RoomInternal, nextLeaderIndex: number): void {
    this.clearAISimulation(room);
    room.leaderIndex = nextLeaderIndex;
    room.speechOrder = buildSpeechOrder(room.players, nextLeaderIndex);

    room.speechIndex = 0;
    room.speechNextLeaderIndex = nextLeaderIndex;
    room.phase = "speech";
    if (room.speechOrder.length === 0) {
      this.startPhaseTimer(room, "speech", "讨论时间", 3_000);
      return;
    }
    this.startCurrentSpeechTimer(room);
  }

  private startCurrentSpeechTimer(room: RoomInternal): void {
    this.clearAISimulation(room);
    const speakerId = room.speechOrder[room.speechIndex];
    if (!speakerId) {
      this.finishSpeechPhase(room);
      return;
    }
    const speakerName = room.players.find((player) => player.id === speakerId)?.name ?? "玩家";
    this.startPhaseTimer(room, "speech", `${speakerName} 发言`, SPEECH_TIMER_MS, speakerId);
  }

  private advanceSpeech(room: RoomInternal): void {
    room.speechIndex += 1;
    if (room.speechIndex >= room.speechOrder.length) {
      this.finishSpeechPhase(room);
      return;
    }
    this.startCurrentSpeechTimer(room);
  }

  endSpeech(code: string, playerId: string, token: string): void {
    const room = this.requireAuthedRoom(code, playerId, token);
    if (room.phase !== "speech") throw new Error("当前不在发言阶段。");
    const currentSpeakerId = room.speechOrder[room.speechIndex];
    if (currentSpeakerId !== playerId) throw new Error("现在不是你的发言时间。");
    this.advanceSpeech(room);
  }

  private finishSpeechPhase(room: RoomInternal): void {
    this.clearTimer(room);
    this.clearAISimulation(room);
    if (room.speechNextLeaderIndex !== null) {
      const nextLeader = room.players[room.speechNextLeaderIndex];
      room.leaderIndex = nextLeader?.connected ? room.speechNextLeaderIndex : findNextLeaderIndex(room.players, room.speechNextLeaderIndex);
    }
    room.speechOrder = [];
    room.speechIndex = 0;
    room.speechNextLeaderIndex = null;
    if (room.history.at(-1)?.type === "mission") room.questIndex = nextOpenQuestIndex(room.history, room.questIndex);
    this.startTeamPhase(room);
  }

  private startTeamPhase(room: RoomInternal): void {
    this.clearAISimulation(room);
    room.phase = "team";
    this.startPhaseTimer(room, "team", "队长组队", TEAM_SELECTION_DURATION_MS);
    this.resolveOfflinePlayerActions(room);
  }

  private resolveOfflinePlayerActions(room: RoomInternal): void {
    // Players may have disconnected before this phase started.
    for (const player of room.players.filter((candidate) => !candidate.connected)) {
      this.resolveDisconnectedAction(room, player);
    }
  }

  private resolveDisconnectedAction(room: RoomInternal, player: PlayerInternal): void {
    if (room.phase === "team" && room.players[room.leaderIndex]?.id === player.id) {
      room.proposal = [];
      room.votes.clear();
      this.advanceLeader(room);
      this.startPhaseTimer(room, "team", "队长组队", TEAM_SELECTION_DURATION_MS);
      return;
    }

    if (room.phase === "vote" && !room.votes.has(player.id)) {
      if (room.players[room.leaderIndex]?.id !== player.id) room.votes.set(player.id, true);
      this.resolveVoteIfComplete(room);
      return;
    }

    if (room.phase === "mission" && room.proposal.includes(player.id) && !room.missionVotes.has(player.id)) {
      room.missionVotes.set(player.id, false);
      this.resolveMissionIfComplete(room);
      return;
    }

    if (room.phase === "speech") {
      const currentSpeakerId = room.speechOrder[room.speechIndex];
      const removedIndex = room.speechOrder.indexOf(player.id);
      room.speechOrder = room.speechOrder.filter((playerId) => playerId !== player.id);
      if (removedIndex >= 0 && removedIndex < room.speechIndex) room.speechIndex -= 1;
      if (currentSpeakerId === player.id) {
        this.startCurrentSpeechTimer(room);
      } else if (room.speechIndex >= room.speechOrder.length) {
        this.finishSpeechPhase(room);
      }
    }
  }

  private notifyRoomChanged(code: string): void {
    this.markChanged(code);
    try { this.onRoomChanged?.(code); }
    catch (error) { if (!this.storageFailed) throw error; }
    this.simulateAI(code);
  }

  private clearAISimulation(room: RoomInternal): void {
    clearRoomAI(room);
  }

  simulateAI(code: string): void {
    if (this.storageFailed || this.getRoom(code)?.recovery) return;
    scheduleRoomAI(code, {
      random: this.random,
      getRoom: value => this.getRoom(value),
      proposeTeam: (...args) => this.proposeTeam(...args),
      submitVote: (...args) => this.submitVote(...args),
      submitMission: (...args) => this.submitMission(...args),
      endSpeech: (...args) => this.endSpeech(...args),
      notifyRoomChanged: value => this.notifyRoomChanged(value),
    });
  }

  private uniqueRoomCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomBytes(4).toString("hex").slice(0, this.limits.codeLength ?? 5).toUpperCase();
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("无法创建房间，请重试。");
  }

}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}
