import { describe, expect, it } from "vitest";
import type { PrivatePlayerState, PublicRoomState } from "../../shared/game";
import { ServerStateStore } from "./serverState";

function publicState(revision: number, phase = "team"): PublicRoomState {
  return {
    roomCode: "ABCDE", revision, phaseId: `phase_${revision}`, phase: phase as PublicRoomState["phase"], players: [],
    hostId: "p_1", targetPlayerCount: 5, localUrls: [], leaderId: null, questIndex: 0, teamSize: 2,
    requiredFails: 1, rejectCount: 0, score: { success: 0, fail: 0 }, proposal: [], voteSubmitted: [],
    missionSubmitted: [], history: [], winner: null, winnerReason: "", revealedRoles: [], servantCounts: null,
    speechOrder: [], timer: null,
  };
}

const privateState: PrivatePlayerState = {
  playerId: "p_1", role: null, roleName: null, side: null, servantVariant: null, roleText: "", knowledge: "",
  canPropose: false, canVote: false, canMission: false, canFailMission: false, canAssassinate: false,
};

describe("ServerStateStore", () => {
  it("rejects an older public revision from the same room", () => {
    const store = new ServerStateStore();
    expect(store.applyPublic(publicState(4)).accepted).toBe(true);
    expect(store.applyPublic(publicState(3)).accepted).toBe(false);
    expect(store.publicState?.revision).toBe(4);
  });

  it("accepts a new room even when its revision starts at zero", () => {
    const store = new ServerStateStore();
    store.applyPublic(publicState(8));
    expect(store.applyPublic({ ...publicState(0), roomCode: "FFFFF" }).accepted).toBe(true);
    expect(store.publicState?.roomCode).toBe("FFFFF");
  });

  it("keeps late packets from the old instance out after a room code is reused", () => {
    const store = new ServerStateStore();
    store.applyPublic({ ...publicState(8), instanceId: "a".repeat(32) });
    expect(store.applyPublic({ ...publicState(0), instanceId: "b".repeat(32) }).accepted).toBe(true);
    expect(store.applyPublic({ ...publicState(8), instanceId: "a".repeat(32) }).accepted).toBe(false);
  });

  it("accepts a new instance with a higher revision than the previous instance", () => {
    const store = new ServerStateStore();
    store.applyPublic({ ...publicState(2), instanceId: "a".repeat(32) });
    expect(store.applyPublic({ ...publicState(9), instanceId: "b".repeat(32) }).accepted).toBe(true);
    expect(store.publicState?.instanceId).toBe("b".repeat(32));
  });

  it.each([0, 1, 9])("rejects a retired instance at revision %i even after the current instance advances", revision => {
    const store = new ServerStateStore();
    store.applyPublic({ ...publicState(9), instanceId: "a".repeat(32) });
    store.applyPublic({ ...publicState(0), instanceId: "b".repeat(32) });
    store.applyPublic({ ...publicState(10), instanceId: "b".repeat(32) });
    expect(store.applyPublic({ ...publicState(revision), instanceId: "a".repeat(32) }).accepted).toBe(false);
    expect(store.publicState?.instanceId).toBe("b".repeat(32));
  });

  it("rejects a public snapshot from another room while a player session is bound", () => {
    const store = new ServerStateStore({ roomCode: "ABCDE", playerId: "p_1", sessionToken: "s_1", name: "Player" });
    store.applyPublic(publicState(4));
    expect(store.applyPublic({ ...publicState(10), roomCode: "FFFFF" }).accepted).toBe(false);
    expect(store.publicState?.roomCode).toBe("ABCDE");
  });

  it("ignores late private snapshots belonging to a previous player", () => {
    const store = new ServerStateStore({ roomCode: "ABCDE", playerId: "p_2", sessionToken: "s_2", name: "Player" });
    store.applyPrivate({ ...privateState, playerId: "p_2" });
    expect(store.applyPrivate({ ...privateState, role: "merlin", roleName: "梅林" })).toMatchObject({ changed: false });
    expect(store.privateState?.playerId).toBe("p_2");
    expect(store.privateState?.role).toBeNull();
  });

  it("discards old snapshots when a different session is confirmed", () => {
    const store = new ServerStateStore();
    store.applyPublic(publicState(4));
    store.applyPrivate(privateState);
    store.identity = { roomCode: "FFFFF", playerId: "p_2", sessionToken: "s_2", name: "Player" };
    expect(store.publicState).toBeNull();
    expect(store.privateState).toBeNull();
  });

  it("reports private role arrival without owning UI side effects", () => {
    const store = new ServerStateStore();
    expect(store.applyPrivate(privateState)).toEqual({ accepted: true, changed: true, hadRole: false });
    expect(store.applyPrivate(privateState)).toEqual({ accepted: true, changed: false, hadRole: false });
  });
});
