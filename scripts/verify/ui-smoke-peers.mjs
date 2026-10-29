import { io } from "socket.io-client";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";

// Create real peers for manual browser QA in a newly created disposable room.
const [roomCode, countArg = "9", origin = "http://localhost:3100"] = process.argv.slice(2);
const count = Number(countArg);
if (!roomCode || !Number.isInteger(count) || count < 1 || count > 9) {
  throw new Error("Usage: node scripts/verify/ui-smoke-peers.mjs ROOM_CODE [1-9] [ORIGIN]");
}
const envPath = new URL("../../.env", import.meta.url);
if (existsSync(envPath)) loadEnvFile(envPath);
const accessResponse = await fetch(`${origin}/api/access`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: process.env.GAME_ACCESS_CODE }),
});
if (!accessResponse.ok) throw new Error("Entrance verification failed; set GAME_ACCESS_CODE in .env or the environment.");
const cookie = accessResponse.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Entrance verification did not issue a session cookie.");
const peers = [];
const names = ["小雨", "北辰", "林间", "星河", "长风", "青禾", "南川", "暮雪", "测试名字最长十六个字符验证布局"];
let state;

function ack(socket, event, payload) {
  if (!["room:rejoin", "room:sync", "voice:join"].includes(event)) {
    payload = { ...payload, requestId: `r_${randomBytes(16).toString("hex")}`, issuedAt: Date.now() };
    if (!["room:create", "room:join", "room:leave", "room:dissolve"].includes(event)) payload.phaseId = state?.phaseId;
  }
  return new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error, result) => {
    if (error || !result?.ok) reject(error ?? new Error(result?.error ?? event));
    else resolve(result);
  }));
}
function send(peer, event, payload = {}) {
  return ack(peer.socket, event, { ...peer.auth, ...payload });
}
for (let i = 0; i < count; i++) {
  const socket = io(origin, { transports: ["websocket"], extraHeaders: { Cookie: cookie } });
  const peer = { socket, auth: null, privateState: null };
  socket.on("room:state", next => { state = next; });
  socket.on("player:privateState", next => { peer.privateState = next; });
  const result = await ack(socket, "room:join", { roomCode, name: names[i] });
  peer.auth = { roomCode: result.roomCode, playerId: result.playerId, sessionToken: result.sessionToken };
  peers.push(peer);
  await send(peer, "player:setReady", { ready: true });
}
console.log(`Joined ${count} peers in ${roomCode}. Commands: status, ready, unready, vote, reject, splitvote, mission, fail, propose, speech, dissolve, quit`);
const input = createInterface({ input: process.stdin });
for await (const command of input) {
  try {
    if (command === "quit") break;
    if (["status", "vote", "reject", "splitvote", "mission", "fail", "propose", "speech", "dissolve"].includes(command)) {
      await Promise.all(peers.map(peer => send(peer, "room:sync")));
    }
    if (command === "ready" || command === "unready") {
      await send(peers[0], "player:setReady", { ready: command === "ready" });
    } else if (["vote", "reject", "splitvote"].includes(command)) {
      const voters = peers.filter(p => p.privateState?.canVote);
      for (let index = 0; index < voters.length; index++) await send(voters[index], "vote:submit", { approved: command === "vote" || command === "splitvote" && index < Math.ceil(voters.length / 2) });
    } else if (command === "mission" || command === "fail") {
      const actors = peers.filter(p => p.privateState?.canMission);
      for (const peer of actors) await send(peer, "mission:submit", { failed: command === "fail" && peer.privateState.canFailMission });
    } else if (command === "propose") {
      if (state?.phase !== "team") throw new Error("Wait until the team phase before proposing.");
      const leader = peers.find(p => p.privateState?.canPropose);
      if (!leader) throw new Error("Browser player is leader; submit from the UI.");
      const completed = new Set(state.history.filter(h => h.type === "mission").map(h => h.quest - 1));
      const questIndex = [0, 1, 2, 3, 4].find(i => !completed.has(i));
      const sizes = { 5: [2, 2, 3, 3, 3], 6: [2, 3, 4, 3, 4], 7: [2, 3, 3, 4, 4], 8: [3, 4, 4, 5, 5], 9: [3, 4, 4, 5, 5], 10: [3, 4, 4, 5, 5] };
      const evil = peers.find(p => p.privateState?.side === "evil");
      const team = [...new Set([state.hostId, evil?.auth.playerId, ...state.players.map(p => p.id)].filter(Boolean))].slice(0, sizes[state.players.length][questIndex]);
      await send(leader, "team:propose", { team, questIndex });
    } else if (command === "speech") {
      const speaker = peers.find(p => p.auth.playerId === state.timer?.speakerId);
      if (!speaker) throw new Error("Browser player is speaking; finish from the UI.");
      await send(speaker, "speech:end");
    } else if (command === "dissolve") {
      const host = peers.find(peer => peer.auth.playerId === state.hostId);
      if (!host) throw new Error("Only the test peer that owns the host can dissolve this room.");
      await send(host, "room:dissolve");
    }
    console.log(JSON.stringify({ phase: state?.phase, leader: state?.players.find(p => p.id === state.leaderId)?.name, playerCount: state?.players.length, ready: state?.players.filter(p => p.ready).length, score: state?.score, submitted: state?.phase === "vote" ? state.voteSubmitted.length : state?.missionSubmitted.length,
      ...(command === "status" ? {
        speechOrder: state?.speechOrder?.map(id => state.players.find(player => player.id === id)?.name),
        speaker: state?.players.find(player => player.id === state.timer?.speakerId)?.name,
        testPeerSides: peers.map(p => ({ name: state?.players.find(player => player.id === p.auth.playerId)?.name, side: p.privateState?.side })),
      } : {}),
    }));
  } catch (error) { console.error(error.message); }
}
for (const peer of peers) {
  try { await send(peer, "room:leave"); } catch { /* The test room may already be dissolved. */ }
  peer.socket.disconnect();
}
input.close();
