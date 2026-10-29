import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";
import { RoomManager } from "./roomManager";
import { VoiceService, canSpeak, checkOptionalVoice } from "./voice";

const config = { url: "wss://voice.example.com", apiUrl: "https://voice.example.com", apiKey: "test-key", apiSecret: "s".repeat(40) };
const managers: RoomManager[] = [];
afterEach(() => { managers.forEach(manager => manager.close()); managers.length = 0; });
function setup() {
  const manager = new RoomManager([]);
  managers.push(manager);
  const host = manager.createRoom("Host");
  const other = manager.joinRoom(host.roomCode, "Other");
  const room = manager.getRoom(host.roomCode)!;
  const backend = { createRoom: vi.fn(async () => {}), deleteRoom: vi.fn(async () => {}) };
  return { manager, host, other, room, backend, voice: new VoiceService(config, backend) };
}

describe("Server-authoritative audio", () => {
  it("keeps optional voice outages from blocking the base game, with an opt-in strict mode", async () => {
    const service = new VoiceService();
    const warn = vi.fn();
    await expect(checkOptionalVoice(service, false, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("LiveKit is unavailable; the game remains available without live voice.");
    await expect(checkOptionalVoice(service, true, warn)).rejects.toThrow("readiness check failed");
  });
  it("checks media readiness before public startup without exposing backend errors", async () => {
    const { backend } = setup();
    const listRooms = vi.fn(async () => []);
    const voice = new VoiceService(config, { ...backend, listRooms });
    await voice.ready();
    expect(listRooms).toHaveBeenCalledOnce();
    listRooms.mockRejectedValueOnce(new Error("private API secret"));
    await expect(voice.ready()).rejects.toThrow("readiness check failed");
    await expect(new VoiceService().ready()).rejects.not.toThrow("private API secret");
  });
  it("only lets the current speaker publish, and only evil speak during public assassination discussion", () => {
    const { room, host, other } = setup();
    room.players[0].role = "assassin";
    room.players[1].role = "merlin";
    expect(canSpeak(room, host.playerId)).toBe(true);
    for (const phase of ["reveal", "team", "vote", "mission", "missionResult", "proposalResult"] as const) {
      room.phase = phase;
      expect(canSpeak(room, host.playerId)).toBe(false);
    }
    room.phase = "speech";
    room.timer = { kind: "speech", deadline: Date.now() + 60_000, durationMs: 60_000, label: "发言", speakerId: other.playerId, timeout: setTimeout(() => {}, 100_000) };
    expect(canSpeak(room, host.playerId)).toBe(false);
    expect(canSpeak(room, other.playerId)).toBe(true);
    room.phase = "assassin";
    expect(canSpeak(room, host.playerId)).toBe(true);
    expect(canSpeak(room, other.playerId)).toBe(false);
  });
  it("issues only short-lived, room-scoped microphone grants; listeners cannot publish", async () => {
    const { room, host, other, voice, backend } = setup();
    room.phase = "assassin";
    room.players[0].role = "assassin";
    room.players[1].role = "merlin";
    const access = await voice.join(room, host.playerId);
    const listen = await voice.join(room, other.playerId);
    const verify = new TokenVerifier(config.apiKey, config.apiSecret);
    const speaker = await verify.verify(access.token);
    const listener = await verify.verify(listen.token);
    expect(speaker.sub).toBe(host.playerId);
    expect(speaker.video).toMatchObject({ canPublish: true, canPublishSources: ["microphone"], canPublishData: false, roomAdmin: false, roomRecord: false, canSubscribe: true });
    expect(listener.video).toMatchObject({ canPublish: false, canPublishSources: [], canSubscribe: true });
    expect(speaker.video?.room).toBe(listener.video?.room);
    expect(Number(speaker.exp) - Number(speaker.nbf)).toBeLessThanOrEqual(60);
    expect(backend.createRoom).toHaveBeenCalledOnce();
    await voice.close();
  });
  it("rotates media rooms on phase, speaker and membership changes, but not on unchanged snapshots", async () => {
    const { room, host, other, voice, backend } = setup();
    const first = await voice.join(room, host.playerId);
    expect(voice.policy(room, host.playerId).epoch).toBe(first.epoch);
    room.phase = "team";
    const next = voice.policy(room, host.playerId);
    expect(next.epoch).not.toBe(first.epoch);
    await Promise.resolve(); await Promise.resolve();
    expect(backend.deleteRoom).toHaveBeenCalledWith(first.epoch);
    room.players.find(player => player.id === other.playerId)!.connected = false;
    expect(voice.policy(room, host.playerId).epoch).not.toBe(next.epoch);
    await voice.close();
  });
  it("does not return a token if the phase changes while the media backend is pending", async () => {
    const { room, host, voice, backend } = setup();
    let finish!: () => void;
    backend.createRoom.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = voice.join(room, host.playerId);
    room.phase = "team";
    voice.update(room);
    finish();
    await expect(pending).rejects.toThrow("阶段已更新");
    await voice.close();
  });
  it("rejects absent/offline/AI members and fails safely without a media backend", async () => {
    const { room, host, voice } = setup();
    await expect(new VoiceService().join(room, host.playerId)).rejects.toThrow("尚未配置");
    room.players[0].connected = false;
    await expect(voice.join(room, host.playerId)).rejects.toThrow("会话已失效");
    expect(canSpeak(room, host.playerId)).toBe(false);
    room.players[0].connected = true;
    room.players[0].isAI = true;
    await expect(voice.join(room, host.playerId)).rejects.toThrow("会话已失效");
  });
});
