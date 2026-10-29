import { describe, expect, it } from "vitest";
import type { PublicRoomState } from "./game";
import { MISSION_RESULT_DURATION_MS, PROPOSAL_REJECTION_DURATION_MS, ROLE_REVEAL_DURATION_MS } from "./game";
import { NARRATION_CUES, NARRATION_VOICE, narrationCue } from "./narration";

function state(phase: PublicRoomState["phase"]): PublicRoomState {
  return {
    phaseId: `phase_${"a".repeat(32)}`,
    roomCode: "TEST", phase, players: Array.from({ length: 5 }, (_, position) => ({
      id: `p${position}`, name: `玩家${position}`, isHost: position === 0, position, ready: true, connected: true,
    })), hostId: "p0", targetPlayerCount: 5, localUrls: [], leaderId: "p0", questIndex: 0,
    teamSize: 2, requiredFails: 1, rejectCount: 0, score: { success: 0, fail: 0 }, proposal: ["p0", "p1"],
    voteSubmitted: [], missionSubmitted: [], history: [], winner: null, winnerReason: "", revealedRoles: [],
    servantCounts: null, speechOrder: [], timer: null,
  };
}

function outcome(result: "success" | "fail", success = 0, fail = 0): PublicRoomState {
  return { ...state("missionResult"), score: { success, fail }, history: [{ type: "mission", quest: 1, team: ["p0", "p1"], result }] };
}

describe("Fixed narration production scripts", () => {
  it("stays silent during restart recovery and does not replay a previous result after reconnect", () => {
    const current = state("team");
    current.recovery = { deadline: Date.now() + 60000, connected: 1, expected: 5 };
    expect(narrationCue(current, null)).toBeNull();
    expect(narrationCue(state("team"), current)).toBe("team-select");
    const result = outcome("success");
    expect(narrationCue(result, { ...result, recovery: current.recovery })).toBeNull();
  });
  it("records the approved narrator and keeps every output filename finite and safe", () => {
    expect(NARRATION_VOICE.name).toBe("Serene Narrator - Deep,Resonant,Measured");
    expect(NARRATION_VOICE.speed).toBe(.9);
    expect(Object.keys(NARRATION_CUES)).toHaveLength(16);
    for (const [id, cue] of Object.entries(NARRATION_CUES)) {
      expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(cue.text.trim()).not.toBe("");
      expect(cue.text).not.toMatch(/[{}<>]|https?:|\$\{/);
      expect(cue.maxDurationMs).toBeGreaterThan(0);
    }
  });

  it("fits result clips inside server-owned presentation windows and short AI turns", () => {
    expect(NARRATION_CUES["game-reveal"].maxDurationMs).toBeLessThan(ROLE_REVEAL_DURATION_MS);
    expect(NARRATION_CUES["proposal-rejected"].maxDurationMs).toBeLessThan(PROPOSAL_REJECTION_DURATION_MS);
    for (const id of ["mission-success", "mission-failure", "mission-three-successes", "mission-three-failures"] as const) {
      expect(NARRATION_CUES[id].maxDurationMs).toBeLessThan(MISSION_RESULT_DURATION_MS);
    }
    expect(NARRATION_CUES["speech-start"].maxDurationMs).toBeLessThan(3_000);
    expect(NARRATION_CUES["speech-next"].maxDurationMs).toBeLessThan(3_000);
  });

  it.each([
    ["lobby", null], ["reveal", "game-reveal"], ["team", "team-select"],
    ["vote", "team-vote"], ["mission", "mission-play"], ["assassin", "assassination"],
  ] as const)("selects only the current public phase: %s", (phase, expected) => {
    expect(narrationCue(state(phase), null)).toBe(expected);
  });

  it.each([5, 6, 7, 8, 9, 10])("keeps forced launches distinct in %i-player games", count => {
    const current = state("team");
    current.players = Array.from({ length: count }, (_, position) => ({ ...current.players[0], id: `p${position}`, position }));
    expect(narrationCue({ ...current, rejectCount: count - 2 }, null)).toBe("team-select");
    expect(narrationCue({ ...current, rejectCount: count - 1 }, null)).toBe("team-select-forced");
    expect(narrationCue({ ...current, phase: "mission", history: [{ type: "vote", quest: 1, team: ["p0"], result: "success", forced: true }] }, current)).toBe("mission-play-forced");
    expect(NARRATION_CUES["mission-play-forced"].text).not.toContain("队伍通过");
  });

  it("does not replay rejection history on join or pretend a passed split vote was rejected", () => {
    const current: PublicRoomState = { ...state("proposalResult"), history: [{ type: "vote", quest: 1, team: ["p0"], approvals: 2, rejections: 3, result: "fail" }] };
    expect(narrationCue(current, state("vote"))).toBe("proposal-rejected");
    expect(narrationCue(current, null)).toBeNull();
    expect(narrationCue(current, current)).toBeNull();
    expect(narrationCue({ ...current, history: [{ ...current.history[0], result: "success" }] }, state("vote"))).toBeNull();
    expect(NARRATION_CUES["proposal-rejected"].text).not.toContain("发言");
  });

  it.each(["success", "fail"] as const)("selects a fresh %s result without replaying it on reconnect", result => {
    const current = outcome(result);
    expect(narrationCue(current, state("mission"))).toBe(result === "success" ? "mission-success" : "mission-failure");
    expect(narrationCue(current, null)).toBeNull();
    expect(narrationCue(current, current)).toBeNull();
    expect(narrationCue(current, { ...state("mission"), roomCode: "OTHER" })).toBeNull();
  });

  it("does not announce speeches after three successes or failures", () => {
    expect(narrationCue(outcome("success", 3, 1), state("mission"))).toBe("mission-three-successes");
    expect(narrationCue(outcome("fail", 2, 3), state("mission"))).toBe("mission-three-failures");
    expect(NARRATION_CUES["mission-three-successes"].text).toContain("讨论与刺杀");
    expect(NARRATION_CUES["mission-three-successes"].text).not.toContain("发言");
    expect(NARRATION_CUES["mission-three-failures"].text).toContain("藏锋者获胜");
    expect(NARRATION_CUES["mission-three-failures"].text).not.toContain("发言");
  });

  it("announces speaker changes but not timer or nickname changes", () => {
    const current: PublicRoomState = { ...state("speech"), timer: { kind: "speech", label: "", durationMs: 60_000, deadline: 60_000, speakerId: "p0" } };
    expect(narrationCue(current, state("missionResult"))).toBe("speech-start");
    expect(narrationCue(current, current)).toBeNull();
    expect(narrationCue({ ...current, timer: { ...current.timer!, speakerId: "p1" } }, current)).toBe("speech-next");
    expect(narrationCue({ ...current, timer: { ...current.timer!, deadline: 61_000 } }, current)).toBeNull();
    expect(narrationCue(state("speech"), current)).toBeNull();
  });

  it("never turns nicknames, teams or final reasons into generated speech", () => {
    const current = state("vote");
    current.players[0].name = "私密昵称不可上传";
    current.winnerReason = "私密原因不可上传";
    const id = narrationCue(current, null)!;
    expect(NARRATION_CUES[id].text).not.toContain("私密");
    expect(NARRATION_CUES[id].text).not.toContain("玩家0");
    expect(narrationCue({ ...current, phase: "result", winner: "good" }, null)).toBe("victory-good");
    expect(narrationCue({ ...current, phase: "result", winner: "evil" }, null)).toBe("victory-evil");
    expect(narrationCue({ ...current, phase: "result" }, null)).toBeNull();
  });
});
