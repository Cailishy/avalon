import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { Server } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachSocketHandlers, type SocketRuntime } from "./socketHandlers";
import { RoomStore } from "./roomStore";
import { createAccessGate } from "./accessGate";
import type { PrivatePlayerState, PublicRoomState } from "../shared/game";
import { commandPayload } from "../../tests/helpers/commands";
import { needsPhase } from "../shared/protocol";

type Session = { roomCode: string; playerId: string; sessionToken: string };
const session = (value: Session): Session => ({ roomCode: value.roomCode, playerId: value.playerId, sessionToken: value.sessionToken });
type Peer = { socket: Socket; instance: Instance; auth?: Session; state?: PublicRoomState; privateState?: PrivatePlayerState };
type Instance = { url: string; io: Server; runtime: SocketRuntime; store: RoomStore; stopped: boolean };
const instances: Instance[] = [];
const clients: Socket[] = [];
let directory: string;
let file: string;
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 6000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("Recovery integration timed out."); await new Promise(resolve => setTimeout(resolve, 10)); }
};
async function start(): Promise<Instance> {
  const store = new RoomStore(file);
  const app = express();
  const server = http.createServer(app);
  const sockets = new Server(server);
  const gate = createAccessGate("recovery-test-secret", Date.now, {}, store.accessKey("recovery-test-secret"));
  app.use("/api/access", gate.router); gate.protectSockets(sockets);
  const runtime = attachSocketHandlers(sockets, ["http://current.test"], { store, lobbyDisconnectGraceMs: 30, timing: { revealDurationMs: 20, resultDurationMs: 20 } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port.");
  const instance = { url: `http://127.0.0.1:${address.port}`, io: sockets, runtime, store, stopped: false };
  instances.push(instance);
  return instance;
}
async function stop(instance: Instance) {
  if (instance.stopped) return;
  instance.stopped = true;
  await instance.runtime.close();
  await new Promise<void>(resolve => instance.io.close(() => resolve()));
}
async function unlock(instance: Instance) {
  const response = await fetch(`${instance.url}/api/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "recovery-test-secret" }) });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function connect(instance: Instance, cookie: string, auth?: Session): Promise<Peer> {
  const socket = io(instance.url, { transports: ["websocket"], reconnection: false, extraHeaders: { Cookie: cookie } });
  clients.push(socket);
  const peer: Peer = { socket, instance, auth };
  socket.on("room:state", state => { peer.state = state; });
  socket.on("player:privateState", state => { peer.privateState = state; });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return peer;
}
const raw = (peer: Peer, event: string, payload: object = {}) => peer.socket.timeout(5000).emitWithAck(event, commandPayload(event, ["room:create", "room:join"].includes(event) ? { ...payload } : { ...peer.auth, ...payload }, peer.state?.phaseId));
const send = async (peer: Peer, event: string, payload: object = {}) => {
  if (needsPhase(event)) await waitFor(() => peer.state?.phaseId === peer.instance.runtime.rooms.getRoom(peer.auth!.roomCode)?.phaseId);
  const result = await raw(peer, event, payload);
  expect(result.ok, result.error).toBe(true);
  return result;
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "awalong-runtime-")); file = join(directory, "rooms.sqlite");
});
afterEach(async () => {
  for (const instance of instances.splice(0)) await stop(instance);
  clients.splice(0).forEach(client => client.disconnect());
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("awalong-runtime-")) throw new Error("Unsafe test cleanup path.");
  rmSync(target, { recursive: true, force: true });
});

describe("Durable real-socket runtime", () => {
  it("recovers the original create receipt after restarting and never creates a second room", async () => {
    const first = await start(); const cookie = await unlock(first); const host = await connect(first, cookie);
    const request = commandPayload("room:create", { name: "Host" });
    const created = await host.socket.timeout(5000).emitWithAck("room:create", request);
    expect(created.ok).toBe(true);
    await stop(first);
    const second = await start(); const reconnected = await connect(second, cookie);
    expect(await reconnected.socket.timeout(5000).emitWithAck("room:create", request)).toEqual(created);
    expect(second.runtime.rooms.roomCodes()).toEqual([created.roomCode]);
    expect(second.runtime.rooms.getPublicState(created.roomCode).players).toHaveLength(1);
  });

  it("restores five player sessions, partial votes and the original entrance cookie across a full runtime restart", async () => {
    const first = await start(); const cookie = await unlock(first); const peers: Peer[] = [];
    for (let index = 0; index < 5; index++) {
      const peer = await connect(first, cookie);
      const answer = await send(peer, index ? "room:join" : "room:create", { name: `Peer${index}`, ...(index ? { roomCode: peers[0].auth!.roomCode } : { targetPlayerCount: 5 }) });
      peer.auth = { roomCode: answer.roomCode, playerId: answer.playerId, sessionToken: answer.sessionToken }; peers.push(peer);
      if (index) await send(peer, "player:setReady", { ready: true });
    }
    const code = peers[0].auth!.roomCode;
    await send(peers[0], "room:start"); await waitFor(() => peers.every(peer => peer.state?.phase === "team"));
    const leader = peers.find(peer => peer.auth!.playerId === peers[0].state!.leaderId)!;
    const team = peers.slice(0, 2).map(peer => peer.auth!.playerId);
    await send(leader, "team:propose", { team });
    const voter = peers.find(peer => peer !== leader)!; await send(voter, "vote:submit", { approved: false });
    const roles = peers.map(peer => peer.privateState!.role);
    await stop(first);
    const second = await start(); const restored: Peer[] = [];
    for (const old of peers) {
      const peer = await connect(second, cookie, old.auth); restored.push(peer); await send(peer, "room:rejoin");
      if (restored.length === 1) { expect(peer.state?.recovery).toBeDefined(); expect(peer.privateState?.canVote).toBe(false); }
    }
    await waitFor(() => restored.every(peer => peer.state?.phase === "vote" && !peer.state.recovery));
    expect(restored.map(peer => peer.privateState!.role)).toEqual(roles);
    expect(restored.every(peer => JSON.stringify(peer.state) === JSON.stringify(restored[0].state))).toBe(true);
    expect(restored[0].state!.proposal).toEqual(team);
    expect(new Set(restored[0].state!.voteSubmitted)).toEqual(new Set([leader.auth!.playerId, voter.auth!.playerId]));
    expect((await raw(restored[0], "voice:join")).ok).toBe(false);
    for (const peer of restored.filter(peer => ![leader.auth!.playerId, voter.auth!.playerId].includes(peer.auth!.playerId))) await send(peer, "vote:submit", { approved: true });
    await waitFor(() => restored.every(peer => peer.state?.phase === "mission"));
    for (const peer of restored.filter(peer => team.includes(peer.auth!.playerId))) await send(peer, "mission:submit", { failed: false });
    await waitFor(() => restored[0].state?.score.success === 1);
    expect(restored[0].state!.history.filter(entry => entry.type === "mission")).toHaveLength(1);
    await send(restored[0], "room:dissolve"); expect(second.store.load().rooms).toEqual([]);
    await stop(second); const third = await start(); expect(third.runtime.rooms.getRoom(code)).toBeNull();
  }, 20000);

  it("removes the durable snapshot when the last lobby player leaves or disconnects", async () => {
    const instance = await start(); const cookie = await unlock(instance); const host = await connect(instance, cookie);
    const created = await send(host, "room:create", { name: "Host" }); host.auth = session(created);
    await send(host, "room:leave"); expect(instance.store.load().rooms).toEqual([]);
    const next = await send(host, "room:create", { name: "Host" }); host.auth = session(next);
    host.socket.disconnect(); await waitFor(() => instance.runtime.rooms.getRoom(next.roomCode) === null);
    expect(instance.store.load().rooms).toEqual([]);
  });

  it("never acknowledges or broadcasts a mutation whose durable commit failed", async () => {
    const instance = await start(); const host = await connect(instance, await unlock(instance));
    const result = await send(host, "room:create", { name: "Host" }); host.auth = session(result);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(instance.store, "commit").mockImplementationOnce(() => { throw new Error("sensitive storage error"); });
    try {
      expect((await raw(host, "room:setPlayerCount", { targetPlayerCount: 6 })).ok).toBe(false);
      expect(instance.runtime.isHealthy()).toBe(false);
      expect(host.state!.targetPlayerCount).toBe(5);
      expect(instance.store.load().rooms[0].targetPlayerCount).toBe(5);
      expect((await raw(host, "room:sync")).ok).toBe(false);
    } finally { write.mockRestore(); error.mockRestore(); }
  });

  it("does not notify a kicked player before committing their removal", async () => {
    const instance = await start(); const cookie = await unlock(instance);
    const host = await connect(instance, cookie);
    host.auth = session(await send(host, "room:create", { name: "Host" }));
    const guest = await connect(instance, cookie);
    guest.auth = session(await send(guest, "room:join", { name: "Guest", roomCode: host.auth.roomCode }));
    const removed = vi.fn(); guest.socket.on("room:removed", removed);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(instance.store, "commit").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    try {
      expect((await raw(host, "player:kick", { targetId: guest.auth.playerId })).ok).toBe(false);
      expect(removed).not.toHaveBeenCalled();
      expect(instance.store.load().rooms[0].players).toHaveLength(2);
      expect(guest.state!.players).toHaveLength(2);
      expect(instance.runtime.isHealthy()).toBe(false);
    } finally { write.mockRestore(); error.mockRestore(); }
  });
});
