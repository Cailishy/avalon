import http from "node:http";
import crypto from "node:crypto";
import { Server } from "socket.io";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivatePlayerState, PublicRoomState } from "../shared/game";
import { attachSocketHandlers, type SocketRuntime } from "./socketHandlers";
import { commandPayload } from "../../tests/helpers/commands";

type Ack = { ok: boolean; error?: string; roomCode?: string; playerId?: string; sessionToken?: string };
type Auth = { roomCode: string; playerId: string; sessionToken: string };

let httpServer: http.Server;
let ioServer: Server;
let runtime: SocketRuntime;
let serverUrl: string;
let clients: ClientSocket[] = [];

beforeEach(async () => {
  vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
  httpServer = http.createServer();
  ioServer = new Server(httpServer, { cors: { origin: true } });
  runtime = attachSocketHandlers(ioServer, ["http://localhost:0"], { lobbyDisconnectGraceMs: 100, timing: { revealDurationMs: 20, resultDurationMs: 30, proposalResultDurationMs: 100 } });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
  serverUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const client of clients) {
    client.disconnect();
  }
  clients = [];
  await runtime.close();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => {
    ioServer.close(() => resolve());
  });
});

describe("Socket lobby state synchronization", () => {
  it("requires the new command envelope and exposes a read-only clock sample", async () => {
    const client = await connectClient();
    expect(await client.timeout(1000).emitWithAck("room:create", { name: "Legacy" })).toMatchObject({ ok: false, code: "PROTOCOL_MISMATCH" });
    expect(runtime.rooms.roomCodes()).toEqual([]);
    const time = await client.timeout(1000).emitWithAck("clock:sync", {});
    expect(time).toMatchObject({ ok: true, protocolVersion: 2 });
    expect(time.serverSentAt).toBeGreaterThanOrEqual(time.serverReceivedAt);
  });

  it("replays room creation and rejects reuse of its request id for a different intent", async () => {
    const client = await connectClient();
    const payload = commandPayload("room:create", { name: "Host" });
    const first = await client.timeout(1000).emitWithAck("room:create", payload);
    expect(first.ok).toBe(true);
    expect(await client.timeout(1000).emitWithAck("room:create", payload)).toEqual(first);
    expect(runtime.rooms.roomCodes()).toEqual([first.roomCode]);
    expect(await client.timeout(1000).emitWithAck("room:create", { ...payload, name: "Different" })).toMatchObject({ ok: false, code: "REQUEST_CONFLICT" });
    expect(runtime.rooms.roomCodes()).toHaveLength(1);
  });

  it("only returns command receipts to their owner without executing a mutation", async () => {
    const client = await connectClient();
    const other = await connectClient();
    const creation = commandPayload("room:create", { name: "Host" });
    const auth = authFrom(await client.timeout(1000).emitWithAck("room:create", creation));
    const entryQuery = { event: "room:create", requestId: creation.requestId };
    expect(await client.timeout(1000).emitWithAck("command:status", entryQuery)).toMatchObject({ ok: true, result: { ok: true, ...auth } });
    expect(await other.timeout(1000).emitWithAck("command:status", entryQuery)).toEqual({ ok: true, result: null });
    const leave = commandPayload("room:leave", auth);
    expect(await client.timeout(1000).emitWithAck("room:leave", leave)).toEqual({ ok: true });
    const query = { event: "room:leave", requestId: leave.requestId, sessionToken: auth.sessionToken };
    expect(await client.timeout(1000).emitWithAck("command:status", query)).toEqual({ ok: true, result: { ok: true } });
    expect(await other.timeout(1000).emitWithAck("command:status", { ...query, sessionToken: `s_${"f".repeat(24)}` })).toEqual({ ok: true, result: null });
    expect(await client.timeout(1000).emitWithAck("command:status", { ...query, event: "room:dissolve" })).toEqual({ ok: true, result: null });
    expect(runtime.rooms.roomCodes()).toEqual([]);
  });

  it("does not replay an old vote into a later voting phase, even when the original receipt is successful", async () => {
    const { sockets, auths, roomCode, trackers } = await createStartedClients();
    const first = runtime.rooms.getPublicState(roomCode);
    const leader = auths.findIndex(auth => auth.playerId === first.leaderId);
    const voter = auths.length - 1;
    const team = auths.slice(0, 2).map(auth => auth.playerId);
    await emitAck(sockets[leader], "team:propose", { ...auths[leader], team });
    const old = commandPayload("vote:submit", { ...auths[voter], approved: true }, runtime.rooms.getPublicState(roomCode).phaseId);
    expect((await sockets[voter].timeout(1000).emitWithAck("vote:submit", old)).ok).toBe(true);
    for (let index = 0; index < sockets.length; index++) if (![leader, voter].includes(index)) await emitAck(sockets[index], "vote:submit", { ...auths[index], approved: true });
    for (let index = 0; index < 2; index++) await emitAck(sockets[index], "mission:submit", { ...auths[index], failed: false });
    await trackers[0].waitFor(state => state.phase === "speech");
    for (let index = 0; index < auths.length; index++) {
      const speaker = auths.findIndex(auth => auth.playerId === runtime.rooms.getPublicState(roomCode).timer?.speakerId);
      await emitAck(sockets[speaker], "speech:end", auths[speaker]);
    }
    const next = runtime.rooms.getPublicState(roomCode);
    const nextLeader = auths.findIndex(auth => auth.playerId === next.leaderId);
    await emitAck(sockets[nextLeader], "team:propose", { ...auths[nextLeader], team });
    expect(runtime.rooms.getPublicState(roomCode).phaseId).not.toBe(old.phaseId);
    const before = runtime.rooms.getPublicState(roomCode).voteSubmitted;
    expect(await sockets[voter].timeout(1000).emitWithAck("vote:submit", { ...old, requestId: `r_${"f".repeat(32)}` })).toMatchObject({ ok: false, code: "STALE_PHASE" });
    expect(await sockets[voter].timeout(1000).emitWithAck("vote:submit", old)).toEqual({ ok: true });
    expect(runtime.rooms.getPublicState(roomCode).voteSubmitted).toEqual(before);
  });

  it("replays a successful leave after unbinding and refuses expired or future-dated commands", async () => {
    const client = await connectClient();
    const creation = commandPayload("room:create", { name: "Host" });
    expect(await client.timeout(1000).emitWithAck("room:create", { ...creation, issuedAt: Date.now() - 601000 })).toMatchObject({ ok: false, code: "REQUEST_EXPIRED" });
    expect(await client.timeout(1000).emitWithAck("room:create", { ...creation, issuedAt: Date.now() + 31000 })).toMatchObject({ ok: false, code: "REQUEST_EXPIRED" });
    const auth = authFrom(await client.timeout(1000).emitWithAck("room:create", creation));
    const leave = commandPayload("room:leave", auth);
    expect(await client.timeout(1000).emitWithAck("room:leave", leave)).toEqual({ ok: true });
    expect(await client.timeout(1000).emitWithAck("room:leave", leave)).toEqual({ ok: true });
    expect(runtime.rooms.getRoom(auth.roomCode)).toBeNull();
  });

  it("rejects inherited and unknown event names and keeps the connection usable", async () => {
    const client = await connectClient();
    for (const event of ["__proto__", "constructor", "toString", "hasOwnProperty", "unknown:event"]) {
      expect(await emitAck(client, event, {})).toMatchObject({ ok: false, error: "请求格式不正确。" });
    }
    expect((await emitAck(client, "room:create", { name: "StillConnected" })).ok).toBe(true);
  });
  it("rejects malformed payloads, duplicate room entry and unaffiliated mutation before changing state", async () => {
    const host = await connectClient();
    const auth = authFrom(await emitAck(host, "room:create", { name: "Host" }));
    const other = await connectClient();
    const guest = authFrom(await emitAck(other, "room:join", { roomCode: auth.roomCode, name: "Guest" }));
    const before = runtime.rooms.getPublicState(auth.roomCode);
    expect(await emitAck(other, "player:setReady", { ...guest, ready: "false" })).toMatchObject({ ok: false, error: "请求格式不正确。" });
    expect(await emitAck(other, "room:create", { name: "Duplicate" })).toMatchObject({ ok: false, error: "请先离开当前房间。" });
    expect(await emitAck(other, "room:dissolve", auth)).toMatchObject({ ok: false, error: "请先恢复当前玩家会话。" });
    expect(runtime.rooms.getPublicState(auth.roomCode)).toEqual(before);
  });

  it("limits sync bursts without disconnecting an otherwise valid player", async () => {
    const host = await connectClient();
    const auth = authFrom(await emitAck(host, "room:create", { name: "Host" }));
    const responses = [];
    for (let i = 0; i < 8; i++) responses.push(await emitAck(host, "room:sync", auth));
    expect(responses.some(response => !response.ok && response.error?.includes("频繁"))).toBe(true);
    expect(host.connected).toBe(true);
    expect(runtime.rooms.getPublicState(auth.roomCode).players).toHaveLength(1);
  });

  it("reports unavailable voice without issuing a token when the media backend is not configured", async () => {
    const host = await connectClient();
    const auth = authFrom(await emitAck(host, "room:create", { name: "Host" }));
    expect(await emitAck(host, "voice:join", auth)).toMatchObject({ ok: false, error: "语音服务尚未配置。" });
  });

  it("caps concurrent rooms created from the same source", async () => {
    for (let i = 0; i < 5; i++) {
      const client = await connectClient();
      expect((await emitAck(client, "room:create", { name: `Host${i}` })).ok).toBe(true);
    }
    const client = await connectClient();
    expect(await emitAck(client, "room:create", { name: "Extra" })).toMatchObject({ ok: false, error: "当前来源的活跃房间已达上限。" });
  });
  it.each(["male", "female"] as const)("broadcasts a non-host first leader but keeps %s servant art private", async variant => {
    vi.mocked(crypto.randomInt).mockImplementation(max => max === 2 ? variant === "female" ? 1 : 0 : max - 1);
    const { sockets, auths, roomCode } = await createStartedClients(7);
    const publicState = runtime.rooms.getPublicState(roomCode);
    expect(publicState.leaderId).toBe(auths[6].playerId);
    expect(publicState.players.every(player => !("servantVariant" in player))).toBe(true);
    const states = await Promise.all(sockets.map(async (socket, index) => {
      const nextPrivate = new Promise<PrivatePlayerState>(resolve => socket.once("player:privateState", resolve));
      expect((await emitAck(socket, "room:sync", auths[index])).ok).toBe(true);
      return nextPrivate;
    }));
    for (const [index, privateState] of states.entries()) {
      expect(privateState.playerId).toBe(auths[index].playerId);
      expect(privateState.canPropose).toBe(index === 6);
      expect(privateState.role).not.toBe("minion");
      expect(privateState.servantVariant).toBe(privateState.role === "servant" ? variant : null);
    }
    const servantCount = states.filter(state => state.role === "servant").length;
    expect(runtime.rooms.getPublicState(roomCode).servantCounts).toEqual({ male: variant === "male" ? servantCount : 0, female: variant === "female" ? servantCount : 0 });
  });

  it("starts an AI proposal when the randomly selected first leader is an AI", async () => {
    const host = await connectClient();
    const states = trackRoomStates(host);
    const auth = authFrom(await emitAck(host, "room:create", { name: "Host", targetPlayerCount: 5 }));
    expect((await emitAck(host, "room:addAI", { ...auth, count: 4 })).ok).toBe(true);
    vi.mocked(crypto.randomInt).mockImplementation(max => max === 5 ? 2 : 0);
    expect((await emitAck(host, "room:start", auth)).ok).toBe(true);
    const vote = await states.waitFor(state => state.phase === "vote", 3000);
    expect(vote.leaderId).toBe(vote.players[2].id);
    expect(vote.leaderId).not.toBe(auth.playerId);
    expect(runtime.rooms.getPrivateState(auth.roomCode, auth.playerId).canVote).toBe(true);
  });

  it("broadcasts mission presentation and speech to all players for a chosen quest", async () => {
    const { sockets, auths, roomCode, trackers } = await createStartedClients();
    const state = runtime.rooms.getPublicState(roomCode);
    const leaderIndex = auths.findIndex(a => a.playerId === state.leaderId);
    const team = auths.slice(0, 2).map(a => a.playerId);
    expect((await emitAck(sockets[leaderIndex], "team:propose", { ...auths[leaderIndex], questIndex: 1, team })).ok).toBe(true);
    for (const [index, auth] of auths.entries()) {
      if (index !== leaderIndex) expect((await emitAck(sockets[index], "vote:submit", { ...auth, approved: true })).ok).toBe(true);
    }
    const resultStates = trackers.map(t => t.waitFor(s => s.phase === "missionResult"));
    for (const [index, auth] of auths.entries()) {
      if (team.includes(auth.playerId)) expect((await emitAck(sockets[index], "mission:submit", { ...auth, failed: false })).ok).toBe(true);
    }
    for (const result of await Promise.all(resultStates)) {
      expect(result.history.at(-1)).toMatchObject({ type: "mission", quest: 2, team, result: "success", fails: 0 });
      expect(result.revealedRoles).toEqual([]);
      expect(result.proposal).toEqual([]);
      expect(result.timer?.kind).toBe("missionResult");
    }
    for (const speech of await Promise.all(trackers.map(t => t.waitFor(s => s.phase === "speech")))) {
      expect(speech.timer?.speakerId).toBeTruthy();
      expect(speech.timer?.durationMs).toBe(60_000);
    }
  });
  it.each([5, 7])("broadcasts a forced player-count launch to all %i clients", async (count) => {
    const { sockets, auths, roomCode } = await createStartedClients(count);
    const tracked = sockets.map(trackRoomStates);
    for (let attempt = 1; attempt < count; attempt++) {
      const state = runtime.rooms.getPublicState(roomCode);
      const leaderIndex = auths.findIndex(auth => auth.playerId === state.leaderId);
      expect((await emitAck(sockets[leaderIndex], "team:propose", { ...auths[leaderIndex], team: auths.slice(0, state.teamSize).map(a => a.playerId) })).ok).toBe(true);
      for (let index = 0; index < sockets.length; index++) {
        if (index !== leaderIndex) expect((await emitAck(sockets[index], "vote:submit", { ...auths[index], approved: false })).ok).toBe(true);
      }
      expect(runtime.rooms.getPublicState(roomCode)).toMatchObject({ phase: "proposalResult", rejectCount: attempt, winner: null });
      await tracked[0].waitFor(s => s.phase === "team" && s.rejectCount === attempt);
    }
    const state = runtime.rooms.getPublicState(roomCode);
    const leaderIndex = auths.findIndex(a => a.playerId === state.leaderId);
    const updates = tracked.map(t => t.waitFor(s => s.phase === "mission" && s.history.at(-1)?.forced === true));
    expect((await emitAck(sockets[leaderIndex], "team:propose", { ...auths[leaderIndex], team: auths.slice(0, state.teamSize).map(a => a.playerId) })).ok).toBe(true);
    for (const update of await Promise.all(updates)) {
      expect(update).toMatchObject({ phase: "mission", winner: null, rejectCount: count - 1, voteSubmitted: [] });
      expect(update.history.at(-1)).toMatchObject({ forced: true, approvals: 0, rejections: 0, result: "success" });
    }
    const voterIndex = (leaderIndex + 1) % sockets.length;
    expect((await emitAck(sockets[voterIndex], "vote:submit", { ...auths[voterIndex], approved: false })).ok).toBe(false);
    expect((await emitAck(sockets[0], "mission:submit", { ...auths[0], failed: false })).ok).toBe(true);
    expect(runtime.rooms.getPublicState(roomCode).missionSubmitted).toContain(auths[0].playerId);
  });

  it("broadcasts join, ready changes, and explicit leave to every remaining lobby client", async () => {
    const host = await connectClient();
    const player = await connectClient();
    const hostStates = trackRoomStates(host);
    const playerStates = trackRoomStates(player);

    const hostAck = await emitAck(host, "room:create", { name: "Host", targetPlayerCount: 5 });
    expect(hostAck.ok).toBe(true);
    const hostAuth = authFrom(hostAck);
    await hostStates.waitFor((state) => state.players.length === 1 && state.players[0]?.id === hostAuth.playerId);

    const joinAck = await emitAck(player, "room:join", { roomCode: hostAuth.roomCode, name: "P2" });
    expect(joinAck.ok).toBe(true);
    const playerAuth = authFrom(joinAck);
    const joined = (state: PublicRoomState) => state.players.some((candidate) => candidate.id === playerAuth.playerId);
    await Promise.all([hostStates.waitFor(joined), playerStates.waitFor(joined)]);

    const readyAck = await emitAck(player, "player:setReady", { ...playerAuth, ready: true });
    expect(readyAck.ok).toBe(true);
    const ready = (state: PublicRoomState) => state.players.some((candidate) => candidate.id === playerAuth.playerId && candidate.ready);
    await Promise.all([hostStates.waitFor(ready), playerStates.waitFor(ready)]);

    const cancelReadyAck = await emitAck(player, "player:setReady", { ...playerAuth, ready: false });
    expect(cancelReadyAck.ok).toBe(true);
    const notReady = (state: PublicRoomState) => state.players.some((candidate) => candidate.id === playerAuth.playerId && !candidate.ready);
    await Promise.all([hostStates.waitFor(notReady), playerStates.waitFor(notReady)]);

    const leaveAck = await emitAck(player, "room:leave", playerAuth);
    expect(leaveAck.ok).toBe(true);
    const removed = await hostStates.waitFor(
      (state) => state.players.length === 1 && !state.players.some((candidate) => candidate.id === playerAuth.playerId),
    );
    expect(removed.players[0]?.id).toBe(hostAuth.playerId);
  });

  it("removes disconnected lobby players after the reconnect grace window", async () => {
    const host = await connectClient();
    const player = await connectClient();
    const hostStates = trackRoomStates(host);

    const hostAck = await emitAck(host, "room:create", { name: "Host", targetPlayerCount: 5 });
    expect(hostAck.ok).toBe(true);
    const hostAuth = authFrom(hostAck);
    const joinAck = await emitAck(player, "room:join", { roomCode: hostAuth.roomCode, name: "P2" });
    expect(joinAck.ok).toBe(true);
    const playerAuth = authFrom(joinAck);
    await hostStates.waitFor((state) => state.players.some((candidate) => candidate.id === playerAuth.playerId));

    player.disconnect();

    await hostStates.waitFor((state) => state.players.some((candidate) => candidate.id === playerAuth.playerId && !candidate.connected));
    const removed = await hostStates.waitFor(
      (state) => state.players.length === 1 && !state.players.some((candidate) => candidate.id === playerAuth.playerId),
    );
    expect(removed.players[0]?.id).toBe(hostAuth.playerId);
  });

  it("keeps a disconnected lobby player when they rejoin before the grace window expires", async () => {
    const host = await connectClient();
    const player = await connectClient();
    const hostStates = trackRoomStates(host);

    const hostAck = await emitAck(host, "room:create", { name: "Host", targetPlayerCount: 5 });
    expect(hostAck.ok).toBe(true);
    const hostAuth = authFrom(hostAck);
    const joinAck = await emitAck(player, "room:join", { roomCode: hostAuth.roomCode, name: "P2" });
    expect(joinAck.ok).toBe(true);
    const playerAuth = authFrom(joinAck);
    await hostStates.waitFor((state) => state.players.some((candidate) => candidate.id === playerAuth.playerId));

    player.disconnect();
    await hostStates.waitFor((state) =>
      state.players.some((candidate) => candidate.id === playerAuth.playerId && !candidate.connected),
    );

    const rejoiningPlayer = await connectClient();
    const rejoinAck = await emitAck(rejoiningPlayer, "room:rejoin", playerAuth);
    expect(rejoinAck.ok).toBe(true);

    const restored = await hostStates.waitFor((state) =>
      state.players.some((candidate) => candidate.id === playerAuth.playerId && candidate.connected),
    );
    expect(restored.players.map((candidate) => candidate.id)).toContain(playerAuth.playerId);

    await new Promise((resolve) => setTimeout(resolve, 120));
    const syncAck = await emitAck(host, "room:sync", hostAuth);
    expect(syncAck.ok).toBe(true);
    const stillPresent = await hostStates.waitFor((state) =>
      state.players.some((candidate) => candidate.id === playerAuth.playerId && candidate.connected),
    );
    expect(stillPresent.players.map((candidate) => candidate.id)).toContain(playerAuth.playerId);
  });

  it("returns authoritative room state on explicit client sync", async () => {
    const host = await connectClient();
    const player = await connectClient();
    const hostStates = trackRoomStates(host);

    const hostAck = await emitAck(host, "room:create", { name: "Host", targetPlayerCount: 5 });
    expect(hostAck.ok).toBe(true);
    const hostAuth = authFrom(hostAck);
    const joinAck = await emitAck(player, "room:join", { roomCode: hostAuth.roomCode, name: "P2" });
    expect(joinAck.ok).toBe(true);
    const playerAuth = authFrom(joinAck);
    await hostStates.waitFor((state) => state.players.some((candidate) => candidate.id === playerAuth.playerId));

    const readyAck = await emitAck(player, "player:setReady", { ...playerAuth, ready: true });
    expect(readyAck.ok).toBe(true);
    await hostStates.waitFor((state) => state.players.some((candidate) => candidate.id === playerAuth.playerId && candidate.ready));

    const nextSyncedState = waitForNextRoomState(
      host,
      (state) => state.players.some((candidate) => candidate.id === playerAuth.playerId && candidate.ready),
    );
    const syncAck = await emitAck(host, "room:sync", hostAuth);

    expect(syncAck.ok).toBe(true);
    await expect(nextSyncedState).resolves.toMatchObject({ roomCode: hostAuth.roomCode });
  });

  it("lets the host start when the target room is full and every non-host player is ready", async () => {
    const sockets = await Promise.all(Array.from({ length: 5 }, () => connectClient()));
    const trackers = sockets.map(trackRoomStates);

    const hostAck = await emitAck(sockets[0], "room:create", { name: "Host", targetPlayerCount: 5 });
    expect(hostAck.ok).toBe(true);
    const hostAuth = authFrom(hostAck);
    const playerAuths: Auth[] = [];

    for (let index = 1; index < sockets.length; index += 1) {
      const joinAck = await emitAck(sockets[index], "room:join", { roomCode: hostAuth.roomCode, name: `P${index + 1}` });
      expect(joinAck.ok).toBe(true);
      playerAuths.push(authFrom(joinAck));
    }

    await Promise.all(trackers.map((tracker) => tracker.waitFor((state) => state.players.length === 5)));

    for (const playerAuth of playerAuths) {
      const readyAck = await emitAck(sockets[playerAuths.indexOf(playerAuth) + 1], "player:setReady", { ...playerAuth, ready: true });
      expect(readyAck.ok).toBe(true);
    }

    const allNonHostsReady = (state: PublicRoomState) =>
      state.players.length === 5 && state.players.filter((player) => !player.isHost && player.ready).length === 4;
    await Promise.all(trackers.map((tracker) => tracker.waitFor(allNonHostsReady)));

    const startAck = await emitAck(sockets[0], "room:start", hostAuth);
    expect(startAck.ok).toBe(true);
    await Promise.all(trackers.map((tracker) => tracker.waitFor((state) => state.phase === "team")));
  });

  it("broadcasts a majority rejection, the automatic captain approval and direct next-leader selection", async () => {
    const { sockets, auths, roomCode } = await createStartedClients();
    const state = runtime.rooms.getPublicState(roomCode);
    const leaderIndex = auths.findIndex((auth) => auth.playerId === state.leaderId);
    expect((await emitAck(sockets[leaderIndex], "team:propose", {
      ...auths[leaderIndex], team: state.players.slice(0, state.teamSize).map((player) => player.id),
    })).ok).toBe(true);
    const voterIndexes = auths.map((_auth, index) => index).filter((index) => index !== leaderIndex);
    for (const index of voterIndexes.slice(0, -1)) {
      expect((await emitAck(sockets[index], "vote:submit", { ...auths[index], approved: false })).ok).toBe(true);
    }
    expect(runtime.rooms.getPublicState(roomCode).phase).toBe("vote");
    expect(runtime.rooms.getPublicState(roomCode).history).toEqual([]);
    const rejectedStates = sockets.map((client) => waitForNextRoomState(client, (next) =>
      next.phase === "proposalResult" && next.history.at(-1)?.rejections === 3,
    ));
    const nextTeamStates = sockets.map((client) => waitForNextRoomState(client, (next) =>
      next.phase === "team" && next.history.at(-1)?.rejections === 3,
    ));
    const lastVoter = voterIndexes.at(-1)!;
    expect((await emitAck(sockets[lastVoter], "vote:submit", { ...auths[lastVoter], approved: true })).ok).toBe(true);
    for (const result of await Promise.all(rejectedStates)) {
      expect(result.history.at(-1)).toMatchObject({ approvals: 2, rejections: 3, result: "fail" });
      expect(result.history.at(-1)?.voteDetails).toEqual([{ playerId: state.leaderId, approved: true }, ...voterIndexes.map((index, position) => ({ playerId: auths[index].playerId, approved: position === voterIndexes.length - 1 }))]);
      expect(result.leaderId).toBe(state.leaderId);
      expect(result.timer).toMatchObject({ kind: "proposalResult", durationMs: 100 });
      expect(result.speechOrder).toEqual([]);
    }
    for (const result of await Promise.all(nextTeamStates)) {
      expect(result.leaderId).toBe(auths[1].playerId);
      expect(result.speechOrder).toEqual([]);
      expect(result.timer).toMatchObject({ kind: "team", durationMs: 30_000 });
    }
  });

  it.each([5, 6, 7, 8, 9, 10])("passes %i-player proposals when objections do not exceed half of all players", async count => {
    const { sockets, auths, roomCode, trackers } = await createStartedClients(count);
    const leader = auths[0];
    const state = runtime.rooms.getPublicState(roomCode);
    expect((await emitAck(sockets[0], "team:propose", { ...leader, team: auths.slice(0, state.teamSize).map(auth => auth.playerId) })).ok).toBe(true);
    expect(runtime.rooms.getPublicState(roomCode).voteSubmitted).toEqual([leader.playerId]);
    expect((await emitAck(sockets[0], "vote:submit", { ...leader, approved: false })).ok).toBe(false);
    for (let index = 1; index < count; index++) {
      expect((await emitAck(sockets[index], "vote:submit", { ...auths[index], approved: index > Math.floor(count / 2) })).ok).toBe(true);
    }
    for (const result of await Promise.all(trackers.map(tracker => tracker.waitFor(next => next.phase === "mission")))) {
      expect(result.history.at(-1)).toMatchObject({ approvals: Math.ceil(count / 2), rejections: Math.floor(count / 2), result: "success" });
      expect(result.history.at(-1)?.voteDetails).toContainEqual({ playerId: leader.playerId, approved: true });
      expect(result.voteSubmitted).toHaveLength(count);
    }
  });

  it.each([false, true])("skips terminal speeches and broadcasts only appropriate public identities (failed=%s)", async failed => {
    const { sockets, auths, roomCode, trackers } = await createStartedClients();
    const evil = auths.find(auth => runtime.rooms.getPrivateState(roomCode, auth.playerId).side === "evil")!;
    for (let quest = 0; quest < 3; quest++) {
      const state = runtime.rooms.getPublicState(roomCode);
      const leaderIndex = auths.findIndex(auth => auth.playerId === state.leaderId);
      const team = [evil.playerId, ...auths.filter(auth => auth !== evil).map(auth => auth.playerId)].slice(0, state.teamSize);
      expect((await emitAck(sockets[leaderIndex], "team:propose", { ...auths[leaderIndex], team })).ok).toBe(true);
      for (const [index, auth] of auths.entries()) if (index !== leaderIndex) expect((await emitAck(sockets[index], "vote:submit", { ...auth, approved: true })).ok).toBe(true);
      for (const [index, auth] of auths.entries()) if (team.includes(auth.playerId)) expect((await emitAck(sockets[index], "mission:submit", { ...auth, failed: failed && auth === evil })).ok).toBe(true);
      if (quest < 2) {
        await trackers[0].waitFor(next => next.phase === "speech");
        await finishClientSpeeches(sockets, auths, roomCode);
      }
    }
    for (const state of await Promise.all(trackers.map(tracker => tracker.waitFor(next => next.phase === (failed ? "result" : "assassin"))))) {
      expect(state.speechOrder).toEqual([]);
      if (failed) expect(state).toMatchObject({ winner: "evil", timer: null });
      else {
        expect(state.timer).toMatchObject({ kind: "assassin", durationMs: 120_000 });
        expect(state.revealedRoles).toHaveLength(2);
        expect(state.revealedRoles.every(role => role.side === "evil")).toBe(true);
        expect(state.revealedRoles.some(role => role.role === "merlin")).toBe(false);
      }
    }
    if (!failed) {
      const assassinIndex = auths.findIndex(auth => runtime.rooms.getPrivateState(roomCode, auth.playerId).role === "assassin");
      const merlin = auths.find(auth => runtime.rooms.getPrivateState(roomCode, auth.playerId).role === "merlin")!;
      const observerIndex = (assassinIndex + 1) % auths.length;
      expect((await emitAck(sockets[observerIndex], "assassin:choose", { ...auths[observerIndex], targetId: merlin.playerId })).ok).toBe(false);
      expect((await emitAck(sockets[assassinIndex], "assassin:choose", { ...auths[assassinIndex], targetId: merlin.playerId })).ok).toBe(true);
      for (const state of await Promise.all(trackers.map(tracker => tracker.waitFor(next => next.phase === "result")))) expect(state).toMatchObject({ winner: "evil", timer: null });
    }
  });

  it("broadcasts a good victory when the assassin explicitly leaves", async () => {
    const { sockets, auths, roomCode, trackers } = await createStartedClients();
    for (let quest = 0; quest < 3; quest += 1) {
      const state = runtime.rooms.getPublicState(roomCode);
      const leaderIndex = auths.findIndex((auth) => auth.playerId === state.leaderId);
      const team = state.players.slice(0, state.teamSize).map((player) => player.id);
      expect((await emitAck(sockets[leaderIndex], "team:propose", { ...auths[leaderIndex], team })).ok).toBe(true);
      for (const [index, auth] of auths.entries()) {
        if (index !== leaderIndex) expect((await emitAck(sockets[index], "vote:submit", { ...auth, approved: true })).ok).toBe(true);
      }
      for (const [index, auth] of auths.entries()) {
        if (team.includes(auth.playerId)) expect((await emitAck(sockets[index], "mission:submit", { ...auth, failed: false })).ok).toBe(true);
      }
      await trackers[0].waitFor(s => s.phase === (quest < 2 ? "speech" : "assassin"));
      if (quest < 2) await finishClientSpeeches(sockets, auths, roomCode);
    }
    const assassinIndex = auths.findIndex((auth) => runtime.rooms.getPrivateState(roomCode, auth.playerId).role === "assassin");
    const results = sockets.filter((_client, index) => index !== assassinIndex).map((client) =>
      waitForNextRoomState(client, (state) => state.phase === "result"),
    );

    expect((await emitAck(sockets[assassinIndex], "room:leave", auths[assassinIndex])).ok).toBe(true);

    for (const result of await Promise.all(results)) {
      expect(result).toMatchObject({ winner: "good", timer: null });
      expect(result.winnerReason).toContain("放弃刺杀");
    }
  });

  it.each(["disconnect", "leave"] as const)("resumes AI turns after a human leader's %s", async (action) => {
    const host = await connectClient();
    const observer = await connectClient();
    const hostStates = trackRoomStates(host);
    const hostAuth = authFrom(await emitAck(host, "room:create", { name: "Host", targetPlayerCount: 5 }));
    expect((await emitAck(host, "room:addAI", { ...hostAuth, count: 3 })).ok).toBe(true);
    const observerAuth = authFrom(await emitAck(observer, "room:join", { roomCode: hostAuth.roomCode, name: "Observer" }));
    expect((await emitAck(observer, "player:setReady", { ...observerAuth, ready: true })).ok).toBe(true);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect((await emitAck(host, "room:start", hostAuth)).ok).toBe(true);
    } finally {
      random.mockRestore();
    }
    await hostStates.waitFor(state => state.phase === "team");
    expect(runtime.rooms.getRoom(hostAuth.roomCode)!.aiSimulating).toBeFalsy();
    expect(runtime.rooms.getRoom(hostAuth.roomCode)!.aiTimeout).toBeUndefined();
    const proposed = waitForNextRoomState(observer, (state) => state.phase === "vote", 3000);

    if (action === "disconnect") host.disconnect();
    else expect((await emitAck(host, "room:leave", hostAuth)).ok).toBe(true);

    const voteState = await proposed;
    expect(voteState.leaderId).not.toBe(hostAuth.playerId);
    expect(voteState.players.find((player) => player.id === voteState.leaderId)?.connected).toBe(true);
    expect(voteState.voteSubmitted).toContain(hostAuth.playerId);
  }, 8000);
});

