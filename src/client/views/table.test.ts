import { describe, expect, it, vi } from "vitest";
import type { PublicRoomState, QuestHistoryEntry } from "../../shared/game";
import type { GameViewContext } from "./context";

vi.mock("../icons", () => ({ icon: (name: string) => `<svg data-icon="${name}"></svg>` }));
const { missionCardSlots, renderRoundTable, seatVoteToken } = await import("./table");

const ids = ["p_a", "p_b", "p_c", "p_d", "p_e"];
const approvedVote: QuestHistoryEntry = {
  type: "vote", quest: 1, leader: "p_a", team: ["p_a", "p_b"], approvals: 3, rejections: 2, result: "success",
  voteDetails: [
    { playerId: "p_a", approved: true }, { playerId: "p_b", approved: true }, { playerId: "p_c", approved: false },
    { playerId: "p_d", approved: true }, { playerId: "p_e", approved: false },
  ],
};

function state(overrides: Partial<PublicRoomState> = {}): PublicRoomState {
  return {
    phaseId: `phase_${"a".repeat(32)}`, roomCode: "ABCDE", phase: "team",
    players: ids.map((id, position) => ({ id, name: `P${position}`, isHost: position === 0, connected: true, position, ready: true })),
    hostId: "p_a", targetPlayerCount: 5, localUrls: [], leaderId: "p_a", questIndex: 0, teamSize: 2, requiredFails: 1,
    rejectCount: 0, score: { success: 0, fail: 0 }, proposal: [], voteSubmitted: [], missionSubmitted: [], history: [],
    winner: null, winnerReason: "", revealedRoles: [], servantCounts: null, speechOrder: [], timer: null,
    ...overrides,
  };
}

function context(publicState: PublicRoomState, extra: Partial<GameViewContext> = {}): GameViewContext {
  return {
    publicState, privateState: null, identity: { playerId: "p_a" }, pendingTeam: new Set(), pendingQuestIndex: 0,
    pendingAssassinTarget: null, pendingActions: new Set(), serverConnected: true, roleConfigurationExpanded: false,
    hidePrivateRole: false, expandedVoteRecords: new Set(), ...extra,
  };
}

describe("round table staging", () => {
  it("keeps cast votes face-down until the vote is decided", () => {
    const voting = state({ phase: "vote", proposal: ["p_a", "p_b"], voteSubmitted: ["p_a", "p_c"] });
    expect(ids.map(id => seatVoteToken(voting, id))).toEqual(["sealed", null, "sealed", null, null]);
  });

  it("turns every vote over during the mission the vote approved", () => {
    const mission = state({ phase: "mission", proposal: ["p_a", "p_b"], history: [approvedVote] });
    expect(ids.map(id => seatVoteToken(mission, id))).toEqual(["approve", "approve", "reject", "approve", "reject"]);
  });

  it("shows no tokens for a forced launch or outside voting and missions", () => {
    const forced = state({ phase: "mission", proposal: ["p_a", "p_b"], history: [{ ...approvedVote, voteDetails: [], forced: true }] });
    expect(seatVoteToken(forced, "p_a")).toBeNull();
    expect(seatVoteToken(state({ phase: "speech", history: [approvedVote] }), "p_a")).toBeNull();
  });

  it("lays one face-down card per submitted mission member", () => {
    expect(missionCardSlots(state({ phase: "mission", proposal: ["p_a", "p_b", "p_c"], missionSubmitted: ["p_b"] }))).toEqual({ placed: 1, total: 3 });
    expect(missionCardSlots(state({ phase: "vote", proposal: ["p_a", "p_b"] }))).toBeNull();
  });

  it("renders tokens, table cards and a re-keyed token once votes are revealed", () => {
    const voting = renderRoundTable(context(state({ phase: "vote", proposal: ["p_a", "p_b"], voteSubmitted: ["p_c"] })), "p_a");
    expect(voting).toContain('class="vote-token sealed" data-render-key="token:p_c:sealed"');

    const mission = renderRoundTable(context(state({ phase: "mission", proposal: ["p_a", "p_b"], missionSubmitted: ["p_a"], history: [approvedVote] })), "p_a");
    expect(mission).toContain('class="vote-token reject" data-render-key="token:p_c:open"');
    expect(mission.match(/class="table-card placed"/g)).toHaveLength(1);
    expect(mission.match(/class="table-card "/g)).toHaveLength(1);
  });

  it("marks the current speaker and the assassin's chosen target", () => {
    const speech = renderRoundTable(context(state({ phase: "speech", timer: { kind: "speech", label: "", deadline: 0, durationMs: 60_000, speakerId: "p_b" } })), "p_a");
    expect(speech.match(/class="seat-speaking"/g)).toHaveLength(1);

    const assassin = renderRoundTable(context(state({ phase: "assassin" }), { pendingAssassinTarget: "p_d" }), "p_a");
    expect(assassin).toContain('data-icon="crosshair"');
    expect(assassin).not.toContain("seat-selected");
    expect(assassin).toContain("刺杀目标");
    expect(assassin).not.toContain("任务队员");
  });
});
