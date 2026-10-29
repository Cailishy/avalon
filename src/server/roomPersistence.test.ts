import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomManager, type JoinResult } from "./roomManager";
import { RoomStore, RoomStorageError } from "./roomStore";
import { snapshotRoom, roomSnapshotSchema } from "./roomSnapshot";
import { RoomPersistence } from "./roomPersistence";
import { CommandCapacityError, RECEIPTS_PER_OWNER, type CommandReceipt } from "./commandReceipt";

const stores: RoomStore[] = [];
const managers: RoomManager[] = [];
let directory: string;
let file: string;
const open = () => { const store = new RoomStore(file); stores.push(store); return store; };
const manager = (changed?: (code: string) => void) => {
  const rooms = new RoomManager(["http://current.test"], changed, { revealDurationMs: 1000, resultDurationMs: 1000, proposalResultDurationMs: 1000 });
  managers.push(rooms);
  return rooms;
};
const game = (rooms: RoomManager) => {
  const host = rooms.createRoom("Host");
  const players = [host, ...Array.from({ length: 4 }, (_, index) => rooms.joinRoom(host.roomCode, `Player${index}`))];
  players.slice(1).forEach(player => rooms.setPlayerReady(host.roomCode, player.playerId, player.sessionToken, true));
  rooms.startRoom(host.roomCode, host.playerId, host.sessionToken);
  vi.advanceTimersByTime(1000);
  return { host, players, code: host.roomCode, room: rooms.getRoom(host.roomCode)! };
};
function restore(rooms: RoomManager, store: RoomStore) {
  const saved = store.load();
  rooms.restoreRooms(saved.rooms, saved.checkpointAt);
  return saved;
}
function rejoin(rooms: RoomManager, players: JoinResult[]) {
  players.forEach(player => rooms.rejoinRoom(player.roomCode, player.playerId, player.sessionToken));
}
function passMission(rooms: RoomManager, players: JoinResult[], code: string) {
  const state = rooms.getPublicState(code);
  const leader = players.find(player => player.playerId === state.leaderId)!;
  const team = players.slice(0, state.teamSize);
  rooms.proposeTeam(code, leader.playerId, leader.sessionToken, team.map(player => player.playerId));
  players.filter(player => player !== leader).forEach(player => rooms.submitVote(code, player.playerId, player.sessionToken, true));
  team.forEach(player => rooms.submitMission(code, player.playerId, player.sessionToken, false));
  vi.advanceTimersByTime(1000);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "awalong-store-"));
  file = join(directory, "rooms.sqlite");
});
afterEach(() => {
  managers.splice(0).forEach(rooms => rooms.close());
  stores.splice(0).forEach(store => store.close());
  vi.clearAllTimers(); vi.useRealTimers();
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("awalong-store-")) throw new Error("Unsafe test cleanup path.");
  rmSync(target, { recursive: true, force: true });
});