async function createStartedClients(count = 5) {
  const sockets = await Promise.all(Array.from({ length: count }, () => connectClient()));
  const trackers = sockets.map(trackRoomStates);
  const hostAuth = authFrom(await emitAck(sockets[0], "room:create", { name: "Host", targetPlayerCount: count }));
  const auths = [hostAuth];
  for (let index = 1; index < sockets.length; index += 1) {
    const auth = authFrom(await emitAck(sockets[index], "room:join", { roomCode: hostAuth.roomCode, name: `P${index + 1}` }));
    auths.push(auth);
    expect((await emitAck(sockets[index], "player:setReady", { ...auth, ready: true })).ok).toBe(true);
  }
  const reveals = trackers.map(t => t.waitFor(s => s.phase === "reveal"));
  expect((await emitAck(sockets[0], "room:start", hostAuth)).ok).toBe(true);
  for (const reveal of await Promise.all(reveals)) {
    expect(reveal.revealedRoles).toEqual([]);
    expect(reveal.players.every(player => !("role" in player))).toBe(true);
    expect(reveal.players.every(player => !("servantVariant" in player))).toBe(true);
  }
  await Promise.all(trackers.map(t => t.waitFor(s => s.phase === "team")));
  expect(auths.map(auth => auth.playerId)).toContain(runtime.rooms.getPublicState(hostAuth.roomCode).leaderId);
  return { sockets, auths, roomCode: hostAuth.roomCode, trackers };
}

