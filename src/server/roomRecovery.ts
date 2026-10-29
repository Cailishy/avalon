import type { RoomSnapshot, SavedTimer } from "./roomSnapshot";
import type { RoomInternal } from "./roomTypes";

export interface RoomRecoveryState {
  deadline: number;
  remainingMs: number;
  timer: SavedTimer | null;
  expectedPlayerIds: string[];
  timeout: NodeJS.Timeout;
}

export class RoomRecovery {
  constructor(private resume: (room: RoomInternal, timer: SavedTimer | null, remainingMs: number) => void) {}

  begin(room: RoomInternal, snapshot: RoomSnapshot, checkpointAt: number, graceMs = 60000): void {
    const now = Date.now();
    const saved = snapshot.recovery;
    const timer = saved?.timer ?? snapshot.timer;
    const remainingMs = saved?.remainingMs ?? Math.min(timer?.durationMs ?? 0, Math.max(0, (timer?.deadline ?? checkpointAt) - checkpointAt));
    const expectedPlayerIds = saved?.expectedPlayerIds ?? snapshot.players.filter(player => !player.isAI && player.connected).map(player => player.id);
    const deadline = saved?.deadline ?? now + graceMs;
    room.players.forEach(player => { if (!player.isAI) player.connected = false; });
    room.idleSince ??= Math.min(now, checkpointAt);
    const timeout = setTimeout(() => this.finish(room), Math.max(0, deadline - now));
    timeout.unref();
    room.recovery = { deadline, remainingMs, timer, expectedPlayerIds, timeout };
  }

  reconnected(room: RoomInternal): void {
    const recovery = room.recovery;
    if (recovery && recovery.expectedPlayerIds.every(id => room.players.some(player => player.id === id && player.connected))) this.finish(room);
  }

  cancel(room: RoomInternal): void {
    if (!room.recovery) return;
    clearTimeout(room.recovery.timeout);
    delete room.recovery;
  }

  private finish(room: RoomInternal): void {
    const recovery = room.recovery;
    if (!recovery) return;
    this.cancel(room);
    this.resume(room, recovery.timer, recovery.remainingMs);
  }
}
