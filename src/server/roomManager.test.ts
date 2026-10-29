import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomManager } from "./roomManager";
import crypto from "node:crypto";
import { ASSASSINATION_DURATION_MS, MISSION_RESULT_DURATION_MS, PROPOSAL_REJECTION_DURATION_MS, ROLE_REVEAL_DURATION_MS, TEAM_SELECTION_DURATION_MS, getTeamSize } from "../shared/game";

function createStartedRoom(count: number, names: string[] = []) {
  const manager = new RoomManager(["http://localhost:3000"]);
  const host = manager.createRoom(names[0] ?? "Host", count);
  const players = [host];
  for (let i = 2; i <= count; i += 1) {
    players.push(manager.joinRoom(host.roomCode, names[i - 1] ?? `P${i}`));
  }
  for (const player of players.slice(1)) {
    manager.setPlayerReady(host.roomCode, player.playerId, player.sessionToken, true);
  }
  manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
  vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
  return { manager, players, roomCode: host.roomCode };
}

function finishSpeechRound(playerCount: number): void {
  vi.advanceTimersByTime(60_000 * playerCount);
}

function rejectTeams(manager: RoomManager, players: ReturnType<RoomManager["createRoom"]>[], roomCode: string): void {
  for (let attempt = 1; attempt < players.length; attempt++) {
    const state = manager.getPublicState(roomCode);
    const leader = players.find(p => p.playerId === state.leaderId)!;
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map(p => p.playerId));
    players.filter(p => p.playerId !== leader.playerId).forEach((voter) => {
      manager.submitVote(roomCode, voter.playerId, voter.sessionToken, false);
    });
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "proposalResult", rejectCount: attempt, winner: null });
    vi.advanceTimersByTime(PROPOSAL_REJECTION_DURATION_MS);
    expect(manager.getPublicState(roomCode).phase).toBe("team");
  }
}

function completeMissionCards(manager: RoomManager, roomCode: string, failed = false): void {
  const room = manager.getRoom(roomCode)!;
  const state = manager.getPublicState(roomCode);
  const leader = room.players.find((player) => player.id === state.leaderId)!;
  const team = room.players.filter((player) => player.connected)
    .sort((a, b) => failed ? Number(manager.getPrivateState(roomCode, b.id).side === "evil") - Number(manager.getPrivateState(roomCode, a.id).side === "evil") : 0)
    .slice(0, state.teamSize);
  manager.proposeTeam(roomCode, leader.id, leader.sessionToken, team.map((player) => player.id));
  for (const player of room.players) {
    if (player.connected && manager.getPrivateState(roomCode, player.id).canVote) {
      manager.submitVote(roomCode, player.id, player.sessionToken, true);
    }
  }
  for (const player of team) {
    if (manager.getPrivateState(roomCode, player.id).canMission) {
      manager.submitMission(roomCode, player.id, player.sessionToken, failed && manager.getPrivateState(roomCode, player.id).side === "evil");
    }
  }
}

function finishSpeeches(manager: RoomManager, roomCode: string): void {
  const room = manager.getRoom(roomCode)!;
  while (manager.getPublicState(roomCode).phase === "speech") {
    const speakerId = manager.getPublicState(roomCode).timer!.speakerId;
    const speaker = room.players.find((player) => player.id === speakerId)!;
    manager.endSpeech(roomCode, speaker.id, speaker.sessionToken);
  }
}

function completeSuccessfulMission(manager: RoomManager, roomCode: string): void {
  completeMissionCards(manager, roomCode);
  vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
  finishSpeeches(manager, roomCode);
}

