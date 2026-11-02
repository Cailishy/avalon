import { describe, expect, it, vi } from "vitest";
import { RoomApplicationService } from "./roomApplicationService";
import type { CommandTransaction } from "./contracts";
import type { RoomCommandPort } from "./roomPorts";
import { COMMAND_EVENTS, type CommandEvent } from "../../shared/protocol";

const code = "ABCDE";
const auth = [code, "p_1", "s_1"] as const;
const joined = { roomCode: code, playerId: "p_1", sessionToken: "s_1" };
const removed = { id: "p_2", name: "Guest" };
interface MutationCase {
  event: CommandEvent;
  method: keyof RoomCommandPort;
  args: unknown[];
  run: (service: RoomApplicationService, tx: CommandTransaction) => unknown;
  result?: unknown;
  simulate?: boolean;
}
const mutations: MutationCase[] = [
  { event: "room:create", method: "createRoom", args: ["Host", 6], result: joined, run: (s, tx) => s.createRoom("Host", 6, tx) },
  { event: "room:join", method: "joinRoom", args: [code, "Guest"], result: joined, run: (s, tx) => s.joinRoom(code, "Guest", tx) },
  { event: "room:addAI", method: "addAIPlayers", args: [...auth, 4], run: (s, tx) => s.addAIPlayers(...auth, 4, tx) },
  { event: "room:setPlayerCount", method: "setTargetPlayerCount", args: [...auth, 6], run: (s, tx) => s.setTargetPlayerCount(...auth, 6, tx) },
  { event: "player:setReady", method: "setPlayerReady", args: [...auth, false], run: (s, tx) => s.setPlayerReady(...auth, false, tx) },
  { event: "room:start", method: "startRoom", args: [...auth], simulate: true, run: (s, tx) => s.startRoom(...auth, tx) },
  { event: "player:kick", method: "kickPlayer", args: [...auth, "p_2"], result: removed, run: (s, tx) => s.kickPlayer(...auth, "p_2", tx) },
  { event: "room:dissolve", method: "dissolveRoom", args: [...auth], result: [removed], run: (s, tx) => s.dissolveRoom(...auth, tx) },
  { event: "room:restart", method: "restartRoom", args: [...auth], run: (s, tx) => s.restartRoom(...auth, tx) },
  { event: "room:leave", method: "leaveRoom", args: [...auth], result: code, simulate: true, run: (s, tx) => s.leaveRoom(...auth, tx) },
  { event: "team:propose", method: "proposeTeam", args: [...auth, ["p_1", "p_2"], 3], simulate: true, run: (s, tx) => s.proposeTeam(...auth, ["p_1", "p_2"], 3, tx) },
  { event: "vote:submit", method: "submitVote", args: [...auth, false], simulate: true, run: (s, tx) => s.submitVote(...auth, false, tx) },
  { event: "mission:submit", method: "submitMission", args: [...auth, true], simulate: true, run: (s, tx) => s.submitMission(...auth, true, tx) },
  { event: "assassin:choose", method: "chooseAssassinTarget", args: [...auth, "p_2"], run: (s, tx) => s.chooseAssassinTarget(...auth, "p_2", tx) },
  { event: "speech:end", method: "endSpeech", args: [...auth], simulate: true, run: (s, tx) => s.endSpeech(...auth, tx) },
];

function transaction(): CommandTransaction & { changed: string[]; effects: (() => void)[] } {
  const changed: string[] = [];
  const effects: (() => void)[] = [];
  return {
    changed,
    effects,
    markRoomChanged: code => changed.push(code),
    afterCommit: effect => effects.push(effect),
  };
}

