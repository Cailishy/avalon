import { describe, expect, it, vi } from "vitest";
import { ALIGNMENT_COUNTS, ROLE_DEFS, buildRoles, getRoleCounts, getRequiredFails, getRequiredSuccesses, getTeamSize, getProposalRejectionThreshold, isForcedLaunch } from "./game";

describe("Avalon rules", () => {
  it.each([[5, 3], [6, 4], [7, 4], [8, 5], [9, 5], [10, 6]])("requires %i-player proposals to receive %i objections to be rejected", (count, threshold) => {
    expect(getProposalRejectionThreshold(count)).toBe(threshold);
    expect(threshold).toBeGreaterThan(count / 2);
    expect(threshold - 1).toBeLessThanOrEqual(count / 2);
  });
  it.each([5, 6, 7, 8, 9, 10])("exposes public role counts matching the actual deck for %i players", count => {
    const config = getRoleCounts(count);
    expect(config.reduce((total, item) => total + item.count, 0)).toBe(count);
    expect(new Set(config.map(item => item.role)).size).toBe(config.length);
    for (const side of ["good", "evil"] as const) {
      expect(config.filter(item => ROLE_DEFS[item.role].side === side).reduce((total, item) => total + item.count, 0)).toBe(ALIGNMENT_COUNTS[count][side]);
    }
    for (const random of [() => 0, () => .999]) {
      const dealt = buildRoles(count, random);
      for (const item of config) expect(dealt.filter(role => role === item.role)).toHaveLength(item.count);
    }
    expect(config.find(item => item.role === "servant")?.count).toBe(ALIGNMENT_COUNTS[count].good - 2);
    expect(config.some(item => item.role === "minion")).toBe(false);
    expect(config.some(item => item.role === "mordred")).toBe(count >= 7);
    expect(config.some(item => item.role === "oberon")).toBe(count >= 9);
  });

  it("does not consume game randomness while reading role configuration", () => {
    const random = vi.spyOn(Math, "random");
    try {
      expect(getRoleCounts(10)).toEqual(getRoleCounts(10));
      expect(random).not.toHaveBeenCalled();
      expect(() => getRoleCounts(4)).toThrow("5 到 10");
    } finally { random.mockRestore(); }
  });
  it("assigns valid good and evil counts for 5-10 players", () => {
    for (let count = 5; count <= 10; count += 1) {
      const roles = buildRoles(count, () => 0.42);
      const expected = ALIGNMENT_COUNTS[count];
      const good = roles.filter((role) => ROLE_DEFS[role].side === "good").length;
      const evil = roles.filter((role) => ROLE_DEFS[role].side === "evil").length;

      expect(roles).toHaveLength(count);
      expect(good).toBe(expected.good);
      expect(evil).toBe(expected.evil);
      expect(roles).toContain("merlin");
      expect(roles).toContain("assassin");
      expect(roles).not.toContain("minion");
    }
  });

  it("uses configured team sizes with the custom five-player quest order", () => {
    expect([0, 1, 2, 3, 4].map((quest) => getTeamSize(5, quest))).toEqual([2, 2, 3, 3, 3]);
    expect([0, 1, 2, 3, 4].map((quest) => getTeamSize(6, quest))).toEqual([2, 3, 4, 3, 4]);
    expect([0, 1, 2, 3, 4].map((quest) => getTeamSize(7, quest))).toEqual([2, 3, 3, 4, 4]);
    expect([0, 1, 2, 3, 4].map((quest) => getTeamSize(10, quest))).toEqual([3, 4, 4, 5, 5]);
  });

  it("requires two fails on the fourth quest for 7+ players only", () => {
    expect(getRequiredFails(5, 3)).toBe(1);
    expect(getRequiredFails(6, 3)).toBe(1);
    expect(getRequiredFails(7, 3)).toBe(2);
    expect(getRequiredFails(10, 3)).toBe(2);
    expect(getRequiredFails(10, 2)).toBe(1);
  });
  it("calculates the minimum successful cards without changing failure thresholds", () => {
    expect(getRequiredSuccesses(5, 0)).toBe(2);
    expect(getRequiredSuccesses(7, 3)).toBe(3);
    expect(getRequiredSuccesses(10, 3)).toBe(4);
    for (let count = 5; count <= 10; count++) {
      for (let quest = 0; quest < 5; quest++) {
        const size = getTeamSize(count, quest);
        const successes = getRequiredSuccesses(count, quest);
        expect(size - successes).toBeLessThan(getRequiredFails(count, quest));
        expect(size - (successes - 1)).toBeGreaterThanOrEqual(getRequiredFails(count, quest));
      }
    }
  });
  it.each([5, 6, 7, 8, 9, 10])("forces proposal %i based on the actual player count", count => {
    for (let rejects = 0; rejects < count - 1; rejects++) expect(isForcedLaunch(rejects, count)).toBe(false);
    expect(isForcedLaunch(count - 1, count)).toBe(true);
  });
});
