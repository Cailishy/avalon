import { randomBytes } from "node:crypto";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { VoiceAccess, VoicePolicy } from "../shared/voice";
import { ROLE_DEFS } from "../shared/game";
import type { RoomManager } from "./roomManager";
import type { VoiceConfig } from "./config";

type Room = NonNullable<ReturnType<RoomManager["getRoom"]>>;
type Entry = { fingerprint: string; name: string; created: boolean; creating?: Promise<unknown> };
export interface VoiceBackend {
  createRoom: (options: { name: string; maxParticipants: number; emptyTimeout: number; departureTimeout: number }) => Promise<unknown>;
  deleteRoom: (name: string) => Promise<unknown>;
  listRooms?: () => Promise<unknown>;
}

export async function checkOptionalVoice(service: VoiceService, required: boolean, warn: (message: string) => void = console.warn): Promise<void> {
  try { await service.ready(); }
  catch (error) {
    if (required) throw error;
    warn("LiveKit is unavailable; the game remains available without live voice.");
  }
}

export function canSpeak(room: Room, playerId: string): boolean {
  if (room.recovery) return false;
  const player = room.players.find(player => player.id === playerId);
  if (!player || player.isAI || !player.connected) return false;
  if (room.phase === "lobby" || room.phase === "result") return true;
  if (room.phase === "speech") return room.timer?.speakerId === playerId;
  return room.phase === "assassin" && !!player.role && ROLE_DEFS[player.role].side === "evil";
}

export class VoiceService {
  private entries = new Map<string, Entry>();
  private backend?: VoiceBackend;
  constructor(private config?: VoiceConfig, backend?: VoiceBackend) {
    if (config) this.backend = backend ?? new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret, { requestTimeout: 5 });
  }

  async ready(): Promise<void> {
    try {
      if (!this.backend?.listRooms) throw new Error("Unavailable");
      await this.backend.listRooms();
    } catch {
      throw new Error("LiveKit readiness check failed. Verify the server URL, credentials, and network before public startup.");
    }
  }

  update(room: Room): boolean {
    const fingerprint = [room.phase, room.timer?.speakerId ?? "", ...room.players.filter(player => !player.isAI && player.connected).map(player => `${player.id}:${canSpeak(room, player.id)}`)].join("|");
    const previous = this.entries.get(room.code);
    if (previous?.fingerprint === fingerprint) return false;
    // A new media room per permission epoch also invalidates the usefulness of old self-hosted JWTs.
    const entry: Entry = { fingerprint, name: `av-${randomBytes(18).toString("hex")}`, created: false };
    this.entries.set(room.code, entry);
    if (previous) void this.retire(previous);
    return true;
  }

  policy(room: Room, playerId: string): VoicePolicy {
    this.update(room);
    return { configured: !!this.config, roomCode: room.code, epoch: this.entries.get(room.code)!.name, canSpeak: canSpeak(room, playerId) };
  }

  async join(room: Room, playerId: string): Promise<VoiceAccess> {
    if (!this.config || !this.backend) throw new Error("语音服务尚未配置。");
    const player = room.players.find(player => player.id === playerId);
    if (!player?.connected || player.isAI) throw new Error("语音会话已失效。");
    const policy = this.policy(room, playerId);
    const entry = this.entries.get(room.code)!;
    if (!entry.creating) entry.creating = this.backend.createRoom({ name: entry.name, maxParticipants: 10, emptyTimeout: 30, departureTimeout: 10 })
      .then(() => { entry.created = true; }).catch(() => { entry.creating = undefined; throw new Error("暂时无法连接语音服务。"); });
    await entry.creating;
    if (this.entries.get(room.code) !== entry || !player.connected) throw new Error("语音阶段已更新，请重试。");
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, { identity: playerId, name: player.name, ttl: 60 });
    token.addGrant({ roomJoin: true, room: entry.name, canSubscribe: true, canPublish: policy.canSpeak,
      canPublishSources: policy.canSpeak ? [TrackSource.MICROPHONE] : [], canPublishData: false,
      canUpdateOwnMetadata: false, roomAdmin: false, roomCreate: false, roomList: false, roomRecord: false });
    return { ...policy, url: this.config.url, token: await token.toJwt() };
  }

  remove(roomCode: string): void {
    const entry = this.entries.get(roomCode);
    this.entries.delete(roomCode);
    if (entry) void this.retire(entry);
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(entry => this.retire(entry)));
  }

  private async retire(entry: Entry): Promise<void> {
    try {
      await entry.creating;
      if (entry.created) await this.backend?.deleteRoom(entry.name);
    } catch {
      // Never include media tokens or participant metadata in logs.
      console.warn("Voice room cleanup deferred to the media server.");
    }
  }
}