describe("Private transactional room storage", () => {
  it("migrates a v1 database without changing player tokens, roles, timers or the entrance signing key", () => {
    const rooms = manager(); const { room } = game(rooms); const store = open();
    const key = store.accessKey("migration-secret");
    const current = snapshotRoom(room, null);
    store.save(current); store.close(); rooms.close();
    const { phaseId: _phase, ...legacy } = current;
    const db = new DatabaseSync(file);
    db.prepare("UPDATE rooms SET snapshot=? WHERE code=?").run(JSON.stringify({ ...legacy, version: 1 }), current.code);
    db.exec("PRAGMA user_version=1"); db.close();
    const migrated = open(); const saved = migrated.load().rooms[0];
    expect(saved).toMatchObject(JSON.parse(JSON.stringify({ version: 2, players: current.players, timer: current.timer, history: current.history })));
    expect(saved.phaseId).toMatch(/^phase_[a-f0-9]{32}$/);
    expect(migrated.accessKey("migration-secret")).toEqual(key);
  });

  it("commits room changes and their receipt in one transaction, rolling both back if receipt insertion fails", () => {
    const rooms = manager(); const host = rooms.createRoom("Host"); const store = open();
    const original = snapshotRoom(rooms.getRoom(host.roomCode)!, null); store.save(original);
    const receipt: CommandReceipt = { owner: "a".repeat(64), requestId: `r_${"b".repeat(32)}`, fingerprint: "c".repeat(64), event: "room:setPlayerCount", expiresAt: Date.now() + 600000, result: { ok: true } };
    (store as unknown as { db: DatabaseSync }).db.exec("CREATE TRIGGER reject_receipts BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT,'test failure'); END");
    expect(() => store.commit([{ code: original.code, snapshot: { ...original, targetPlayerCount: 6 } }], receipt)).toThrow(RoomStorageError);
    expect(store.load().rooms).toEqual([original]);
    expect(store.receipt(receipt.owner, receipt.requestId)).toBeNull();
  });

  it("bounds command receipts without pausing unrelated games when a caller reaches its quota", () => {
    const rooms = manager(); const store = open(); const persistence = new RoomPersistence(rooms, new Map(), store);
    for (let index = 0; index < RECEIPTS_PER_OWNER; index++) {
      store.commit([], { owner: "a".repeat(64), requestId: `r_${index.toString(16).padStart(32, "0")}`, fingerprint: "c".repeat(64), event: "room:create", expiresAt: Date.now() + 600000, result: { ok: false, error: "test" } });
    }
    expect(() => persistence.ensureCommandCapacity("a".repeat(64))).toThrow(CommandCapacityError);
    expect(persistence.healthy).toBe(true);
    expect(() => persistence.ensureCommandCapacity("b".repeat(64))).not.toThrow();
    vi.advanceTimersByTime(600000);
    expect(() => persistence.ensureCommandCapacity("a".repeat(64))).not.toThrow();
  });

  it("uses a single-writer database and keeps the signing key across restart but rotates it on passcode change", () => {
    const first = open();
    const key = first.accessKey("private-passcode");
    expect(() => open()).toThrow(RoomStorageError);
    first.close();
    const second = open();
    expect(second.accessKey("private-passcode")).toEqual(key);
    expect(second.accessKey("different-passcode")).not.toEqual(key);
  });
  it("round-trips real sessions and role allocation, without persisting timer handles or stale deployment URLs", () => {
    const rooms = manager(); const { code, room } = game(rooms); const store = open();
    const original = snapshotRoom(room, "127.0.0.1");
    expect(original.timer).not.toHaveProperty("timeout");
    expect(original).not.toHaveProperty("localUrls");
    store.save(original); store.close();
    const saved = open().load();
    expect(saved.rooms).toEqual([original]);
    expect(saved.checkpointAt).toBe(Date.now());
    expect(saved.rooms[0].code).toBe(code);
  });
  it("rejects malformed snapshots without replacing the last committed state", () => {
    const rooms = manager(); const host = rooms.createRoom("Host"); const store = open();
    const good = snapshotRoom(rooms.getRoom(host.roomCode)!, null); store.save(good);
    expect(() => store.save({ ...good, hostId: "fake" })).toThrow(RoomStorageError);
    expect(store.load().rooms).toEqual([good]);
    expect(roomSnapshotSchema.safeParse({ ...good, players: [...good.players, good.players[0]] }).success).toBe(false);
  });
  it("fails closed for a newer schema or corrupt persisted room instead of silently starting an empty game", () => {
    const store = open(); store.close();
    const db = new DatabaseSync(file); db.exec("PRAGMA user_version=3"); db.close();
    expect(() => open()).toThrow(RoomStorageError);
    const repair = new DatabaseSync(file); repair.exec("PRAGMA user_version=1; INSERT INTO rooms VALUES('ABCDE','not-json')"); repair.close();
    expect(() => open().load()).toThrow(RoomStorageError);
  });
  it("pauses operations and timers after a write failure, without leaking backend error details", () => {
    const rooms = manager(); const store = open();
    const attached = new RoomPersistence(rooms, new Map(), store);
    const { code, room, host } = game(rooms);
    attached.save(code);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "save").mockImplementationOnce(() => { throw new Error("private database details"); });
    expect(() => attached.save(code)).toThrow(RoomStorageError);
    expect(attached.healthy).toBe(false);
    expect(() => rooms.startRoom(code, host.playerId, host.sessionToken)).toThrow("已暂停");
    expect(room.timer).toBeNull();
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private database details");
    logged.mockRestore();
    expect(room.phase).toBe("team");
  });
});

