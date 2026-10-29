import assert from "node:assert/strict";
import http from "node:http";
import { loadEnvFile } from "node:process";
import express from "express";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import { Room, RoomEvent, AudioSource, AudioFrame, AudioStream, LocalAudioTrack, TrackSource, TrackPublishOptions, dispose } from "@livekit/rtc-node";
import { createAccessGate } from "../../src/server/accessGate.ts";
import { attachSocketHandlers } from "../../src/server/socketHandlers.ts";
import { VoiceService } from "../../src/server/voice.ts";
import { RoomServiceClient } from "livekit-server-sdk";
import { commandPayload } from "../../tests/helpers/commands.ts";

loadEnvFile(new URL("../../.media/voice.env", import.meta.url));
const voice = new VoiceService({ url: process.env.LIVEKIT_URL, apiUrl: process.env.LIVEKIT_API_URL, apiKey: process.env.LIVEKIT_API_KEY, apiSecret: process.env.LIVEKIT_API_SECRET });
const mediaApi = new RoomServiceClient(process.env.LIVEKIT_API_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const app = express();
const server = http.createServer(app);
const sockets = new Server(server);
const gate = createAccessGate("synthetic-test-only");
app.use("/api/access", gate.router);
gate.protectSockets(sockets);
const runtime = attachSocketHandlers(sockets, [], { voice, timing: { revealDurationMs: 30, resultDurationMs: 30 } });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const clients = [];
const media = [];
const resources = [];
let host;
let latest;
const timeout = (promise, ms = 10_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Media verification timed out")), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const send = async (peer, event, data = {}) => {
  const result = await peer.socket.timeout(6000).emitWithAck(event, commandPayload(event, { ...peer.auth, ...data }, runtime.rooms.getRoom(peer.auth?.roomCode)?.phaseId));
  assert(result.ok, result.error);
  return result;
};
const waitPhase = phase => timeout(new Promise(resolve => {
  if (latest?.phase === phase) { resolve(latest); return; }
  const fn = state => { if (state.phase === phase) { clients[0].socket.off("room:state", fn); resolve(state); } };
  clients[0].socket.on("room:state", fn);
}));
async function joinMedia(peer) {
  const { access } = await send(peer, "voice:join");
  const room = new Room();
  media.push(room);
  await timeout(room.connect(access.url, access.token, { autoSubscribe: true }));
  return { room, access };
}
async function tone(room, receiver) {
  const source = new AudioSource(48_000, 1, 100);
  const track = LocalAudioTrack.createAudioTrack("synthetic-440Hz", source);
  resources.push(source, track);
  const received = new Promise(resolve => {
    receiver.once(RoomEvent.TrackSubscribed, async remote => {
      const reader = new AudioStream(remote, 48_000, 1).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.data.some(sample => Math.abs(sample) > 100)) { resolve(true); break; }
        }
      } finally { await reader.cancel().catch(() => {}); }
    });
  });
  await room.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  for (let frameIndex = 0; frameIndex < 150; frameIndex++) {
    const frame = AudioFrame.create(48_000, 1, 480);
    for (let i = 0; i < frame.data.length; i++) frame.data[i] = Math.round(7000 * Math.sin(2 * Math.PI * 440 * (frameIndex * 480 + i) / 48_000));
    await source.captureFrame(frame);
  }
  await source.waitForPlayout();
  assert(await timeout(received));
}

