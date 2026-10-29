import { describe, expect, it } from "vitest";
import type { QuestHistoryEntry } from "../shared/game";
import { getCompletedQuestDetails } from "./questDetails";

const passed: QuestHistoryEntry = { type: "vote", quest: 3, leader: "B", team: ["A", "C"], approvals: 3, rejections: 2, result: "success", voteDetails: [{ playerId: "B", approved: true }] };
const mission: QuestHistoryEntry = { type: "mission", quest: 3, leader: "B", team: ["C", "A"], fails: 1, result: "fail" };

describe("Completed quest details", () => {
  it("pairs the mission with its accepted proposal, not rejected attempts or later records", () => {
    const history: QuestHistoryEntry[] = [
      { ...passed, result: "fail", approvals: 2, rejections: 3 },
      { ...passed, quest: 1 }, passed, mission, { ...passed, leader: "D" },
    ];
    expect(getCompletedQuestDetails({ history }, 2)).toEqual({ mission, proposal: passed });
  });

  it("does not borrow a vote from a different leader or team", () => {
    const history: QuestHistoryEntry[] = [{ ...passed, leader: "D" }, { ...passed, team: ["A", "D"] }, mission];
    expect(getCompletedQuestDetails({ history }, 2)).toEqual({ mission, proposal: null });
  });

  it("keeps forced launches exempt from voting without inventing approval counts", () => {
    const forced = { ...passed, forced: true, approvals: 0, rejections: 0, voteDetails: [] };
    expect(getCompletedQuestDetails({ history: [forced, mission] }, 2)?.proposal).toEqual(forced);
  });

  it("supports both mission outcomes and keeps only the public anonymous card totals", () => {
    for (const result of ["success", "fail"] as const) {
      const detail = getCompletedQuestDetails({ history: [passed, { ...mission, result }] }, 2)!;
      expect(detail.mission.result).toBe(result);
      expect(detail.mission.fails).toBe(1);
      expect(detail.mission).not.toHaveProperty("missionVotes");
    }
  });

  it("returns no details for an unfinished quest even if a proposal was accepted", () => {
    expect(getCompletedQuestDetails({ history: [passed] }, 2)).toBeNull();
  });

  it.each([-1, 5, 1.5, NaN])("rejects invalid quest index %s", questIndex => {
    expect(getCompletedQuestDetails({ history: [passed, mission] }, questIndex)).toBeNull();
  });
});