describe("RoomManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomInt").mockImplementation(() => 0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([5, 6, 7, 8, 9, 10].flatMap(count => Array.from({ length: count }, (_, seat) => [count, seat])))("can start a %i-player game with random first leader seat %i", (count, seat) => {
    vi.mocked(crypto.randomInt).mockImplementation(max => max === count ? seat : 0);
    const { manager, players, roomCode } = createStartedRoom(count);
    expect(manager.getPublicState(roomCode).leaderId).toBe(players[seat].playerId);
    expect(crypto.randomInt).toHaveBeenCalledWith(count);
    for (const player of players) expect(manager.getPrivateState(roomCode, player.playerId).canPropose).toBe(player.playerId === players[seat].playerId);
    manager.close();
  });

  it.each([[0, "male"], [1, "female"]] as const)("assigns servant art from server draw %i (%s) without exposing it publicly", (draw, variant) => {
    vi.mocked(crypto.randomInt).mockImplementation(max => max === 2 ? draw : 0);
    const { manager, players, roomCode } = createStartedRoom(5);
    try {
      const servant = players.find(player => manager.getPrivateState(roomCode, player.playerId).role === "servant")!;
      const state = manager.getPrivateState(roomCode, servant.playerId);
      expect(state).toMatchObject({ role: "servant", side: "good", servantVariant: variant });
      const draws = vi.mocked(crypto.randomInt).mock.calls.length;
      for (let read = 0; read < 5; read++) {
        expect(manager.getPrivateState(roomCode, servant.playerId).servantVariant).toBe(variant);
        expect(manager.getPublicState(roomCode).revealedRoles).toEqual([]);
      }
      expect(crypto.randomInt).toHaveBeenCalledTimes(draws);
      expect(manager.getPublicState(roomCode).players.every(player => !("servantVariant" in player))).toBe(true);
      for (const player of players.filter(player => player.playerId !== servant.playerId)) expect(manager.getPrivateState(roomCode, player.playerId).servantVariant).toBeNull();
    } finally { manager.close(); }
  });

  it("draws each servant's appearance independently within one game", () => {
    let appearanceDraw = 0;
    vi.mocked(crypto.randomInt).mockImplementation(max => max === 2 ? appearanceDraw++ % 2 : 0);
    const { manager, players, roomCode } = createStartedRoom(10);
    try {
      const variants = players.map(player => manager.getPrivateState(roomCode, player.playerId)).filter(player => player.role === "servant").map(player => player.servantVariant);
      expect(variants).toEqual(["male", "female", "male", "female"]);
      expect(appearanceDraw).toBe(4);
      expect(manager.getPublicState(roomCode).servantCounts).toEqual({ male: 2, female: 2 });
    } finally { manager.close(); }
  });

  it.each([5, 6, 7, 8, 9, 10])("publishes only aggregate servant appearances in %i-player games and resets them in the lobby", count => {
    const { manager, players, roomCode } = createStartedRoom(count);
    try {
      const expected = { male: 0, female: 0 };
      for (const player of players) {
        const state = manager.getPrivateState(roomCode, player.playerId);
        if (state.role === "servant") expected[state.servantVariant!]++;
      }
      const state = manager.getPublicState(roomCode);
      expect(state.servantCounts).toEqual(expected);
      expect(state.players.every(player => !("role" in player) && !("servantVariant" in player))).toBe(true);
      state.servantCounts!.male = 99;
      expect(manager.getPublicState(roomCode).servantCounts).toEqual(expected);
      manager.disconnectPlayer(players[1].playerId);
      manager.rejoinRoom(roomCode, players[1].playerId, players[1].sessionToken);
      expect(manager.getPublicState(roomCode).servantCounts).toEqual(expected);
      manager.restartRoom(roomCode, players[0].playerId, players[0].sessionToken);
      expect(manager.getPublicState(roomCode).servantCounts).toBeNull();
    } finally { manager.close(); }
  });

  it("keeps the first leader and servant art on rejoin, then redraws them for a new game", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { manager, players, roomCode } = createStartedRoom(5);
    try {
      const servant = players.find(player => manager.getPrivateState(roomCode, player.playerId).role === "servant")!;
      expect(servant.playerId).not.toBe(manager.getPublicState(roomCode).leaderId);
      const draws = vi.mocked(crypto.randomInt).mock.calls.length;
      manager.disconnectPlayer(servant.playerId);
      manager.rejoinRoom(roomCode, servant.playerId, servant.sessionToken);
      expect(manager.getPublicState(roomCode).leaderId).toBe(players[0].playerId);
      expect(manager.getPrivateState(roomCode, servant.playerId).servantVariant).toBe("male");
      expect(crypto.randomInt).toHaveBeenCalledTimes(draws);
      manager.restartRoom(roomCode, players[0].playerId, players[0].sessionToken);
      for (const player of players) expect(manager.getPrivateState(roomCode, player.playerId)).toMatchObject({ role: null, servantVariant: null });
      for (const player of players.slice(1)) manager.setPlayerReady(roomCode, player.playerId, player.sessionToken, true);
      vi.mocked(crypto.randomInt).mockImplementation(max => max === 2 ? 1 : 2);
      manager.startRoom(roomCode, players[0].playerId, players[0].sessionToken);
      expect(manager.getPublicState(roomCode).leaderId).toBe(players[2].playerId);
      expect(manager.getPrivateState(roomCode, servant.playerId)).toMatchObject({ role: "servant", servantVariant: "female" });
    } finally { manager.close(); }
  });

  it("reveals the originally assigned servant appearance only at final settlement", () => {
    vi.mocked(crypto.randomInt).mockImplementation(max => max === 2 ? 1 : 0);
    const { manager, players, roomCode } = createStartedRoom(5);
    try {
      const servant = players.find(player => manager.getPrivateState(roomCode, player.playerId).role === "servant")!;
      for (let quest = 0; quest < 3; quest++) {
        completeMissionCards(manager, roomCode, true);
        expect(manager.getPublicState(roomCode).revealedRoles).toEqual([]);
        vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
        finishSpeeches(manager, roomCode);
      }
      expect(manager.getPublicState(roomCode).phase).toBe("result");
      expect(manager.getPublicState(roomCode).revealedRoles.find(role => role.playerId === servant.playerId)).toMatchObject({ role: "servant", servantVariant: "female" });
    } finally { manager.close(); }
  });

  it.each(["rejected", "success", "fail"] as const)("rotates A to B after %s, with speeches only after missions", outcome => {
    const { manager, players, roomCode } = createStartedRoom(5, ["A", "B", "C", "D", "E"]);
    if (outcome === "rejected") {
      manager.proposeTeam(roomCode, players[0].playerId, players[0].sessionToken, players.slice(0, 2).map(p => p.playerId));
      for (const voter of players.slice(1)) manager.submitVote(roomCode, voter.playerId, voter.sessionToken, false);
      expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "proposalResult", leaderId: players[0].playerId, timer: { kind: "proposalResult", durationMs: 5_000 } });
      vi.advanceTimersByTime(PROPOSAL_REJECTION_DURATION_MS);
    } else {
      completeMissionCards(manager, roomCode, outcome === "fail");
      expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "missionResult", leaderId: players[0].playerId });
      vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    }
    const state = manager.getPublicState(roomCode);
    if (outcome === "rejected") {
      expect(state).toMatchObject({ phase: "team", leaderId: players[1].playerId, speechOrder: [], timer: { kind: "team", durationMs: 30_000 } });
      expect(manager.getPrivateState(roomCode, players[1].playerId).canPropose).toBe(true);
      manager.close();
      return;
    }
    expect(state).toMatchObject({ phase: "speech", leaderId: players[1].playerId, timer: { speakerId: players[2].playerId, durationMs: 60_000 } });
    expect(state.speechOrder.map(id => state.players.find(p => p.id === id)?.name)).toEqual(["C", "D", "E", "A", "B"]);
    expect(manager.getPrivateState(roomCode, players[1].playerId).canPropose).toBe(false);
    expect(() => manager.proposeTeam(roomCode, players[1].playerId, players[1].sessionToken, players.slice(0, 2).map(p => p.playerId))).toThrow("当前不是组队阶段");
    expect(() => manager.endSpeech(roomCode, players[0].playerId, players[0].sessionToken)).toThrow("不是你的发言时间");
    for (const index of [2, 3, 4, 0, 1]) {
      expect(manager.getPublicState(roomCode).timer?.speakerId).toBe(players[index].playerId);
      vi.advanceTimersByTime(59_999);
      expect(manager.getPublicState(roomCode).timer?.speakerId).toBe(players[index].playerId);
      vi.advanceTimersByTime(1);
    }
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "team", leaderId: players[1].playerId, speechOrder: [], timer: { kind: "team", durationMs: 30_000 } });
    manager.close();
  });

  it("wraps the forced leader E back to A and speaks BCDEA", () => {
    const { manager, players, roomCode } = createStartedRoom(5, ["A", "B", "C", "D", "E"]);
    rejectTeams(manager, players, roomCode);
    expect(manager.getPublicState(roomCode).leaderId).toBe(players[4].playerId);
    completeMissionCards(manager, roomCode);
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    const state = manager.getPublicState(roomCode);
    expect(state.leaderId).toBe(players[0].playerId);
    expect(state.speechOrder.map(id => state.players.find(p => p.id === id)?.name)).toEqual(["B", "C", "D", "E", "A"]);
    finishSpeeches(manager, roomCode);
    expect(manager.getPublicState(roomCode).leaderId).toBe(players[0].playerId);
    manager.close();
  });

  it("draws the first leader among remaining players after the creator has left", () => {
    const manager = new RoomManager([]);
    const creator = manager.createRoom("A", 5);
    const players = ["B", "C", "D", "E"].map(name => manager.joinRoom(creator.roomCode, name));
    manager.leaveRoom(creator.roomCode, creator.playerId, creator.sessionToken);
    players.push(manager.joinRoom(creator.roomCode, "F"));
    for (const player of players.slice(1)) manager.setPlayerReady(creator.roomCode, player.playerId, player.sessionToken, true);
    vi.mocked(crypto.randomInt).mockImplementation(max => max === 5 ? 2 : 0);
    manager.startRoom(creator.roomCode, players[0].playerId, players[0].sessionToken);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    expect(manager.getPublicState(creator.roomCode).leaderId).toBe(players[2].playerId);
    manager.close();
  });

  it("cancels an AI speech on disconnect without skipping the next human", () => {
    const manager = new RoomManager([]);
    const host = manager.createRoom("A", 5);
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 3);
    const human = manager.joinRoom(host.roomCode, "E");
    manager.setPlayerReady(host.roomCode, human.playerId, human.sessionToken, true);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    completeMissionCards(manager, host.roomCode);
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    const originalSpeaker = manager.getPublicState(host.roomCode).timer!.speakerId!;
    const end = vi.spyOn(manager, "endSpeech");
    manager.disconnectPlayer(originalSpeaker);
    manager.simulateAI(host.roomCode);
    vi.advanceTimersByTime(3_000);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0][1]).not.toBe(originalSpeaker);
    expect(manager.getPublicState(host.roomCode).timer).toMatchObject({ speakerId: human.playerId, durationMs: 60_000 });
    vi.advanceTimersByTime(3_000);
    expect(manager.getPublicState(host.roomCode).timer?.speakerId).toBe(human.playerId);
    expect(manager.getRoom(host.roomCode)!.aiTimeout).toBeUndefined();
    manager.restartRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(60_000);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "lobby", speechOrder: [], timer: null });
    manager.close();
  });

  it("skips an offline next leader and makes the next online leader speak last", () => {
    const { manager, players, roomCode } = createStartedRoom(5, ["A", "B", "C", "D", "E"]);
    manager.disconnectPlayer(players[1].playerId);
    completeMissionCards(manager, roomCode);
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    const state = manager.getPublicState(roomCode);
    expect(state.leaderId).toBe(players[2].playerId);
    expect(state.speechOrder.map(id => state.players.find(p => p.id === id)?.name)).toEqual(["D", "E", "A", "C"]);
    finishSpeeches(manager, roomCode);
    expect(manager.getPublicState(roomCode).leaderId).toBe(players[2].playerId);
    manager.close();
  });

  it("does not leak private roles in public state before result", () => {
    const { manager, roomCode } = createStartedRoom(5);
    const publicState = manager.getPublicState(roomCode);

    expect(publicState.phase).toBe("team");
    expect(publicState.revealedRoles).toEqual([]);
    expect(JSON.stringify(publicState.players)).not.toContain("merlin");
    expect(JSON.stringify(publicState.players)).not.toContain("assassin");
  });

  it("tracks target player count and ready state in lobby", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 7);
    const player = manager.joinRoom(host.roomCode, "P2");

    let state = manager.getPublicState(host.roomCode);
    expect(state.targetPlayerCount).toBe(7);
    expect(state.players.map((candidate) => candidate.ready)).toEqual([false, false]);

    manager.setPlayerReady(host.roomCode, player.playerId, player.sessionToken, true);
    manager.setTargetPlayerCount(host.roomCode, host.playerId, host.sessionToken, 6);
    state = manager.getPublicState(host.roomCode);

    expect(state.targetPlayerCount).toBe(6);
    expect(state.players.find((candidate) => candidate.id === player.playerId)?.ready).toBe(true);
  });

  it("requires target player count and all non-host players ready before starting", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    const players = [host];
    for (let i = 2; i <= 5; i += 1) {
      players.push(manager.joinRoom(host.roomCode, `P${i}`));
    }

    expect(() => manager.startRoom(host.roomCode, host.playerId, host.sessionToken)).toThrow("所有队员准备后才能开始");

    for (const player of players.slice(1)) {
      manager.setPlayerReady(host.roomCode, player.playerId, player.sessionToken, true);
    }
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    expect(manager.getPublicState(host.roomCode).phase).toBe("reveal");
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS - 1);
    expect(manager.getPublicState(host.roomCode).phase).toBe("reveal");
    const state = manager.getPublicState(host.roomCode);
    const leader = players.find(p => p.playerId === state.leaderId)!;
    expect(manager.getPrivateState(host.roomCode, leader.playerId).canPropose).toBe(false);
    expect(() => manager.proposeTeam(host.roomCode, leader.playerId, leader.sessionToken, players.slice(0, 2).map(p => p.playerId))).toThrow("当前不是组队阶段");
    vi.advanceTimersByTime(1);
    expect(manager.getPublicState(host.roomCode).phase).toBe("team");
  });

  it("prevents starting before the selected player count is reached", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 6);
    const players = [host];
    for (let i = 2; i <= 5; i += 1) {
      players.push(manager.joinRoom(host.roomCode, `P${i}`));
    }
    for (const player of players.slice(1)) {
      manager.setPlayerReady(host.roomCode, player.playerId, player.sessionToken, true);
    }

    expect(() => manager.startRoom(host.roomCode, host.playerId, host.sessionToken)).toThrow("需要 6 名玩家才能开始");
  });

  it("prevents starting while a lobby player is disconnected", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    const players = [host];
    for (let i = 2; i <= 5; i += 1) {
      players.push(manager.joinRoom(host.roomCode, `P${i}`));
    }
    for (const player of players.slice(1)) {
      manager.setPlayerReady(host.roomCode, player.playerId, player.sessionToken, true);
    }
    manager.disconnectPlayer(players[1].playerId);

    expect(() => manager.startRoom(host.roomCode, host.playerId, host.sessionToken)).toThrow("所有玩家在线后才能开始");
  });

  it("prevents lowering target player count below current players", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 7);
    for (let i = 2; i <= 6; i += 1) {
      manager.joinRoom(host.roomCode, `P${i}`);
    }

    expect(() => manager.setTargetPlayerCount(host.roomCode, host.playerId, host.sessionToken, 5)).toThrow("目标人数不能少于当前玩家数");
  });

  it("prevents joining after the room reaches the selected player limit", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    for (let i = 2; i <= 5; i += 1) {
      manager.joinRoom(host.roomCode, `P${i}`);
    }

    expect(() => manager.joinRoom(host.roomCode, "P6")).toThrow("房间人数已满");
  });

  it("rejects duplicate player names in a lobby", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    manager.joinRoom(host.roomCode, "Arthur");

    expect(() => manager.joinRoom(host.roomCode, "arthur")).toThrow("房间内已有同名玩家");
  });

  it("rejects blank player names at the authoritative boundary", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);

    expect(() => manager.createRoom("   ", 5)).toThrow("请输入你的名字");
    expect(() => manager.joinRoom(host.roomCode, "   ")).toThrow("请输入你的名字");
  });

  it("rejects host ready changes", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);

    expect(() => manager.setPlayerReady(host.roomCode, host.playerId, host.sessionToken, true)).toThrow("房主不需要准备");
  });

  it("removes lobby players when they leave", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    const player = manager.joinRoom(host.roomCode, "P2");

    manager.leaveRoom(host.roomCode, player.playerId, player.sessionToken);

    const state = manager.getPublicState(host.roomCode);
    expect(state.players.map((candidate) => candidate.id)).toEqual([host.playerId]);
    expect(state.players[0].position).toBe(0);
  });

  it("removes disconnected lobby players after the reconnect grace path", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    const player = manager.joinRoom(host.roomCode, "P2");

    manager.disconnectPlayer(player.playerId);
    const changedRoomCode = manager.removeDisconnectedLobbyPlayer(player.playerId);

    expect(changedRoomCode).toBe(host.roomCode);
    const state = manager.getPublicState(host.roomCode);
    expect(state.players.map((candidate) => candidate.id)).toEqual([host.playerId]);
    expect(() => manager.joinRoom(host.roomCode, "P3")).not.toThrow();
  });

  it("transfers lobby host when the host leaves", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    const nextHost = manager.joinRoom(host.roomCode, "P2");

    manager.leaveRoom(host.roomCode, host.playerId, host.sessionToken);

    const state = manager.getPublicState(host.roomCode);
    expect(state.hostId).toBe(nextHost.playerId);
    expect(state.players).toHaveLength(1);
    expect(state.players[0].isHost).toBe(true);
  });

  it("moves host to the next clockwise player and shrinks the table when host leaves", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    const nextHost = manager.joinRoom(host.roomCode, "P2");
    const third = manager.joinRoom(host.roomCode, "P3");

    manager.leaveRoom(host.roomCode, host.playerId, host.sessionToken);

    const state = manager.getPublicState(host.roomCode);
    expect(state.players.map((player) => player.id)).toEqual([nextHost.playerId, third.playerId]);
    expect(state.hostId).toBe(nextHost.playerId);
    expect(state.players.map((player) => player.position)).toEqual([0, 1]);
  });

  it("returns removed player information when kicking a lobby player", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    const player = manager.joinRoom(host.roomCode, "P2");

    const removed = manager.kickPlayer(host.roomCode, host.playerId, host.sessionToken, player.playerId);

    expect(removed).toEqual({ id: player.playerId, name: "P2" });
    expect(manager.getPublicState(host.roomCode).players.map((candidate) => candidate.id)).toEqual([host.playerId]);
  });

  it("dissolves a room and returns all affected players", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host", 5);
    const player = manager.joinRoom(host.roomCode, "P2");

    const removed = manager.dissolveRoom(host.roomCode, host.playerId, host.sessionToken);

    expect(removed.map((candidate) => candidate.id)).toEqual([host.playerId, player.playerId]);
    expect(manager.getRoom(host.roomCode)).toBeNull();
  });

  it("rejects actions from the wrong phase and duplicate votes", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const nonLeader = players.find((player) => player.playerId !== leader.playerId)!;
    const team = players.slice(0, state.teamSize).map((player) => player.playerId);

    expect(() => manager.submitVote(roomCode, leader.playerId, leader.sessionToken, true)).toThrow("当前不是公投阶段");
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, team);
    manager.submitVote(roomCode, nonLeader.playerId, nonLeader.sessionToken, true);
    expect(() => manager.submitVote(roomCode, nonLeader.playerId, nonLeader.sessionToken, true)).toThrow("已经投过票");
  });

  it("lets the leader choose which unfinished quest to run", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const selectedQuestIndex = 1;
    const team = players.slice(0, 2).map((player) => player.playerId);

    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, team, selectedQuestIndex);

    const voteState = manager.getPublicState(roomCode);
    expect(voteState.questIndex).toBe(selectedQuestIndex);
    expect(voteState.teamSize).toBe(2);

    for (const player of players.filter((candidate) => candidate.playerId !== leader.playerId)) {
      manager.submitVote(roomCode, player.playerId, player.sessionToken, true);
    }
    for (const player of players.filter((candidate) => team.includes(candidate.playerId))) {
      manager.submitMission(roomCode, player.playerId, player.sessionToken, false);
    }

    const afterMission = manager.getPublicState(roomCode);
    expect(afterMission.history.find((entry) => entry.type === "mission")?.quest).toBe(2);
    expect(afterMission.phase).toBe("missionResult");
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    finishSpeechRound(players.length);
    const afterSpeech = manager.getPublicState(roomCode);
    expect(afterSpeech.phase).toBe("team");
    const nextLeader = players.find((player) => player.playerId === afterSpeech.leaderId)!;
    expect(() => manager.proposeTeam(roomCode, nextLeader.playerId, nextLeader.sessionToken, team, selectedQuestIndex)).toThrow("该任务已经完成");
  });

  it.each([[1, 2], [2, 3]])("validates five-player quest index %i with %i members", (questIndex, size) => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const leader = players[0];
    const wrongSize = size === 2 ? 3 : 2;
    expect(() => manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, wrongSize).map(player => player.playerId), questIndex)).toThrow(`需要选择 ${size} 名队员`);
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, size).map(player => player.playerId), questIndex);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "vote", questIndex, teamSize: size, requiredFails: 1 });
  });

  it.each([5, 6, 7, 8, 9, 10])("starts a %i-player solo room with one human and the remaining AI", count => {
    const manager = new RoomManager([]);
    try {
      const host = manager.createRoom("Solo", count);
      manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, count - 1);
      manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
      const state = manager.getPublicState(host.roomCode);
      expect(state.players).toHaveLength(count);
      expect(manager.getRoom(host.roomCode)?.players.filter(player => player.isAI)).toHaveLength(count - 1);
      expect(state).toMatchObject({ phase: "reveal", targetPlayerCount: count, leaderId: host.playerId, timer: { durationMs: 10_000 } });
      expect(new Set(state.players.map(player => player.name)).size).toBe(count);
      expect(state.players.slice(1).every(player => Array.from(player.name).length <= 8)).toBe(true);
    } finally { manager.close(); }
  });

  it.each([5, 6, 7, 8, 9, 10].flatMap(count => [1, 2].map(fails => [count, fails])))("judges quest 4 selected first in a %i-player game with %i opposing mission cards", (count, fails) => {
    const { manager, players, roomCode } = createStartedRoom(count);
    const leader = players.find(player => player.playerId === manager.getPublicState(roomCode).leaderId)!;
    const evil = players.filter(player => manager.getPrivateState(roomCode, player.playerId).side === "evil").slice(0, fails);
    const team = [...evil, ...players.filter(player => !evil.includes(player))].slice(0, getTeamSize(count, 3));
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, team.map(player => player.playerId), 3);
    for (const voter of players.filter(player => player !== leader)) manager.submitVote(roomCode, voter.playerId, voter.sessionToken, true);
    for (const player of team) manager.submitMission(roomCode, player.playerId, player.sessionToken, evil.includes(player));
    const failed = fails >= (count >= 7 ? 2 : 1);
    expect(manager.getPublicState(roomCode)).toMatchObject({
      phase: "missionResult", score: { success: failed ? 0 : 1, fail: failed ? 1 : 0 },
      history: expect.arrayContaining([expect.objectContaining({ type: "mission", quest: 4, fails, result: failed ? "fail" : "success" })]),
    });
    manager.close();
  });

  it("prevents good players from submitting fail cards", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const goodPlayer = players.find((player) => manager.getPrivateState(roomCode, player.playerId).side === "good")!;
    const team = [
      goodPlayer.playerId,
      ...players.filter((player) => player.playerId !== goodPlayer.playerId).map((player) => player.playerId),
    ].slice(0, state.teamSize);

    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, team);
    for (const player of players.filter((candidate) => candidate.playerId !== leader.playerId)) {
      manager.submitVote(roomCode, player.playerId, player.sessionToken, true);
    }

    const publicState = manager.getPublicState(roomCode);
    const goodOnMission = players.find((player) => publicState.proposal.includes(player.playerId) && manager.getPrivateState(roomCode, player.playerId).side === "good")!;

    expect(() => manager.submitMission(roomCode, goodOnMission.playerId, goodOnMission.sessionToken, true)).toThrow("正方玩家不能提交失败牌");
  });

  it.each([false, true])("keeps the third mission result but skips terminal speeches (failed=%s)", failed => {
    const { manager, players, roomCode } = createStartedRoom(5);
    for (let quest = 0; quest < 3; quest++) {
      completeMissionCards(manager, roomCode, failed);
      expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "missionResult", winner: null, revealedRoles: [] });
      vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS - 1);
      expect(manager.getPublicState(roomCode).phase).toBe("missionResult");
      vi.advanceTimersByTime(1);
      if (quest < 2) {
        expect(manager.getPublicState(roomCode).phase).toBe("speech");
        for (const player of players) expect(manager.getPrivateState(roomCode, player.playerId).canAssassinate).toBe(false);
        finishSpeeches(manager, roomCode);
      } else {
        expect(manager.getPublicState(roomCode).phase).toBe(failed ? "result" : "assassin");
        expect(manager.getPublicState(roomCode).speechOrder).toEqual([]);
      }
    }
    const state = manager.getPublicState(roomCode);
    expect(state.phase).toBe(failed ? "result" : "assassin");
    expect(state.winner).toBe(failed ? "evil" : null);
    expect(state.history.filter(h => h.type === "mission")).toHaveLength(3);
    manager.close();
  });

  it("uses the original reveal deadline on reconnect and cancels it on restart", () => {
    const manager = new RoomManager([]);
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    const deadline = manager.getPublicState(host.roomCode).timer!.deadline;
    vi.advanceTimersByTime(4_000);
    manager.disconnectPlayer(host.playerId);
    manager.rejoinRoom(host.roomCode, host.playerId, host.sessionToken);
    expect(manager.getPublicState(host.roomCode).timer!.deadline).toBe(deadline);
    manager.restartRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(20_000);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "lobby", timer: null, leaderId: null });
    expect(manager.getPrivateState(host.roomCode, host.playerId).role).toBeNull();
    manager.close();
  });

  it("requires a human speech after mission presentation in an AI room", () => {
    const manager = new RoomManager([]);
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    completeMissionCards(manager, host.roomCode);
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    expect(manager.getPublicState(host.roomCode).speechOrder).toHaveLength(5);
    const order = manager.getPublicState(host.roomCode).speechOrder;
    expect(order[3]).toBe(host.playerId);
    for (let i = 0; i < 3; i++) {
      expect(manager.getPublicState(host.roomCode).timer?.speakerId).toBe(order[i]);
      vi.advanceTimersByTime(3_000);
    }
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "speech", timer: { kind: "speech", speakerId: host.playerId, durationMs: 60_000 } });
    vi.advanceTimersByTime(59_999);
    expect(manager.getPublicState(host.roomCode).phase).toBe("speech");
    vi.advanceTimersByTime(1);
    expect(manager.getPublicState(host.roomCode).timer?.speakerId).toBe(order.at(-1));
    vi.advanceTimersByTime(3_000);
    expect(manager.getPublicState(host.roomCode).phase).toBe("team");
    manager.close();
  });

  it("allows good players to reject a proposed team vote", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const goodPlayer = players.find((player) => player.playerId !== leader.playerId && manager.getPrivateState(roomCode, player.playerId).side === "good")!;

    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map((player) => player.playerId));

    expect(() => manager.submitVote(roomCode, goodPlayer.playerId, goodPlayer.sessionToken, false)).not.toThrow();
  });

  it("allows evil players to reject a proposed team", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const evilPlayer = players.find((player) => player.playerId !== leader.playerId && manager.getPrivateState(roomCode, player.playerId).side === "evil")!;

    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map((player) => player.playerId));

    expect(() => manager.submitVote(roomCode, evilPlayer.playerId, evilPlayer.sessionToken, false)).not.toThrow();
  });

  it.each([5, 6, 7, 8, 9, 10].flatMap(count => Array.from({ length: count }, (_, rejections) => [count, rejections])))("uses a strict player-count majority in %i-player votes with %i objections", (count, rejections) => {
    const { manager, players, roomCode } = createStartedRoom(count);
    const leader = players[0];
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, manager.getPublicState(roomCode).teamSize).map(player => player.playerId));
    for (const [index, voter] of players.slice(1).entries()) {
      manager.submitVote(roomCode, voter.playerId, voter.sessionToken, index >= rejections);
      if (index < count - 2) expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "vote", history: [] });
    }
    const rejected = rejections > count / 2;
    const state = manager.getPublicState(roomCode);
    expect(state.phase).toBe(rejected ? "proposalResult" : "mission");
    expect(state.rejectCount).toBe(rejected ? 1 : 0);
    expect(state.history.at(-1)).toMatchObject({ approvals: count - rejections, rejections, result: rejected ? "fail" : "success" });
    expect(state.history.at(-1)?.voteDetails).toHaveLength(count);
    manager.close();
  });

  it("gives each leader 30 seconds and rotates a timed-out selection without a rejection or speech", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const start = manager.getPublicState(roomCode);
    expect(start.timer).toMatchObject({ kind: "team", durationMs: TEAM_SELECTION_DURATION_MS });
    vi.advanceTimersByTime(TEAM_SELECTION_DURATION_MS - 1);
    expect(manager.getPublicState(roomCode).leaderId).toBe(players[0].playerId);
    vi.advanceTimersByTime(1);
    const next = manager.getPublicState(roomCode);
    expect(next).toMatchObject({ phase: "team", leaderId: players[1].playerId, rejectCount: 0, history: [], speechOrder: [], proposal: [] });
    expect(next.timer).toMatchObject({ kind: "team", deadline: start.timer!.deadline + TEAM_SELECTION_DURATION_MS });
    expect(manager.getPrivateState(roomCode, players[0].playerId).canPropose).toBe(false);
    expect(manager.getPrivateState(roomCode, players[1].playerId).canPropose).toBe(true);
    expect(() => manager.proposeTeam(roomCode, players[0].playerId, players[0].sessionToken, players.slice(0, 2).map(player => player.playerId))).toThrow("只有当前领队");
    vi.advanceTimersByTime(TEAM_SELECTION_DURATION_MS);
    expect(manager.getPublicState(roomCode).leaderId).toBe(players[2].playerId);
    manager.close();
  });

  it("preserves selection deadlines on sync and cancels old selection timers after submission or restart", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const originalDeadline = manager.getPublicState(roomCode).timer!.deadline;
    vi.advanceTimersByTime(10_000);
    manager.syncPlayerSession(roomCode, players[0].playerId, players[0].sessionToken);
    expect(manager.getPublicState(roomCode).timer!.deadline).toBe(originalDeadline);
    manager.proposeTeam(roomCode, players[0].playerId, players[0].sessionToken, players.slice(0, 2).map(player => player.playerId));
    vi.advanceTimersByTime(20_000);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "vote", leaderId: players[0].playerId });
    manager.restartRoom(roomCode, players[0].playerId, players[0].sessionToken);
    vi.advanceTimersByTime(60_000);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "lobby", timer: null, history: [] });
    manager.close();
  });

  it("skips an offline leader and gives the replacement a fresh selection deadline", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    vi.advanceTimersByTime(10_000);
    manager.disconnectPlayer(players[1].playerId);
    manager.disconnectPlayer(players[0].playerId);
    const state = manager.getPublicState(roomCode);
    expect(state).toMatchObject({ phase: "team", leaderId: players[2].playerId, rejectCount: 0, history: [] });
    expect(state.timer).toMatchObject({ kind: "team", deadline: Date.now() + TEAM_SELECTION_DURATION_MS });
    manager.close();
  });

  it("rejects a proposed team only after all votes are in, then skips speech for the next leader", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const leaderIndex = state.players.findIndex((player) => player.id === leader.playerId);
    const expectedNextLeader = state.players[(leaderIndex + 1) % state.players.length].id;
    const voters = players.filter((player) => player.playerId !== leader.playerId);

    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map((player) => player.playerId));

    manager.submitVote(roomCode, voters[0].playerId, voters[0].sessionToken, false);
    for (const voter of voters.slice(1, -1)) {
      manager.submitVote(roomCode, voter.playerId, voter.sessionToken, false);
    }
    expect(manager.getPublicState(roomCode).phase).toBe("vote");
    expect(manager.getPublicState(roomCode).history).toEqual([]);
    const lastVoter = voters.at(-1)!;
    manager.submitVote(roomCode, lastVoter.playerId, lastVoter.sessionToken, true);

    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "proposalResult", leaderId: leader.playerId, timer: { kind: "proposalResult", durationMs: 5_000 } });
    expect(() => manager.endSpeech(roomCode, lastVoter.playerId, lastVoter.sessionToken)).toThrow("当前不在发言阶段");
    vi.advanceTimersByTime(PROPOSAL_REJECTION_DURATION_MS - 1);
    expect(manager.getPublicState(roomCode).phase).toBe("proposalResult");
    vi.advanceTimersByTime(1);
    const nextState = manager.getPublicState(roomCode);
    expect(nextState.phase).toBe("team");
    expect(nextState.leaderId).toBe(expectedNextLeader);
    expect(nextState.rejectCount).toBe(1);
    expect(nextState.proposal).toEqual([]);
    expect(nextState.history.at(-1)).toMatchObject({
      type: "vote",
      approvals: 2,
      rejections: 3,
      result: "fail",
      voteDetails: [{ playerId: leader.playerId, approved: true }, ...voters.map((voter, index) => ({ playerId: voter.playerId, approved: index === voters.length - 1 }))],
    });
    expect(nextState.speechOrder).toEqual([]);
    expect(nextState.timer).toMatchObject({ kind: "team", durationMs: 30_000 });
    expect(manager.getPrivateState(roomCode, expectedNextLeader).canPropose).toBe(true);
  });

  it("automatically records the leader approval and prevents changing it", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map((player) => player.playerId));
    expect(manager.getPrivateState(roomCode, leader.playerId).canVote).toBe(false);
    expect(manager.getPublicState(roomCode).voteSubmitted).toEqual([leader.playerId]);
    expect(() => manager.submitVote(roomCode, leader.playerId, leader.sessionToken, true)).toThrow("已自动投赞成票");
    expect(() => manager.submitVote(roomCode, leader.playerId, leader.sessionToken, false)).toThrow("已自动投赞成票");

    for (const voter of players.filter((player) => player.playerId !== leader.playerId)) {
      manager.submitVote(roomCode, voter.playerId, voter.sessionToken, true);
    }
    const nextState = manager.getPublicState(roomCode);
    expect(nextState.phase).toBe("mission");
    expect(nextState.history.at(-1)).toMatchObject({ type: "vote", approvals: 5, rejections: 0, result: "success" });
    expect(nextState.history.at(-1)?.voteDetails).toContainEqual({ playerId: leader.playerId, approved: true });
    manager.close();
  });

  it("preserves an explicit rejection when the other voters time out", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const opponent = players.find((player) => player.playerId !== leader.playerId)!;
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map((player) => player.playerId));
    manager.submitVote(roomCode, opponent.playerId, opponent.sessionToken, false);
    manager.disconnectPlayer(opponent.playerId);

    vi.advanceTimersByTime(30_000);

    const nextState = manager.getPublicState(roomCode);
    expect(nextState.phase).toBe("mission");
    expect(nextState.history.at(-1)).toMatchObject({ approvals: 4, rejections: 1, result: "success" });
    expect(nextState.history.at(-1)?.voteDetails).toHaveLength(5);
    expect(nextState.history.at(-1)?.voteDetails?.find(vote => vote.playerId === opponent.playerId)?.approved).toBe(false);
    expect(nextState.history.at(-1)?.voteDetails?.filter(vote => vote.approved)).toHaveLength(4);
    expect(nextState.timer?.kind).toBe("mission");
  });

  it.each([5, 6, 7, 8, 9, 10])("forces proposal %i after player-count-minus-one rejections", count => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(count);
    rejectTeams(manager, players, roomCode);
    const state = manager.getPublicState(roomCode);
    const leader = players.find(p => p.playerId === state.leaderId)!;
    const team = players.slice(0, state.teamSize);
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, team.map(p => p.playerId));
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "mission", winner: null, rejectCount: count - 1, voteSubmitted: [], timer: { kind: "mission", durationMs: 30_000 } });
    expect(manager.getPublicState(roomCode).history.at(-1)).toMatchObject({ forced: true, result: "success", approvals: 0, rejections: 0, voteDetails: [] });
    for (const player of players) {
      expect(manager.getPrivateState(roomCode, player.playerId).canVote).toBe(false);
      expect(manager.getPrivateState(roomCode, player.playerId).canMission).toBe(team.includes(player));
    }
    expect(() => manager.submitVote(roomCode, players[0].playerId, players[0].sessionToken, false)).toThrow("当前不是公投阶段");
    for (const player of team) manager.submitMission(roomCode, player.playerId, player.sessionToken, false);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "missionResult", score: { success: 1, fail: 0 }, rejectCount: 0, winner: null });
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    expect(manager.getPublicState(roomCode).phase).toBe("speech");
    manager.close();
  });

  it("still validates the leader, task and team before a forced launch", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    rejectTeams(manager, players, roomCode);
    const state = manager.getPublicState(roomCode);
    const leader = players.find(p => p.playerId === state.leaderId)!;
    const other = players.find(p => p.playerId !== state.leaderId)!;
    expect(() => manager.proposeTeam(roomCode, other.playerId, other.sessionToken, [])).toThrow("只有当前领队");
    expect(() => manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, [leader.playerId])).toThrow("需要选择");
    expect(() => manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, 2).map(p => p.playerId), 9)).toThrow();
    expect(() => manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, 2).map(p => p.playerId), 1.5)).toThrow("任务序号无效");
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "team", rejectCount: 4, winner: null });
    expect(manager.getPublicState(roomCode).history).toHaveLength(4);
    manager.close();
  });

  it("uses normal mission timeout defaults after a forced launch", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    rejectTeams(manager, players, roomCode);
    const state = manager.getPublicState(roomCode);
    const leader = players.find(p => p.playerId === state.leaderId)!;
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map(p => p.playerId));
    vi.advanceTimersByTime(30_000);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "missionResult", score: { success: 1, fail: 0 }, rejectCount: 0 });
    manager.close();
  });

  it("defaults unsubmitted team votes to approval when the vote timer expires", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;

    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map((player) => player.playerId));
    const votingState = manager.getPublicState(roomCode);
    expect(votingState.phase).toBe("vote");
    expect(votingState.timer?.kind).toBe("vote");

    vi.advanceTimersByTime(30_000);

    const nextState = manager.getPublicState(roomCode);
    expect(nextState.phase).toBe("mission");
    expect(nextState.voteSubmitted).toHaveLength(players.length);
  });

  it("defaults unsubmitted mission cards to success and starts clockwise speeches after a mission", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const leaderIndex = state.players.findIndex((player) => player.id === leader.playerId);
    const expectedNextLeader = state.players[(leaderIndex + 1) % state.players.length].id;
    const expectedFirstSpeaker = state.players[(leaderIndex + 2) % state.players.length].id;
    const team = players.slice(0, state.teamSize).map((player) => player.playerId);

    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, team);
    for (const player of players.filter((candidate) => candidate.playerId !== leader.playerId)) {
      manager.submitVote(roomCode, player.playerId, player.sessionToken, true);
    }
    expect(manager.getPublicState(roomCode).timer?.kind).toBe("mission");

    vi.advanceTimersByTime(30_000);

    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "missionResult", timer: { kind: "missionResult", durationMs: 8_000 } });
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS - 1);
    expect(manager.getPublicState(roomCode).phase).toBe("missionResult");
    expect(() => manager.endSpeech(roomCode, leader.playerId, leader.sessionToken)).toThrow("当前不在发言阶段");
    vi.advanceTimersByTime(1);
    const speechState = manager.getPublicState(roomCode);
    expect(speechState.score.success).toBe(1);
    expect(speechState.phase).toBe("speech");
    expect(speechState.timer?.kind).toBe("speech");
    expect(speechState.timer?.speakerId).toBe(expectedFirstSpeaker);

    finishSpeechRound(players.length);

    const nextState = manager.getPublicState(roomCode);
    expect(nextState.phase).toBe("team");
    expect(nextState.leaderId).toBe(expectedNextLeader);
  });

  it("keeps 30-second voting timers and resolves completed AI-room votes immediately", () => {
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    expect(manager.getPublicState(host.roomCode).timer).toMatchObject({ kind: "reveal", durationMs: 10_000 });
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    const room = manager.getRoom(host.roomCode) as any;
    room.leaderIndex = 0;
    const state = manager.getPublicState(host.roomCode);

    manager.proposeTeam(host.roomCode, host.playerId, host.sessionToken, room.players.slice(0, state.teamSize).map((player: any) => player.id));

    const voteState = manager.getPublicState(host.roomCode);
    expect(voteState.phase).toBe("vote");
    expect(voteState.timer).toMatchObject({ kind: "vote", durationMs: 30_000 });
    const voteDeadline = voteState.timer!.deadline;
    manager.rejoinRoom(host.roomCode, host.playerId, host.sessionToken);
    expect(manager.getPublicState(host.roomCode).timer?.deadline).toBe(voteDeadline);
    for (const player of room.players.slice(1)) manager.submitVote(host.roomCode, player.id, player.sessionToken, true);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "mission", timer: { kind: "mission", durationMs: 30_000 } });
    for (const id of room.proposal) {
      const player = room.players.find((candidate: { id: string }) => candidate.id === id)!;
      manager.submitMission(host.roomCode, player.id, player.sessionToken, false);
    }
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "missionResult", score: { success: 1, fail: 0 } });
    manager.close();
  });

  it("uses 30-second vote and mission timeout defaults in AI rooms", () => {
    const manager = new RoomManager([]);
    vi.spyOn(manager, "simulateAI").mockImplementation(() => {});
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    const room = manager.getRoom(host.roomCode)!;
    manager.proposeTeam(host.roomCode, host.playerId, host.sessionToken, room.players.slice(0, 2).map(player => player.id));
    vi.advanceTimersByTime(29_999);
    expect(manager.getPublicState(host.roomCode).phase).toBe("vote");
    vi.advanceTimersByTime(1);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "mission", voteSubmitted: room.players.map(player => player.id), timer: { durationMs: 30_000 } });
    vi.advanceTimersByTime(29_999);
    expect(manager.getPublicState(host.roomCode).phase).toBe("mission");
    vi.advanceTimersByTime(1);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "missionResult", score: { success: 1, fail: 0 } });
    manager.close();
  });

  it("keeps the rejection deadline on reconnect and cancels the presentation on restart", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    manager.proposeTeam(roomCode, players[0].playerId, players[0].sessionToken, players.slice(0, 2).map(player => player.playerId));
    for (const voter of players.slice(1)) manager.submitVote(roomCode, voter.playerId, voter.sessionToken, false);
    const deadline = manager.getPublicState(roomCode).timer!.deadline;
    vi.advanceTimersByTime(2_000);
    manager.disconnectPlayer(players[0].playerId);
    manager.rejoinRoom(roomCode, players[0].playerId, players[0].sessionToken);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "proposalResult", timer: { deadline } });
    manager.restartRoom(roomCode, players[0].playerId, players[0].sessionToken);
    vi.advanceTimersByTime(PROPOSAL_REJECTION_DURATION_MS);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "lobby", timer: null, speechOrder: [] });
    manager.close();
  });

  it("generates short unique AI nicknames and preserves them on rejoin and restart", () => {
    const manager = new RoomManager([]);
    const host = manager.createRoom("云舟", 10);
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 5);
    const names = manager.getPublicState(host.roomCode).players.map(player => player.name);
    expect(new Set(names).size).toBe(10);
    for (const name of names.slice(1)) {
      expect([...name].length).toBeGreaterThan(0);
      expect([...name].length).toBeLessThanOrEqual(8);
      expect(name).not.toMatch(/^AI\d/);
    }
    expect(manager.getRoom(host.roomCode)!.players.slice(1).every(player => player.isAI)).toBe(true);
    manager.rejoinRoom(host.roomCode, host.playerId, host.sessionToken);
    manager.restartRoom(host.roomCode, host.playerId, host.sessionToken);
    expect(manager.getPublicState(host.roomCode).players.map(player => player.name)).toEqual(names);
    manager.close();
  });

  it("simulates server-created AI without reordering authoritative players", () => {
    vi.useFakeTimers();
    const changes: string[] = [];
    const manager = new RoomManager(["http://localhost:3000"], (roomCode) => changes.push(roomCode));
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);

    const room = manager.getRoom(host.roomCode) as any;
    const originalOrder = room.players.map((player: any) => player.id);
    room.leaderIndex = room.players.findIndex((player: any) => player.isAI);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);

    manager.simulateAI(host.roomCode);
    vi.advanceTimersByTime(1500);

    expect(room.players.map((player: any) => player.id)).toEqual(originalOrder);
    expect(manager.getPublicState(host.roomCode).phase).toBe("vote");
    expect(changes).toContain(host.roomCode);
  });

  it("does not treat human players named AI as bots", () => {
    vi.useFakeTimers();
    const manager = new RoomManager(["http://localhost:3000"]);
    const host = manager.createRoom("AIHost");
    const players = [host];
    for (let i = 2; i <= 5; i += 1) {
      players.push(manager.joinRoom(host.roomCode, `AIHuman${i}`));
    }
    for (const player of players.slice(1)) {
      manager.setPlayerReady(host.roomCode, player.playerId, player.sessionToken, true);
    }
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);

    const room = manager.getRoom(host.roomCode) as any;
    room.leaderIndex = 0;

    manager.simulateAI(host.roomCode);
    vi.advanceTimersByTime(1500);

    expect(manager.getPublicState(host.roomCode).phase).toBe("team");
  });

  it("defaults disconnected pending vote to approval so the round can continue", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, players.slice(0, state.teamSize).map((player) => player.playerId));

    const disconnected = players.find((player) => player.playerId !== leader.playerId)!;
    manager.disconnectPlayer(disconnected.playerId);
    for (const player of players.filter((candidate) => candidate.playerId !== disconnected.playerId && candidate.playerId !== leader.playerId)) {
      manager.submitVote(roomCode, player.playerId, player.sessionToken, true);
    }

    const nextState = manager.getPublicState(roomCode);
    expect(nextState.phase).toBe("mission");
    expect(nextState.rejectCount).toBe(0);
  });

  it("skips a disconnected leader during team selection", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;

    manager.disconnectPlayer(leader.playerId);

    const nextState = manager.getPublicState(roomCode);
    expect(nextState.phase).toBe("team");
    expect(nextState.leaderId).not.toBe(leader.playerId);
    expect(nextState.players.find((player) => player.id === nextState.leaderId)?.connected).toBe(true);
  });

  it("prevents selecting disconnected players for a mission team", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const disconnected = players.find((player) => player.playerId !== leader.playerId)!;
    manager.disconnectPlayer(disconnected.playerId);

    expect(() =>
      manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, [leader.playerId, disconnected.playerId]),
    ).toThrow("不能选择已断线玩家");
  });

  it("defaults disconnected mission member to success so the mission can resolve", () => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const state = manager.getPublicState(roomCode);
    const leader = players.find((player) => player.playerId === state.leaderId)!;
    const team = players.slice(0, state.teamSize).map((player) => player.playerId);
    manager.proposeTeam(roomCode, leader.playerId, leader.sessionToken, team);
    for (const player of players.filter((candidate) => candidate.playerId !== leader.playerId)) {
      manager.submitVote(roomCode, player.playerId, player.sessionToken, true);
    }

    const disconnected = team[0];
    manager.disconnectPlayer(disconnected);
    for (const playerId of team.filter((id) => id !== disconnected)) {
      const player = players.find((candidate) => candidate.playerId === playerId)!;
      manager.submitMission(roomCode, player.playerId, player.sessionToken, false);
    }

    const result = manager.getPublicState(roomCode);
    expect(result.history.filter((entry) => entry.type === "mission")).toHaveLength(1);
    expect(result.score.success).toBe(1);
  });

  it("defaults a player who left before voting starts in an AI room", () => {
    const manager = new RoomManager([]);
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    manager.leaveRoom(host.roomCode, host.playerId, host.sessionToken);
    const room = manager.getRoom(host.roomCode)!;
    const state = manager.getPublicState(host.roomCode);
    const leader = room.players.find((player) => player.id === state.leaderId)!;
    const bots = room.players.filter((player) => player.isAI);

    manager.proposeTeam(host.roomCode, leader.id, leader.sessionToken, bots.slice(0, state.teamSize).map((player) => player.id));
    expect(manager.getPublicState(host.roomCode).voteSubmitted).toContain(host.playerId);
    for (const bot of bots.filter((player) => player.id !== leader.id)) {
      manager.submitVote(host.roomCode, bot.id, bot.sessionToken, true);
    }
    expect(manager.getPublicState(host.roomCode).phase).toBe("mission");
    manager.close();
  });

  it("defaults a mission member who disconnected during voting in an AI room", () => {
    const manager = new RoomManager([]);
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    const room = manager.getRoom(host.roomCode)!;
    const leader = room.players.find((player) => player.id === manager.getPublicState(host.roomCode).leaderId)!;
    const botMember = room.players.find((player) => player.isAI)!;
    manager.proposeTeam(host.roomCode, leader.id, leader.sessionToken, [host.playerId, botMember.id]);
    manager.disconnectPlayer(host.playerId);
    for (const player of room.players) {
      if (player.connected && manager.getPrivateState(host.roomCode, player.id).canVote) {
        manager.submitVote(host.roomCode, player.id, player.sessionToken, true);
      }
    }
    expect(manager.getPublicState(host.roomCode).missionSubmitted).toContain(host.playerId);

    manager.submitMission(host.roomCode, botMember.id, botMember.sessionToken, false);

    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "missionResult", score: { success: 1, fail: 0 } });
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "speech", timer: { kind: "speech", durationMs: 60_000 } });
    expect(manager.getPublicState(host.roomCode).speechOrder).toHaveLength(4);
    vi.advanceTimersByTime(12_000);
    expect(manager.getPublicState(host.roomCode).phase).toBe("team");
    manager.close();
  });

  it.each([5, 6, 7, 8, 9, 10])("reveals every evil role, but no good roles, for %i-player two-minute assassination", count => {
    const { manager, players, roomCode } = createStartedRoom(count);
    for (let quest = 0; quest < 2; quest++) completeSuccessfulMission(manager, roomCode);
    completeMissionCards(manager, roomCode);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "missionResult", revealedRoles: [] });
    vi.advanceTimersByTime(MISSION_RESULT_DURATION_MS);
    const state = manager.getPublicState(roomCode);
    const evil = players.filter(player => manager.getPrivateState(roomCode, player.playerId).side === "evil");
    expect(state).toMatchObject({ phase: "assassin", speechOrder: [], timer: { kind: "assassin", durationMs: 120_000 }, winner: null });
    expect(state.revealedRoles.map(role => role.playerId)).toEqual(evil.map(player => player.playerId));
    expect(state.revealedRoles.every(role => role.side === "evil")).toBe(true);
    if (count >= 9) expect(state.revealedRoles.some(role => role.role === "oberon")).toBe(true);
    expect(state.players.every(player => !("role" in player))).toBe(true);
    for (const player of players) expect(manager.getPrivateState(roomCode, player.playerId).canAssassinate).toBe(manager.getPrivateState(roomCode, player.playerId).role === "assassin");
    const deadline = state.timer!.deadline;
    vi.advanceTimersByTime(60_000);
    manager.syncPlayerSession(roomCode, players[0].playerId, players[0].sessionToken);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "assassin", timer: { deadline } });
    manager.close();
  });

  it.each(["lobby", "reveal", "team", "vote", "proposalResult", "mission", "missionResult", "speech", "result"] as const)("rejects assassination outside its stage: %s", phase => {
    const { manager, players, roomCode } = createStartedRoom(5);
    const assassin = players.find(player => manager.getPrivateState(roomCode, player.playerId).role === "assassin")!;
    const merlin = players.find(player => manager.getPrivateState(roomCode, player.playerId).role === "merlin")!;
    manager.getRoom(roomCode)!.phase = phase;
    const before = manager.getPublicState(roomCode);
    expect(manager.getPrivateState(roomCode, assassin.playerId).canAssassinate).toBe(false);
    expect(() => manager.chooseAssassinTarget(roomCode, assassin.playerId, assassin.sessionToken, merlin.playerId)).toThrow("当前不是刺客阶段");
    expect(manager.getPublicState(roomCode)).toEqual(before);
    manager.close();
  });

  it.each([true, false])("allows early assassin submission and settles Merlin hit=%s immediately", hit => {
    const { manager, players, roomCode } = createStartedRoom(5);
    for (let quest = 0; quest < 3; quest++) completeSuccessfulMission(manager, roomCode);
    const assassin = players.find(player => manager.getPrivateState(roomCode, player.playerId).role === "assassin")!;
    const target = players.find(player => manager.getPrivateState(roomCode, player.playerId).side === "good" && (manager.getPrivateState(roomCode, player.playerId).role === "merlin") === hit)!;
    const evil = players.find(player => player.playerId !== assassin.playerId && manager.getPrivateState(roomCode, player.playerId).side === "evil")!;
    expect(() => manager.chooseAssassinTarget(roomCode, assassin.playerId, assassin.sessionToken, evil.playerId)).toThrow("已亮明身份");
    manager.chooseAssassinTarget(roomCode, assassin.playerId, assassin.sessionToken, target.playerId);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "result", winner: hit ? "evil" : "good", timer: null });
    expect(manager.getPublicState(roomCode).revealedRoles).toHaveLength(5);
    vi.advanceTimersByTime(ASSASSINATION_DURATION_MS);
    expect(manager.getPublicState(roomCode).winner).toBe(hit ? "evil" : "good");
    manager.close();
  });

  it("keeps an AI assassin from shooting before allies have the full discussion window", () => {
    const manager = new RoomManager([]);
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    vi.spyOn(Math, "random").mockReturnValue(.999);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    for (let quest = 0; quest < 3; quest++) completeSuccessfulMission(manager, host.roomCode);
    expect(manager.getRoom(host.roomCode)!.players.find(player => player.role === "assassin")!.isAI).toBe(true);
    vi.advanceTimersByTime(ASSASSINATION_DURATION_MS - 1);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "assassin", winner: null });
    vi.advanceTimersByTime(1);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "result", timer: null });
    manager.close();
  });

  it("lets a disconnected assassin rejoin and choose before the deadline", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    for (let quest = 0; quest < 3; quest += 1) completeSuccessfulMission(manager, roomCode);
    const assassin = players.find((player) => manager.getPrivateState(roomCode, player.playerId).role === "assassin")!;
    const merlin = players.find((player) => manager.getPrivateState(roomCode, player.playerId).role === "merlin")!;
    expect(manager.getPublicState(roomCode).timer).toMatchObject({ kind: "assassin", durationMs: ASSASSINATION_DURATION_MS });
    manager.disconnectPlayer(assassin.playerId);
    vi.advanceTimersByTime(10_000);
    expect(manager.getPublicState(roomCode).phase).toBe("assassin");
    manager.rejoinRoom(roomCode, assassin.playerId, assassin.sessionToken);
    manager.chooseAssassinTarget(roomCode, assassin.playerId, assassin.sessionToken, merlin.playerId);
    vi.advanceTimersByTime(30_000);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "result", winner: "evil", timer: null });
  });

  it("settles a disconnected assassin as a good victory when the deadline expires", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    for (let quest = 0; quest < 3; quest += 1) completeSuccessfulMission(manager, roomCode);
    const assassin = players.find((player) => manager.getPrivateState(roomCode, player.playerId).role === "assassin")!;
    manager.disconnectPlayer(assassin.playerId);
    vi.advanceTimersByTime(ASSASSINATION_DURATION_MS);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "result", winner: "good", timer: null });
  });

  it("settles an assassin who disconnected before the third mission", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    completeSuccessfulMission(manager, roomCode);
    completeSuccessfulMission(manager, roomCode);
    const assassin = players.find((player) => manager.getPrivateState(roomCode, player.playerId).role === "assassin")!;
    manager.disconnectPlayer(assassin.playerId);
    completeSuccessfulMission(manager, roomCode);
    expect(manager.getPublicState(roomCode).phase).toBe("assassin");
    vi.advanceTimersByTime(ASSASSINATION_DURATION_MS);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "result", winner: "good", timer: null });
  });

  it("immediately settles an assassin who explicitly leaves the assassination phase", () => {
    vi.useFakeTimers();
    const { manager, players, roomCode } = createStartedRoom(5);
    for (let quest = 0; quest < 3; quest += 1) completeSuccessfulMission(manager, roomCode);
    const assassin = players.find((player) => manager.getPrivateState(roomCode, player.playerId).role === "assassin")!;
    manager.leaveRoom(roomCode, assassin.playerId, assassin.sessionToken);
    expect(manager.getPublicState(roomCode)).toMatchObject({ phase: "result", winner: "good", timer: null });
    expect(manager.getPublicState(roomCode).winnerReason).toContain("放弃刺杀");
    vi.advanceTimersByTime(30_000);
    expect(manager.getPublicState(roomCode).winner).toBe("good");
  });

  it("keeps an assassination deadline for human assassins in rooms containing AI", () => {
    vi.useFakeTimers();
    const manager = new RoomManager([]);
    const host = manager.createRoom("Host");
    for (let index = 2; index <= 4; index += 1) {
      const player = manager.joinRoom(host.roomCode, `P${index}`);
      manager.setPlayerReady(host.roomCode, player.playerId, player.sessionToken, true);
    }
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 1);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    } finally {
      random.mockRestore();
    }
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    const assassin = manager.getRoom(host.roomCode)!.players.find((player) => player.role === "assassin")!;
    expect(assassin.isAI).toBe(false);
    for (let quest = 0; quest < 3; quest += 1) completeSuccessfulMission(manager, host.roomCode);
    expect(manager.getPublicState(host.roomCode).timer?.kind).toBe("assassin");
    manager.disconnectPlayer(assassin.id);
    vi.advanceTimersByTime(ASSASSINATION_DURATION_MS);
    expect(manager.getPublicState(host.roomCode)).toMatchObject({ phase: "result", winner: "good", timer: null });
  });

  it("cancels queued AI actions when closing the room manager", () => {
    vi.useFakeTimers();
    const manager = new RoomManager([]);
    const host = manager.createRoom("Host");
    manager.addAIPlayers(host.roomCode, host.playerId, host.sessionToken, 4);
    manager.startRoom(host.roomCode, host.playerId, host.sessionToken);
    const room = manager.getRoom(host.roomCode)!;
    room.leaderIndex = room.players.findIndex((player) => player.isAI);
    vi.advanceTimersByTime(ROLE_REVEAL_DURATION_MS);
    manager.simulateAI(host.roomCode);
    manager.close();
    vi.advanceTimersByTime(1500);
    expect(manager.getPublicState(host.roomCode).phase).toBe("team");
    expect(room.aiSimulating).toBe(false);
  });

  it("rejects assassin choosing themselves", () => {
    const { manager, roomCode } = createStartedRoom(5);
    const room = manager.getRoom(roomCode) as any;
    const assassin = room.players.find((player: any) => player.role === "assassin");
    room.phase = "assassin";

    expect(() => manager.chooseAssassinTarget(roomCode, assassin.id, assassin.sessionToken, assassin.id)).toThrow("刺客不能选择自己");
  });
});