try {
  const verified = await fetch(`${url}/api/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "synthetic-test-only" }) });
  assert(verified.ok);
  const cookie = verified.headers.get("set-cookie").split(";")[0];
  for (let index = 0; index < 5; index++) {
    const socket = io(url, { transports: ["websocket"], extraHeaders: { Cookie: cookie }, reconnection: false });
    await timeout(new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); }));
    const peer = { socket, auth: null };
    clients.push(peer);
    const event = index ? "room:join" : "room:create";
    const result = await socket.timeout(5000).emitWithAck(event, commandPayload(event, { name: `VoiceTest${index}`, ...(index ? { roomCode: host.auth.roomCode } : { targetPlayerCount: 5 }) }));
    assert(result.ok, result.error);
    peer.auth = { roomCode: result.roomCode, playerId: result.playerId, sessionToken: result.sessionToken };
    if (!index) { host = peer; socket.on("room:state", state => { latest = state; }); }
    else await send(peer, "player:setReady", { ready: true });
  }
  const first = await joinMedia(host);
  const listener = await joinMedia(clients[1]);
  await tone(first.room, listener.room);
  console.log("PASS: synthetic audio traverses the real SFU between two participants (no microphone used)");
  const oldDisconnected = timeout(new Promise(resolve => first.room.once(RoomEvent.Disconnected, resolve)));
  await send(host, "room:start");
  await oldDisconnected;
  console.log("PASS: changing game permissions disconnects the obsolete media room");
  await waitPhase("team");
  const muted = await joinMedia(host);
  assert.equal(muted.access.canSpeak, false);
  const forbiddenSource = new AudioSource(48_000, 1);
  const forbiddenTrack = LocalAudioTrack.createAudioTrack("should-not-publish", forbiddenSource);
  resources.push(forbiddenSource, forbiddenTrack);
  await assert.rejects(timeout(muted.room.localParticipant.publishTrack(forbiddenTrack, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })), 5000));
  const enforced = await mediaApi.getParticipant(muted.access.epoch, host.auth.playerId);
  assert.equal(enforced.permission.canPublish, false);
  assert.equal(enforced.tracks.length, 0);
  console.log("PASS: the media server rejects publication outside an allowed speaking stage");
  const good = clients.filter(peer => runtime.rooms.getPrivateState(host.auth.roomCode, peer.auth.playerId).side === "good");
  for (let quest = 0; quest < 3; quest++) {
    await waitPhase("team");
    const state = runtime.rooms.getPublicState(host.auth.roomCode);
    const leader = clients.find(peer => peer.auth.playerId === state.leaderId);
    const team = good.slice(0, state.teamSize).map(peer => peer.auth.playerId);
    await send(leader, "team:propose", { team });
    for (const peer of clients.filter(peer => peer !== leader)) await send(peer, "vote:submit", { approved: true });
    for (const peer of clients.filter(peer => team.includes(peer.auth.playerId))) await send(peer, "mission:submit", { failed: false });
    if (quest === 2) break;
    await waitPhase("speech");
    if (quest === 0) {
      const speaker = clients.find(peer => peer.auth.playerId === latest.timer.speakerId);
      const observer = clients.find(peer => peer !== speaker);
      const speaking = await joinMedia(speaker);
      const listening = await joinMedia(observer);
      assert.equal(speaking.access.canSpeak, true);
      assert.equal(listening.access.canSpeak, false);
      assert.notEqual(speaking.access.epoch, first.access.epoch);
      await tone(speaking.room, listening.room);
      console.log("PASS: current-speaker-only publication is audible to another player");
    }
    while (runtime.rooms.getPublicState(host.auth.roomCode).phase === "speech") {
      const speakerId = runtime.rooms.getPublicState(host.auth.roomCode).timer.speakerId;
      await send(clients.find(peer => peer.auth.playerId === speakerId), "speech:end");
    }
  }
  await waitPhase("assassin");
  const evil = clients.find(peer => runtime.rooms.getPrivateState(host.auth.roomCode, peer.auth.playerId).side === "evil");
  const goodPeer = clients.find(peer => runtime.rooms.getPrivateState(host.auth.roomCode, peer.auth.playerId).side === "good");
  const discussion = await joinMedia(evil);
  const audience = await joinMedia(goodPeer);
  assert.equal(discussion.access.canSpeak, true);
  assert.equal(audience.access.canSpeak, false);
  await tone(discussion.room, audience.room);
  console.log("PASS: evil discussion is audible to good listeners without granting them microphone permission");
  await send(host, "room:dissolve");
  host = null;
} finally {
  for (const room of media) await room.disconnect().catch(() => {});
  for (const resource of resources.reverse()) await resource.close().catch(() => {});
  if (host) await send(host, "room:dissolve").catch(() => {});
  clients.forEach(peer => peer.socket.disconnect());
  await runtime.close();
  await new Promise(resolve => sockets.close(resolve));
  await dispose();
}
