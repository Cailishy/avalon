import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { io } from "socket.io-client";

// Only launch disposable loopback servers; never attach to an existing room.
const root = resolve(process.argv[2] ?? ".");
const directory = await mkdtemp(join(tmpdir(), "awalong-recovery-"));
const file = join(directory, "rooms.sqlite");
const passcode = randomBytes(24).toString("base64url");
const publicOrigin = "https://game.example.test";
const headers = { Host: "game.example.test", Origin: publicOrigin, "X-Forwarded-Proto": "https" };
const clients = [];
let server;
let peers = [];
let cookie;
let roomCode;
const waitFor = async (condition, label, ms = 15000) => {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= until) throw new Error(`Verification timed out: ${label}`);
    await sleep(25);
  }
};
async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function startServer() {
  const port = await unusedPort();
  const child = spawn(process.execPath, [join(root, "dist-server/server/index.js")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", APP_MODE: "public", PUBLIC_ORIGIN: publicOrigin,
      GAME_ACCESS_CODE: passcode, HOST: "127.0.0.1", PORT: String(port), TRUST_PROXY_CIDRS: "loopback",
      LIVEKIT_URL: "", LIVEKIT_API_URL: "", LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "", VOICE_REQUIRED: "false", ROOM_STORE_PATH: file },
  });
  let ready = false;
  child.stdout.on("data", bytes => { if (bytes.toString().includes(`server running at http://localhost:${port}`)) ready = true; });
  child.stderr.resume();
  server = { child, port, url: `http://127.0.0.1:${port}` };
  child.once("error", () => { ready = false; });
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Disposable verification server did not start.");
    return ready;
  }, "server startup");
  const health = await request("/healthz"); assert.equal(health.status, 200);
}
async function killServer() {
  if (!server) return;
  const child = server.child;
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await stopped;
  }
  server = undefined;
}
// Use explicit proxy headers; fetch may replace Host with the loopback target.
const request = (path, options = {}) => new Promise((resolve, reject) => {
  const req = http.request(server.url + path, { method: options.method ?? "GET", headers: { ...headers, ...options.headers } }, response => {
    response.resume();
    response.once("end", () => resolve({ status: response.statusCode, headers: { get: name => {
      const value = response.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value ?? null;
    } } }));
    response.once("error", reject);
  });
  req.setTimeout(5000, () => req.destroy(new Error("Verification request timed out.")));
  req.once("error", reject);
  req.end(options.body);
});
const auth = result => ({ roomCode: result.roomCode, playerId: result.playerId, sessionToken: result.sessionToken });
async function connect(identity) {
  const socket = io(server.url, { transports: ["websocket"], reconnection: false, timeout: 5000, extraHeaders: { ...headers, Cookie: cookie } });
  clients.push(socket);
  const peer = { socket, auth: identity, state: null, privateState: null, voice: null };
  socket.on("room:state", state => { peer.state = state; });
  socket.on("player:privateState", state => { peer.privateState = state; });
  socket.on("voice:policy", policy => { peer.voice = policy; });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return peer;
}
async function send(peer, event, data = {}) {
  const payload = ["room:create", "room:join"].includes(event) ? data : { ...peer.auth, ...data };
  if (!["room:rejoin", "room:sync", "voice:join"].includes(event)) {
    Object.assign(payload, { requestId: `r_${randomBytes(16).toString("hex")}`, issuedAt: Date.now() });
    if (!["room:create", "room:join", "room:leave", "room:dissolve"].includes(event)) payload.phaseId = peer.state?.phaseId;
  }
  const result = await peer.socket.timeout(5000).emitWithAck(event, payload);
  assert.equal(result?.ok, true, `${event} failed`);
  return result;
}
async function restartAndRejoin() {
  const sessions = peers.map(peer => peer.auth);
  await killServer();
  peers.forEach(peer => peer.socket.disconnect());
  await startServer();
  const next = [];
  for (const identity of sessions) {
    const peer = await connect(identity); next.push(peer);
    await send(peer, "room:rejoin");
    if (next.length === 1) {
      assert.ok(peer.state.recovery);
      assert.equal(peer.state.timer.kind, "recovery");
      assert.equal(peer.privateState.canVote, false);
    }
  }
  peers = next;
  await waitFor(() => peers.every(peer => peer.state && !peer.state.recovery && JSON.stringify(peer.state) === JSON.stringify(peers[0].state)), "recovered state convergence");
}

