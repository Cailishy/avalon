import { describe, expect, it } from "vitest";
import { evaluateMission, evaluateProposalVote, forcedProposalHistory } from "./roomRules";

describe("room domain rules", () => {
  it("does not decide a proposal until every player has voted", () => {
    const votes = new Map([["p_a", true], ["p_b", false]]);

    expect(evaluateProposalVote({ playerCount: 5, questIndex: 0, leaderId: "p_a", team: ["p_a", "p_c"], votes })).toBeNull();
    expect(votes).toEqual(new Map([["p_a", true], ["p_b", false]]));
  });

  it.each([
    [5, 3],
    [6, 4],
    [7, 4],
    [8, 5],
  ])("rejects a proposal only when rejections exceed half of %i players", (playerCount, rejections) => {
    const votes = new Map<string, boolean>();
    for (let index = 0; index < playerCount; index += 1) votes.set(`p_${index}`, index >= rejections);

    const decision = evaluateProposalVote({ playerCount, questIndex: 0, team: ["p_0"], votes });
    expect(decision?.accepted).toBe(false);
    expect(decision?.rejections).toBe(rejections);
  });

  it("keeps an exact half of rejections as an approved proposal", () => {
    const votes = new Map([["p_0", false], ["p_1", false], ["p_2", true], ["p_3", true], ["p_4", true], ["p_5", true]]);

    const decision = evaluateProposalVote({ playerCount: 6, questIndex: 1, team: ["p_1", "p_2", "p_3"], votes });
    expect(decision).toMatchObject({ accepted: true, approvals: 4, rejections: 2, history: { result: "success", quest: 2 } });
  });

  it("uses two failures for mission four in games with at least seven players", () => {
    const missionVotes = new Map([["p_1", true], ["p_2", true], ["p_3", false], ["p_4", false]]);

    const decision = evaluateMission({ playerCount: 7, questIndex: 3, leaderId: "p_0", team: ["p_1", "p_2", "p_3", "p_4"], missionVotes });
    expect(decision).toMatchObject({ questFailed: true, fails: 2, requiredFails: 2, history: { type: "mission", quest: 4, result: "fail" } });
  });

  it("returns a detached forced-launch history entry", () => {
    const team = ["p_1", "p_2"];
    const history = forcedProposalHistory({ questIndex: 2, leaderId: "p_0", team });
    team.push("p_3");

    expect(history).toMatchObject({ type: "vote", quest: 3, forced: true, approvals: 0, rejections: 0, voteDetails: [] });
    expect(history.team).toEqual(["p_1", "p_2"]);
  });
});