describe("Restart recovery with a bounded reconnect window", () => {
  it("restores a partially voted proposal, preserves private roles, and resumes only the remaining time", () => {
    const original = manager(); const { code, room, players } = game(original);
    const leader = players.find(player => player.playerId === original.getPublicState(code).leaderId)!;
    original.proposeTeam(code, leader.playerId, leader.sessionToken, players.slice(0, 2).map(player => player.playerId));
    const voter = players.find(player => player !== leader)!;
    original.submitVote(code, voter.playerId, voter.sessionToken, false);
    vi.advanceTimersByTime(7000);
    const expectedRoles = players.map(player => original.getPrivateState(code, player.playerId).role);
    const saved = snapshotRoom(room, null); const store = open(); store.save(saved); store.checkpoint();
    original.close(); store.close(); vi.advanceTimersByTime(30000);
    const restored = manager(); restore(restored, open());
    expect(restored.getPublicState(code).timer?.kind).toBe("recovery");
    expect(() => restored.submitVote(code, voter.playerId, voter.sessionToken, true)).toThrow("恢复连接");
    expect(() => restored.rejoinRoom(code, voter.playerId, "invalid-token")).toThrow("会话已失效");
    rejoin(restored, players);
    const state = restored.getPublicState(code);
    expect(state.recovery).toBeUndefined(); expect(state.phase).toBe("vote");
    expect(state.proposal).toEqual(saved.proposal); expect(state.voteSubmitted).toEqual(saved.votes.map(vote => vote[0]));
    expect(state.timer?.deadline).toBe(Date.now() + 23000);
    expect(state.revealedRoles).toEqual([]); expect(state.players[0]).not.toHaveProperty("role");
    expect(players.map(player => restored.getPrivateState(code, player.playerId).role)).toEqual(expectedRoles);
    expect(restored.getPrivateState(code, voter.playerId).canVote).toBe(false);
    vi.advanceTimersByTime(22999); expect(restored.getPublicState(code).phase).toBe("vote");
    vi.advanceTimersByTime(1); expect(restored.getPublicState(code).phase).toBe("mission");
    expect(restored.getPublicState(code).history.filter(entry => entry.type === "vote")).toHaveLength(1);
  });
  it("keeps submitted mission cards secret and prevents duplicate cards after recovery", () => {
    const original = manager(); const { code, players, room } = game(original);
    const leader = players.find(player => player.playerId === original.getPublicState(code).leaderId)!;
    const team = players.slice(0, 2);
    original.proposeTeam(code, leader.playerId, leader.sessionToken, team.map(player => player.playerId));
    players.filter(player => player !== leader).forEach(player => original.submitVote(code, player.playerId, player.sessionToken, true));
    original.submitMission(code, team[0].playerId, team[0].sessionToken, false);
    const store = open(); store.save(snapshotRoom(room, null)); original.close(); store.close();
    const restored = manager(); restore(restored, open()); rejoin(restored, players);
    expect(restored.getPublicState(code).missionSubmitted).toEqual([team[0].playerId]);
    expect(restored.getPublicState(code)).not.toHaveProperty("missionVotes");
    expect(() => restored.submitMission(code, team[0].playerId, team[0].sessionToken, false)).toThrow("已经提交");
    restored.submitMission(code, team[1].playerId, team[1].sessionToken, false);
    expect(restored.getPublicState(code).score.success).toBe(1);
    expect(restored.getPublicState(code).history.filter(entry => entry.type === "mission")).toHaveLength(1);
  });
  it("waits the full reconnect window for missing players before applying their normal offline defaults", () => {
    const original = manager(); const { code, players, room } = game(original);
    const leader = players.find(player => player.playerId === original.getPublicState(code).leaderId)!;
    const teammate = players.find(player => player !== leader)!;
    original.proposeTeam(code, leader.playerId, leader.sessionToken, [leader.playerId, teammate.playerId]);
    const store = open(); store.save(snapshotRoom(room, null)); original.close(); store.close();
    const restored = manager(); restore(restored, open()); rejoin(restored, [leader]);
    vi.advanceTimersByTime(59999);
    expect(restored.getPublicState(code).recovery).toBeDefined();
    expect(restored.getPublicState(code).phase).toBe("vote");
    expect(restored.getPublicState(code).voteSubmitted).toEqual([leader.playerId]);
    vi.advanceTimersByTime(1);
    const state = restored.getPublicState(code);
    expect(state.recovery).toBeUndefined();
    expect(state.phase).toBe("mission");
    expect(state.players.filter(player => player.connected).map(player => player.id)).toEqual([leader.playerId]);
    expect(state.missionSubmitted).toEqual([teammate.playerId]);
    expect(restored.getPrivateState(code, leader.playerId).canMission).toBe(true);
    expect(state.history.filter(entry => entry.type === "vote")).toHaveLength(1);
  });
  it("preserves the current speaker and the assassination discussion clock", () => {
    const original = manager(); const { code, players, room } = game(original);
    passMission(original, players, code);
    const speaker = players.find(player => player.playerId === original.getPublicState(code).timer?.speakerId)!;
    original.endSpeech(code, speaker.playerId, speaker.sessionToken);
    const currentSpeaker = original.getPublicState(code).timer?.speakerId;
    const store = open(); store.save(snapshotRoom(room, null)); original.close(); store.close();
    const restored = manager(); const reopened = open(); restore(restored, reopened); rejoin(restored, players);
    expect(restored.getPublicState(code).timer?.speakerId).toBe(currentSpeaker);
    while (restored.getPublicState(code).phase === "speech") {
      const speaking = players.find(player => player.playerId === restored.getPublicState(code).timer?.speakerId)!;
      restored.endSpeech(code, speaking.playerId, speaking.sessionToken);
    }
    for (let quest = 1; quest < 3; quest++) {
      passMission(restored, players, code);
      while (restored.getPublicState(code).phase === "speech") {
        const speaking = players.find(player => player.playerId === restored.getPublicState(code).timer?.speakerId)!;
        restored.endSpeech(code, speaking.playerId, speaking.sessionToken);
      }
    }
    expect(restored.getPublicState(code).phase).toBe("assassin");
    vi.advanceTimersByTime(15000); reopened.save(snapshotRoom(restored.getRoom(code)!, null)); restored.close(); reopened.close();
    vi.advanceTimersByTime(20000);
    const last = manager(); restore(last, open()); rejoin(last, players);
    expect(last.getPublicState(code).timer?.deadline).toBe(Date.now() + 105000);
    expect(last.getPublicState(code).revealedRoles.every(role => role.side === "evil")).toBe(true);
  });
  it("does not reset the reconnect window after another restart, and removes stale rooms", () => {
    const original = manager(); const host = original.createRoom("Host"); const store = open();
    store.save(snapshotRoom(original.getRoom(host.roomCode)!, null)); original.close(); store.close();
    const second = manager(); const secondStore = open(); restore(second, secondStore);
    const deadline = second.getPublicState(host.roomCode).recovery!.deadline;
    vi.advanceTimersByTime(20000); secondStore.save(snapshotRoom(second.getRoom(host.roomCode)!, null)); second.close(); secondStore.close();
    const third = manager(); const thirdStore = open(); restore(third, thirdStore);
    expect(third.getPublicState(host.roomCode).recovery!.deadline).toBe(deadline);
    vi.advanceTimersByTime(40000); expect(third.getRoom(host.roomCode)).toBeNull();
    third.close(); thirdStore.close(); vi.advanceTimersByTime(600000);
    const fourth = manager(); const saved = open().load();
    expect(fourth.restoreRooms(saved.rooms, saved.checkpointAt)).toEqual([host.roomCode]);
    expect(fourth.roomCodes()).toEqual([]);
  });
});