try {
  await startServer();
  const entry = await request("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: passcode }) });
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get("set-cookie"), /Secure/);
  cookie = entry.headers.get("set-cookie").split(";")[0];
  for (let index = 0; index < 5; index++) {
    const peer = await connect();
    peer.auth = auth(await send(peer, index ? "room:join" : "room:create", { name: `Recovery${index}`, ...(index ? { roomCode } : { targetPlayerCount: 5 }) }));
    roomCode ??= peer.auth.roomCode; peers.push(peer);
    if (index) await send(peer, "player:setReady", { ready: true });
  }
  assert.equal(peers[0].voice.configured, false);
  await send(peers[0], "room:start");
  await waitFor(() => peers.every(peer => peer.state?.phase === "team"), "role reveal");
  const roles = peers.map(peer => peer.privateState.role);
  const leader = peers.find(peer => peer.auth.playerId === peers[0].state.leaderId);
  const voter = peers.find(peer => peer !== leader);
  const team = peers.slice(0, 2).map(peer => peer.auth.playerId);
  await send(leader, "team:propose", { team });
  await waitFor(() => peers.every(peer => peer.state?.phase === "vote"), "proposal state convergence");
  await send(voter, "vote:submit", { approved: false });
  await sleep(1100);
  const remainingBefore = peers[0].state.timer.deadline - Date.now();
  await restartAndRejoin();
  assert.equal(peers[0].state.phase, "vote");
  assert.deepEqual(peers.map(peer => peer.privateState.role), roles);
  assert.deepEqual(peers[0].state.proposal, team);
  assert.deepEqual(new Set(peers[0].state.voteSubmitted), new Set([leader.auth.playerId, voter.auth.playerId]));
  const remainingAfter = peers[0].state.timer.deadline - Date.now();
  assert.ok(remainingAfter >= remainingBefore - 1500 && remainingAfter <= remainingBefore + 2000);
  for (const peer of peers.filter(peer => !peers[0].state.voteSubmitted.includes(peer.auth.playerId))) await send(peer, "vote:submit", { approved: true });
  await waitFor(() => peers.every(peer => peer.state.phase === "mission"), "mission start");
  for (const peer of peers.filter(peer => team.includes(peer.auth.playerId))) await send(peer, "mission:submit", { failed: false });
  await waitFor(() => peers.every(peer => peer.state.phase === "missionResult"), "mission result");
  await restartAndRejoin();
  assert.equal(peers[0].state.phase, "missionResult");
  assert.equal(peers[0].state.score.success, 1);
  assert.equal(peers[0].state.history.filter(entry => entry.type === "mission").length, 1);
  await send(peers[0], "room:dissolve"); roomCode = undefined;
  await killServer();
  const db = new DatabaseSync(file); const remainingRooms = Number(db.prepare("SELECT count(*) AS count FROM rooms").get().count); db.close();
  assert.equal(remainingRooms, 0);
  console.log(JSON.stringify({ ok: true, publicStartupWithoutVoice: true, secureCookiePreserved: true, forcedProcessRestarts: 2, fiveSessionsRestored: true, partialVotesPreserved: true, identitiesPreserved: true, countdownPausedDuringDowntime: true, missionNotSettledTwice: true, testRoomRemoved: true }));
} finally {
  if (server && peers[0]?.socket.connected && roomCode) await send(peers[0], "room:dissolve").catch(() => {});
  clients.forEach(client => client.disconnect());
  await killServer();
  const target = resolve(directory);
  // eslint-disable-next-line no-unsafe-finally -- Never recursively remove an unverified directory.
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("awalong-recovery-")) throw new Error("Unsafe verification cleanup path.");
  await rm(target, { recursive: true, force: true });
}