describe("RoomApplicationService", () => {
  it("covers every public mutation command", () => {
    expect(new Set(mutations.map(item => item.event))).toEqual(new Set(COMMAND_EVENTS));
  });

  it.each(mutations)("preserves $event arguments, results and commit ordering", item => {
    const method = vi.fn(() => item.result);
    const simulateAI = vi.fn();
    const service = new RoomApplicationService({ [item.method]: method, simulateAI } as unknown as RoomCommandPort);
    const tx = transaction();

    expect(item.run(service, tx)).toEqual(item.result);
    expect(method).toHaveBeenCalledExactlyOnceWith(...item.args);
    expect(new Set(tx.changed)).toEqual(new Set([code]));
    expect(simulateAI).not.toHaveBeenCalled();
    expect(tx.effects).toHaveLength(item.simulate ? 1 : 0);
    tx.effects.forEach(effect => effect());
    if (item.simulate) expect(simulateAI).toHaveBeenCalledExactlyOnceWith(code);
  });

  it.each(mutations)("does not mark or schedule a rejected $event", item => {
    const method = vi.fn(() => { throw new Error("Rejected command"); });
    const simulateAI = vi.fn();
    const service = new RoomApplicationService({ [item.method]: method, simulateAI } as unknown as RoomCommandPort);
    const tx = transaction();

    expect(() => item.run(service, tx)).toThrow("Rejected command");
    expect(tx.changed).toEqual([]);
    expect(tx.effects).toEqual([]);
    expect(simulateAI).not.toHaveBeenCalled();
  });

  it("marks a deleted room without scheduling AI when its last player leaves", () => {
    const simulateAI = vi.fn();
    const service = new RoomApplicationService({ leaveRoom: vi.fn(() => null), simulateAI } as unknown as RoomCommandPort);
    const tx = transaction();

    expect(service.leaveRoom(...auth, tx)).toBeNull();
    expect(tx.changed).toEqual([code]);
    expect(tx.effects).toEqual([]);
    expect(simulateAI).not.toHaveBeenCalled();
  });

  it("delegates authenticated session and runtime operations without changing their results", () => {
    const synced = { result: joined, connectedChanged: true };
    const rooms = {
      syncPlayerSession: vi.fn(() => synced),
      validatePlayerSession: vi.fn(),
      disconnectPlayer: vi.fn(() => code),
      removeDisconnectedLobbyPlayer: vi.fn(() => code),
      markChanged: vi.fn(),
      simulateAI: vi.fn(),
    } as unknown as RoomCommandPort;
    const publisher = { publish: vi.fn() };
    const service = new RoomApplicationService(rooms, publisher);

    expect(service.syncPlayerSession(...auth)).toBe(synced);
    service.validatePlayerSession(...auth);
    expect(rooms.syncPlayerSession).toHaveBeenCalledExactlyOnceWith(...auth);
    expect(rooms.validatePlayerSession).toHaveBeenCalledExactlyOnceWith(...auth);
    expect(service.disconnectPlayer("p_1")).toBe(code);
    expect(rooms.disconnectPlayer).toHaveBeenCalledExactlyOnceWith("p_1");
    expect(service.removeDisconnectedLobbyPlayer("p_1")).toBe(code);
    expect(rooms.removeDisconnectedLobbyPlayer).toHaveBeenCalledExactlyOnceWith("p_1");
    service.markChanged(code);
    service.simulateAI(code);
    service.publishRoomState(code);
    expect(rooms.markChanged).toHaveBeenCalledExactlyOnceWith(code);
    expect(rooms.simulateAI).toHaveBeenCalledExactlyOnceWith(code);
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(code);
  });

  it("marks a created room for the command transaction", () => {
    const rooms = {
      createRoom: vi.fn(() => ({ roomCode: "ABCDE", playerId: "p_1", sessionToken: "s_1" })),
    } as unknown as RoomCommandPort;
    const service = new RoomApplicationService(rooms);
    const tx = transaction();

    expect(service.createRoom("房主", 5, tx).roomCode).toBe("ABCDE");
    expect(tx.changed).toEqual(["ABCDE"]);
    expect(rooms.createRoom).toHaveBeenCalledWith("房主", 5);
  });

  it("schedules AI only after a state-changing command commits", () => {
    const simulateAI = vi.fn();
    const rooms = {
      submitVote: vi.fn(),
      simulateAI,
    } as unknown as RoomCommandPort;
    const service = new RoomApplicationService(rooms);
    const tx = transaction();

    service.submitVote("ABCDE", "p_1", "s_1", true, tx);
    expect(tx.changed).toEqual(["ABCDE"]);
    expect(simulateAI).not.toHaveBeenCalled();
    tx.effects.forEach(effect => effect());
    expect(simulateAI).toHaveBeenCalledWith("ABCDE");
  });
});
