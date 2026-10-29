import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseRoomSnapshot, roomSnapshotSchema, type RoomSnapshot } from "./roomSnapshot";
import { CommandCapacityError, MAX_RECEIPTS, RECEIPTS_PER_OWNER, receiptSchema, type CommandReceipt } from "./commandReceipt";

export class RoomStorageError extends Error {
  constructor() { super("Room storage is unavailable; the game is paused to protect saved state."); }
}

export interface StoredRooms { rooms: RoomSnapshot[]; checkpointAt: number }
export interface RoomChange { code: string; snapshot: RoomSnapshot | null }

export class RoomStore {
  private db!: DatabaseSync;
  private cache = new Map<string, string>();
  private closed = false;

  constructor(file: string) {
    const memory = file === ":memory:";
    const path = memory ? file : resolve(file);
    try {
      if (!memory) {
        const directory = dirname(path);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (lstatSync(directory).isSymbolicLink() || (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))) throw new RoomStorageError();
        chmodSync(directory, 0o700);
      }
      this.db = new DatabaseSync(path, { allowExtension: false });
      this.db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=32768;");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new RoomStorageError();
      this.transaction(() => {
        this.db.exec("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (owner TEXT NOT NULL, request_id TEXT NOT NULL, expires_at INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(owner, request_id)); CREATE INDEX IF NOT EXISTS commands_expiry ON commands(expires_at);");
        if (Number(this.db.prepare("SELECT count(*) AS count FROM rooms").get()?.count) > 200) throw new RoomStorageError();
        for (const row of this.db.prepare("SELECT code,snapshot FROM rooms").all()) {
          const snapshot = this.parseSnapshot(row.snapshot);
          if (snapshot.code !== row.code) throw new RoomStorageError();
          this.db.prepare("UPDATE rooms SET snapshot=? WHERE code=?").run(JSON.stringify(snapshot), snapshot.code);
        }
        this.db.exec("PRAGMA user_version=2");
      });
      if (!memory) chmodSync(path, 0o600);
    } catch {
      this.db?.close();
      throw new RoomStorageError();
    }
  }

  load(): StoredRooms {
    return this.protect(() => {
      const count = Number(this.db.prepare("SELECT count(*) AS count FROM rooms").get()?.count);
      if (count > 200) throw new RoomStorageError();
      const rooms = this.db.prepare("SELECT code, snapshot FROM rooms ORDER BY code").all().map(row => {
        const snapshot = this.parseSnapshot(row.snapshot);
        if (snapshot.code !== row.code) throw new RoomStorageError();
        this.cache.set(snapshot.code, JSON.stringify(snapshot));
        return snapshot;
      });
      const checkpointAt = Number(this.metadata("checkpointAt") ?? 0);
      if (!Number.isSafeInteger(checkpointAt) || checkpointAt < 0 || (rooms.length > 0 && checkpointAt === 0)) throw new RoomStorageError();
      return { rooms, checkpointAt };
    });
  }

  save(room: RoomSnapshot): void {
    this.commit([{ code: room.code, snapshot: room }]);
  }

  remove(code: string): void {
    this.commit([{ code, snapshot: null }]);
  }

  commit(changes: RoomChange[], receipt?: CommandReceipt): void {
    this.protect(() => {
      const rows = changes.map(({ code, snapshot }) => {
        if (!/^[A-F0-9]{5,8}$/.test(code) || (snapshot && snapshot.code !== code)) throw new RoomStorageError();
        const json = snapshot ? JSON.stringify(roomSnapshotSchema.parse(snapshot)) : null;
        if (json && Buffer.byteLength(json) > 262144) throw new RoomStorageError();
        return { code, json };
      }).filter(row => row.json === null || this.cache.get(row.code) !== row.json);
      const command = receipt ? receiptSchema.parse(receipt) : null;
      if (!rows.length && !command) return;
      this.transaction(() => {
        for (const { code, json } of rows) {
          if (json === null) this.db.prepare("DELETE FROM rooms WHERE code=?").run(code);
          else this.db.prepare("INSERT INTO rooms(code,snapshot) VALUES(?,?) ON CONFLICT(code) DO UPDATE SET snapshot=excluded.snapshot").run(code, json);
        }
        if (command) this.db.prepare("INSERT INTO commands(owner,request_id,expires_at,receipt) VALUES(?,?,?,?)").run(command.owner, command.requestId, command.expiresAt, JSON.stringify(command));
        this.setMetadata("checkpointAt", String(Date.now()));
      });
      for (const { code, json } of rows) {
        if (json === null) this.cache.delete(code);
        else this.cache.set(code, json);
      }
    });
  }

  receipt(owner: string, requestId: string): CommandReceipt | null {
    return this.protect(() => {
      const row = this.db.prepare("SELECT receipt FROM commands WHERE owner=? AND request_id=? AND expires_at>?").get(owner, requestId, Date.now());
      if (!row) return null;
      if (typeof row.receipt !== "string" || Buffer.byteLength(row.receipt) > 8192) throw new RoomStorageError();
      const receipt = receiptSchema.parse(JSON.parse(row.receipt));
      if (receipt.owner !== owner || receipt.requestId !== requestId) throw new RoomStorageError();
      return receipt;
    });
  }

  ensureCommandCapacity(owner: string): void {
    this.protect(() => {
      this.db.prepare("DELETE FROM commands WHERE expires_at<=?").run(Date.now());
      const total = Number(this.db.prepare("SELECT count(*) AS count FROM commands").get()?.count);
      const own = Number(this.db.prepare("SELECT count(*) AS count FROM commands WHERE owner=?").get(owner)?.count);
      if (total >= MAX_RECEIPTS || own >= RECEIPTS_PER_OWNER) throw new CommandCapacityError();
    });
  }

  checkpoint(): void {
    this.protect(() => this.setMetadata("checkpointAt", String(Date.now())));
  }

  accessKey(passcode: string): Buffer {
    return this.protect(() => {
      const fingerprint = createHash("sha256").update(passcode).digest("hex");
      const previous = this.metadata("accessKey");
      if (this.metadata("accessFingerprint") === fingerprint && previous) {
        const key = Buffer.from(previous, "base64");
        if (key.length !== 32) throw new RoomStorageError();
        return key;
      }
      const key = randomBytes(32);
      this.transaction(() => { this.setMetadata("accessFingerprint", fingerprint); this.setMetadata("accessKey", key.toString("base64")); });
      return key;
    });
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private metadata(key: string): string | undefined {
    const value = this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value;
    return typeof value === "string" ? value : undefined;
  }
  private setMetadata(key: string, value: string): void {
    this.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  private transaction(action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { action(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private protect<T>(action: () => T): T {
    try { if (this.closed) throw new RoomStorageError(); return action(); }
    catch (error) { if (error instanceof CommandCapacityError) throw error; throw new RoomStorageError(); }
  }
  private parseSnapshot(value: unknown): RoomSnapshot {
    if (typeof value !== "string" || Buffer.byteLength(value) > 262144) throw new RoomStorageError();
    return parseRoomSnapshot(JSON.parse(value));
  }
}
