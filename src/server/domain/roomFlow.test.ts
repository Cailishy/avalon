import { describe, expect, it } from "vitest";
import { buildSpeechOrder, findNextLeaderIndex, nextOpenQuestIndex, resolveQuestIndex } from "./roomFlow";

describe("room flow rules", () => {
  it("rotates to the next connected leader", () => {
    const players = [
      { id: "a", connected: true },
      { id: "b", connected: false },
      { id: "c", connected: true },
    ];
    expect(findNextLeaderIndex(players, 0)).toBe(2);
    expect(findNextLeaderIndex(players, 2)).toBe(0);
  });

  it("builds speech order after the next leader", () => {
    const players = [
      { id: "a", connected: true },
      { id: "b", connected: true },
      { id: "c", connected: false },
      { id: "d", connected: true },
    ];
    expect(buildSpeechOrder(players, 1)).toEqual(["d", "a", "b"]);
  });

  it("skips completed quests when choosing the next quest", () => {
    expect(nextOpenQuestIndex([
      { type: "mission", quest: 1, team: [], fails: 0, result: "success" },
      { type: "mission", quest: 3, team: [], fails: 1, result: "fail" },
    ], 2)).toBe(1);
  });

  it("rejects a repeated quest and validates its team size", () => {
    expect(() => resolveQuestIndex({ requestedIndex: 0, currentIndex: 0, playerCount: 5, history: [
      { type: "mission", quest: 1, team: [], fails: 0, result: "success" },
    ] })).toThrow("该任务已经完成");
    expect(resolveQuestIndex({ requestedIndex: 1, currentIndex: 0, playerCount: 5, history: [] })).toBe(1);
  });
});
