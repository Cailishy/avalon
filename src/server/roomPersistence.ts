import type { RoomManager } from "./roomManager";
import { snapshotRoom } from "./roomSnapshot";
import { RoomStorageError, type RoomStore } from "./roomStore";
import { CommandCapacityError, MAX_RECEIPTS, RECEIPTS_PER_OWNER, type CommandReceipt } from "./commandReceipt";

export class RoomPersistence {
  healthy = true;
  private receipts = new Map<string, CommandReceipt>();
  constructor(private rooms: RoomManager, private origins: Map<string, string>, private store?: RoomStore) {
    if (!store) return;
    const saved = store.load();
    const expired = rooms.restoreRooms(saved.rooms, saved.checkpointAt);
    for (const code of expired) store.remove(code);
    for (const snapshot of saved.rooms) {
      if (!rooms.getRoom(snapshot.code)) continue;
      if (snapshot.origin) origins.set(snapshot.code, snapshot.origin);
      this.save(snapshot.code);
    }
  }

  save(code: string): void {
    if (!this.store) return;
    if (!this.healthy) throw new RoomStorageError();
    try {
      const room = this.rooms.getRoom(code);
      if (room) this.store.save(snapshotRoom(room, this.origins.get(code) ?? null));
      else this.store.remove(code);
    } catch {
      this.fail();
      throw new RoomStorageError();
    }
  }

  checkpoint(): void {
    if (!this.store || !this.healthy || !this.rooms.roomCodes().length) return;
    try { this.store.checkpoint(); }
    catch { this.fail(); }
  }

  receipt(owner: string, requestId: string): CommandReceipt | null {
    return this.protect(() => {
      if (this.store) return this.store.receipt(owner, requestId);
      const receipt = this.receipts.get(`${owner}:${requestId}`);
      return receipt && receipt.expiresAt > Date.now() ? receipt : null;
    });
  }

  ensureCommandCapacity(owner: string): void {
    this.protect(() => {
      if (this.store) return this.store.ensureCommandCapacity(owner);
      for (const [key, receipt] of this.receipts) if (receipt.expiresAt <= Date.now()) this.receipts.delete(key);
      if (this.receipts.size >= MAX_RECEIPTS || [...this.receipts.values()].filter(receipt => receipt.owner === owner).length >= RECEIPTS_PER_OWNER) throw new CommandCapacityError();
    });
  }

  commit(codes: Iterable<string>, receipt: CommandReceipt): void {
    this.protect(() => {
      if (this.store) this.store.commit([...codes].map(code => {
        const room = this.rooms.getRoom(code);
        return { code, snapshot: room ? snapshotRoom(room, this.origins.get(code) ?? null) : null };
      }), receipt);
      else this.receipts.set(`${receipt.owner}:${receipt.requestId}`, receipt);
    });
  }

  close(): void {
    if (!this.store) return;
    try {
      if (this.healthy) {
        for (const code of this.rooms.roomCodes()) this.save(code);
        this.store.checkpoint();
      }
    } catch { this.fail(); }
    finally { this.store.close(); }
  }

  private fail(): void {
    if (!this.healthy) return;
    this.healthy = false;
    this.rooms.halt();
    console.error("Room storage failed; game commands and timers have been paused. Check disk space, permissions and database integrity.");
  }

  private protect<T>(action: () => T): T {
    if (!this.healthy) throw new RoomStorageError();
    try { return action(); }
    catch (error) {
      if (error instanceof CommandCapacityError) throw error;
      this.fail();
      throw new RoomStorageError();
    }
  }
}
