import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomManager } from "./roomManager";

let manager: RoomManager;
beforeEach(() => { vi.useFakeTimers(); manager = new RoomManager([], undefined, {}, { maxRooms: 2, offlineTtlMs: 1000, resultTtlMs: 2000, codeLength: 8 }); });
afterEach(() => { manager.close(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("Room resource lifecycle", () => {
  it("caps rooms and uses longer public invitation codes", () => {
    expect(manager.createRoom("A").roomCode).toMatch(/^[A-F0-9]{8}$/);
    manager.createRoom("B");
    expect(() => manager.createRoom("C")).toThrow("房间已达上限");
  });
  it("expires all-human-offline games even when AI players remain connected", () => {
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    manager.disconnectPlayer(host.playerId);
    vi.advanceTimersByTime(999);
    expect(manager.cleanupExpiredRooms()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(manager.cleanupExpiredRooms()).toMatchObject([{ code: host.roomCode, playerIds: expect.arrayContaining([host.playerId]) }]);
    expect(manager.getRoom(host.roomCode)).toBeNull();
    expect(() => manager.rejoinRoom(host.roomCode, host.playerId, host.sessionToken)).toThrow("房间不存在");
    expect(manager.createRoom("Replacement")).toBeDefined();
  });
  it("cancels offline expiry when a real player reconnects", () => {
    const host = manager.createRoom("Host");
    manager.disconnectPlayer(host.playerId);
    vi.advanceTimersByTime(500);
    manager.syncPlayerSession(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(1000);
    expect(manager.cleanupExpiredRooms()).toEqual([]);
    expect(manager.getRoom(host.roomCode)).not.toBeNull();
  });
  it("expires completed rooms even if players remain online", () => {
    const host = manager.createRoom("Host");
    const room = manager.getRoom(host.roomCode)!;
    room.phase = "result";
    room.completedAt = Date.now();
    vi.advanceTimersByTime(2000);
    expect(manager.cleanupExpiredRooms()).toHaveLength(1);
    expect(manager.getRoom(host.roomCode)).toBeNull();
  });
  it("does not expire a restarted lobby using the previous game's completion time", () => {
    const host = manager.createRoom("Host");
    const room = manager.getRoom(host.roomCode)!;
    room.phase = "result";
    room.completedAt = Date.now();
    vi.advanceTimersByTime(1500);
    manager.restartRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(1000);
    expect(manager.cleanupExpiredRooms()).toEqual([]);
    expect(manager.getRoom(host.roomCode)).toMatchObject({ phase: "lobby", completedAt: null });
  });
  it("rejects non-boolean domain choices without coercion", () => {
    const host = manager.createRoom("Host");
    expect(() => manager.setPlayerReady(host.roomCode, host.playerId, host.sessionToken, "false" as never)).toThrow("状态无效");
    expect(() => manager.submitVote(host.roomCode, host.playerId, host.sessionToken, "false" as never)).toThrow("选项无效");
    expect(() => manager.submitMission(host.roomCode, host.playerId, host.sessionToken, {} as never)).toThrow("选项无效");
  });
});