async function finishClientSpeeches(sockets: ClientSocket[], auths: Auth[], roomCode: string): Promise<void> {
  while (runtime.rooms.getPublicState(roomCode).phase === "speech") {
    const speakerId = runtime.rooms.getPublicState(roomCode).timer!.speakerId;
    const index = auths.findIndex(auth => auth.playerId === speakerId);
    expect((await emitAck(sockets[index], "speech:end", auths[index])).ok).toBe(true);
  }
}

async function connectClient(): Promise<ClientSocket> {
  const client = createClient(serverUrl, {
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  clients.push(client);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting test socket.")), 1000);
    client.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return client;
}

function trackRoomStates(client: ClientSocket): {
  waitFor: (predicate: (state: PublicRoomState) => boolean, timeoutMs?: number) => Promise<PublicRoomState>;
} {
  const states: PublicRoomState[] = [];
  const waiters = new Set<{
    predicate: (state: PublicRoomState) => boolean;
    resolve: (state: PublicRoomState) => void;
    timer: NodeJS.Timeout;
  }>();

  client.on("room:state", (state: PublicRoomState) => {
    states.push(state);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(state)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(state);
    }
  });

  return {
    waitFor(predicate, timeoutMs = 1000) {
      const existing = states.at(-1);
      if (existing && predicate(existing)) return Promise.resolve(existing);

      return new Promise<PublicRoomState>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error("Timed out waiting for matching room state."));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function emitAck(client: ClientSocket, event: string, payload: Record<string, unknown>): Promise<Ack> {
  return new Promise((resolve) => {
    client.emit(event, commandPayload(event, payload, runtime.rooms.getRoom(String(payload.roomCode))?.phaseId), resolve);
  });
}

function waitForNextRoomState(
  client: ClientSocket,
  predicate: (state: PublicRoomState) => boolean,
  timeoutMs = 1000,
): Promise<PublicRoomState> {
  return new Promise((resolve, reject) => {
    const onState = (state: PublicRoomState) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      client.off("room:state", onState);
      resolve(state);
    };
    const timer = setTimeout(() => {
      client.off("room:state", onState);
      reject(new Error("Timed out waiting for next room state."));
    }, timeoutMs);

    client.on("room:state", onState);
  });
}

function authFrom(ack: Ack): Auth {
  const { roomCode, playerId, sessionToken } = ack;
  if (!roomCode || !playerId || !sessionToken) throw new Error("Ack did not contain auth fields.");
  return { roomCode, playerId, sessionToken };
}
