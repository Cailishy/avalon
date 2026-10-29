import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announcementKey, GameAudio, musicMode } from "./audio";
import { narrationAsset } from "./narrationAssets";
import type { PublicRoomState } from "../shared/game";

function state(phase: PublicRoomState["phase"] = "team"): PublicRoomState {
  return { phaseId: `phase_${"a".repeat(32)}`, roomCode: "TEST", phase, players: [
    { id: "host", name: "队长甲", position: 0, isHost: true, ready: false, connected: true },
    { id: "other", name: "玩家乙", position: 1, isHost: false, ready: true, connected: true },
    ...Array.from({ length: 3 }, (_, index) => ({ id: "p" + (index + 3), name: "玩家" + (index + 3), position: index + 2, isHost: false, ready: true, connected: true })),
  ], hostId: "host", targetPlayerCount: 5, localUrls: [], leaderId: "host", questIndex: 0,
    teamSize: 2, requiredFails: 1, rejectCount: 0, score: { success: 0, fail: 0 }, proposal: [],
    voteSubmitted: [], missionSubmitted: [], history: [], winner: null, winnerReason: "", revealedRoles: [], servantCounts: null, speechOrder: [], timer: null };
}

function outcome(result: "success" | "fail", score = { success: 0, fail: 0 }): PublicRoomState {
  return { ...state("missionResult"), score, history: [{ type: "mission", quest: 1, team: ["host", "other"], result, fails: result === "fail" ? 1 : 0 }] };
}

function rejected(): PublicRoomState {
  return { ...state("proposalResult"), rejectCount: 1, history: [{ type: "vote", quest: 1, team: ["host", "other"], approvals: 2, rejections: 3, result: "fail" }] };
}

class Track {
  loop = false; preload = ""; volume = 0; hidden = false; paused = true; currentTime = 0;
  dataset: Record<string, string> = {};
  error: { code: number } | null = null;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  remove = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => { if (name === "src") this.src = ""; });
  readonly initialSrc: string;
  constructor(public src: string) {
    this.initialSrc = src;
    tracks.push(this);
    if (src.includes("/narration/") && nextNarrationPlay) {
      this.play.mockImplementationOnce(nextNarrationPlay);
      nextNarrationPlay = null;
    }
  }
}

let tracks: Track[];
let nextNarrationPlay: (() => Promise<void>) | null;
let controller: GameAudio;
let onError = vi.fn<(message: string) => void>();
let tts: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
const narrations = () => tracks.filter(track => !!track.dataset.narrationCue);
const music = (mode: "waiting" | "game") => tracks.find(track => track.dataset.musicMode === mode)!;
const lastCue = () => narrations().at(-1)?.dataset.narrationCue;

beforeEach(() => {
  vi.useFakeTimers();
  tracks = []; nextNarrationPlay = null;
  tts = { speak: vi.fn(), cancel: vi.fn() };
  vi.stubGlobal("Audio", Track);
  vi.stubGlobal("SpeechSynthesisUtterance", vi.fn());
  vi.stubGlobal("window", { speechSynthesis: tts });
  vi.stubGlobal("document", { body: { appendChild: vi.fn() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  onError = vi.fn<(message: string) => void>();
  controller = new GameAudio(onError);
});
afterEach(() => {
  controller.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Prerecorded public game narration", () => {
  it("works without Web Speech and only loads the same-origin approved clip", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("SpeechSynthesisUtterance", undefined);
    controller.setPreferences({ music: false });
    controller.update(state(), "host", true);
    controller.unlock();
    expect(controller.narrationSupported).toBe(true);
    expect(lastCue()).toBe("team-select");
    expect(narrations()[0].initialSrc).toBe(narrationAsset("team-select").src);
    expect(narrations()[0].initialSrc).toMatch(/^\/assets\/narration\/[a-z-]+\.[a-f0-9]{12}\.mp3$/);
    expect(tts.speak).not.toHaveBeenCalled();
    expect(tts.cancel).not.toHaveBeenCalled();
  });

  it("waits for a gesture and discards older phases before unlocking", () => {
    controller.setPreferences({ music: false, narration: true });
    controller.update(state("reveal"), "host", true);
    controller.update(state("team"), "host", true);
    expect(tracks).toHaveLength(0);
    controller.unlock();
    expect(narrations()).toHaveLength(1);
    expect(lastCue()).toBe("team-select");
    controller.unlock();
    expect(narrations()[0].play).toHaveBeenCalledOnce();
  });

  it("deduplicates heartbeats, submissions, nickname changes and countdown updates", () => {
    controller.setPreferences({ music: false });
    controller.unlock();
    const current = state("vote");
    controller.update(current, "host", true);
    controller.update({ ...current, voteSubmitted: ["other"], missionSubmitted: ["host"], winnerReason: "not spoken",
      players: current.players.map(player => ({ ...player, name: "different" })) }, "host", true);
    expect(narrations()).toHaveLength(1);
    expect(lastCue()).toBe("team-vote");
    expect(announcementKey(current)).toBe(announcementKey({ ...current, voteSubmitted: ["other"] }));
    const speech = { ...state("speech"), timer: { kind: "speech" as const, durationMs: 60_000, deadline: Date.now() + 60_000, label: "", speakerId: "host" } };
    controller.update(speech, "host", true);
    controller.update({ ...speech, timer: { ...speech.timer, deadline: speech.timer.deadline + 1000 } }, "host", true);
    expect(narrations()).toHaveLength(2);
    controller.update({ ...speech, timer: { ...speech.timer, speakerId: "other" } }, "host", true);
    expect(lastCue()).toBe("speech-next");
    expect(narrations()).toHaveLength(3);
  });

  it("announces a new captain in the same team phase", () => {
    controller.setPreferences({ music: false });
    controller.unlock();
    controller.update(state(), "host", true);
    controller.update({ ...state(), leaderId: "other" }, "host", true);
    expect(narrations()).toHaveLength(2);
    expect(narrations()[0].remove).toHaveBeenCalledOnce();
    expect(narrations()[0].paused).toBe(true);
    expect(lastCue()).toBe("team-select");
  });

  it("covers reveal, forced launch, rejection and speaker changes with distinct fixed clips", () => {
    controller.setPreferences({ music: false, effects: false });
    controller.unlock();
    controller.update(state("reveal"), "host", true);
    expect(lastCue()).toBe("game-reveal");
    controller.update({ ...state(), rejectCount: 4 }, "host", true);
    expect(lastCue()).toBe("team-select-forced");
    controller.update({ ...state("mission"), history: [{ type: "vote", quest: 1, team: ["host"], result: "success", forced: true }] }, "host", true);
    expect(lastCue()).toBe("mission-play-forced");
    controller.update(state("vote"), "host", true);
    controller.update(rejected(), "host", true);
    expect(lastCue()).toBe("proposal-rejected");
    controller.update(state(), "host", true);
    expect(lastCue()).toBe("team-select");
    expect(narrations().every(track => track.play.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    ["success", { success: 1, fail: 0 }, "mission-success"],
    ["fail", { success: 0, fail: 1 }, "mission-failure"],
    ["success", { success: 3, fail: 1 }, "mission-three-successes"],
    ["fail", { success: 1, fail: 3 }, "mission-three-failures"],
  ] as const)("selects the correct %s result, including terminal scores", (result, score, cue) => {
    controller.setPreferences({ music: false, effects: false });
    controller.unlock();
    controller.update(state("mission"), "host", true);
    expect(lastCue()).toBe("mission-play");
    controller.update(outcome(result, score), "host", true);
    expect(lastCue()).toBe(cue);
    controller.update(structuredClone(outcome(result, score)), "host", true);
    expect(narrations()).toHaveLength(2);
  });

  it("uses the two-minute assassination cue and distinct final victory clips", () => {
    controller.setPreferences({ music: false });
    controller.unlock();
    controller.update(state("assassin"), "host", true);
    expect(lastCue()).toBe("assassination");
    controller.update({ ...state("result"), winner: "good", winnerReason: "Private words must not be sent to TTS" }, "host", true);
    expect(lastCue()).toBe("victory-good");
    controller.update({ ...state("result"), winner: "evil" }, "host", true);
    expect(lastCue()).toBe("victory-evil");
    expect(tts.speak).not.toHaveBeenCalled();
  });

  it("never replays mission or rejection results on initial join, reconnect or enabling narration", () => {
    controller.setPreferences({ music: false });
    controller.unlock();
    controller.update(outcome("success"), "host", true);
    expect(narrations()).toHaveLength(0);
    controller.update(state("mission"), "host", false);
    controller.update(outcome("success"), "host", true);
    expect(narrations()).toHaveLength(0);
    controller.update(state("vote"), "host", false);
    controller.update(rejected(), "host", true);
    controller.setPreferences({ narration: false });
    controller.setPreferences({ narration: true });
    expect(narrations()).toHaveLength(0);
  });

  it("defaults narration to the host, permits opt-in and stops on disconnect or leave", () => {
    controller.setPreferences({ music: false });
    controller.unlock();
    controller.update(state(), "other", true);
    expect(narrations()).toHaveLength(0);
    controller.setPreferences({ narration: true });
    expect(narrations()).toHaveLength(1);
    const first = narrations()[0];
    controller.update(state(), "other", false);
    expect(first.paused).toBe(true);
    expect(first.remove).toHaveBeenCalledOnce();
    controller.update(state(), "other", true);
    expect(narrations()).toHaveLength(2);
    controller.update(null, null, true);
    expect(narrations()[1].paused).toBe(true);
    controller.unlock();
    expect(narrations()).toHaveLength(2);
  });

  it("updates narration volume without restarting and stores an explicit mute preference", () => {
    controller.setPreferences({ music: false });
    controller.unlock();
    controller.update(state(), "host", true);
    const track = narrations()[0];
    controller.setPreferences({ narrationVolume: .4 });
    expect(track.volume).toBe(.4);
    expect(track.play).toHaveBeenCalledOnce();
    controller.setPreferences({ narration: false });
    expect(track.paused).toBe(true);
    expect(JSON.parse(vi.mocked(localStorage.setItem).mock.calls.at(-1)![1]).narration).toBe(false);
    controller.update(state("vote"), "host", true);
    expect(narrations()).toHaveLength(1);
  });

  it("skips a late clip, allows a short AI turn, and cannot advance the server timer", () => {
    controller.setPreferences({ music: false });
    controller.unlock();
    const reveal = { ...state("reveal"), timer: { kind: "reveal" as const, label: "", deadline: Date.now() + 1000, durationMs: 10_000 } };
    controller.update(reveal, "host", true);
    expect(narrations()).toHaveLength(0);
    expect(reveal.timer.durationMs).toBe(10_000);
    const speech = { ...state("speech"), timer: { kind: "speech" as const, label: "", deadline: Date.now() + 3000, durationMs: 3000, speakerId: "host" } };
    controller.update(speech, "host", true);
    expect(lastCue()).toBe("speech-start");
    controller.update({ ...speech, timer: { ...speech.timer, speakerId: "other" } }, "host", true);
    expect(lastCue()).toBe("speech-next");
    const track = narrations().at(-1)!;
    vi.advanceTimersByTime(3000);
    expect(track.paused).toBe(true);
    expect(speech.timer.durationMs).toBe(3000);
  });

  it("stops a stalled clip with a bounded watchdog without replaying it on heartbeat", () => {
    controller.setPreferences({ music: false });
    controller.unlock();
    controller.update(state(), "host", true);
    vi.advanceTimersByTime(narrationAsset("team-select").durationMs + 3000);
    expect(narrations()[0].remove).toHaveBeenCalledOnce();
    controller.update(state(), "host", true);
    expect(narrations()).toHaveLength(1);
  });

  it("retries autoplay denial only after another gesture and never falls back to TTS", async () => {
    controller.setPreferences({ music: false });
    nextNarrationPlay = async () => { throw Object.assign(new Error("blocked"), { name: "NotAllowedError" }); };
    controller.update(state(), "host", true);
    controller.unlock();
    await vi.advanceTimersByTimeAsync(0);
    expect(narrations()).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    controller.unlock();
    expect(narrations()).toHaveLength(2);
    expect(lastCue()).toBe("team-select");
    expect(tts.speak).not.toHaveBeenCalled();
  });

  it("reports decode/network errors once, releases the track and never calls a TTS fallback", async () => {
    controller.setPreferences({ music: false });
    nextNarrationPlay = async () => { throw Object.assign(new Error("bad media"), { name: "NotSupportedError" }); };
    controller.unlock();
    controller.update(state(), "host", true);
    const track = narrations()[0];
    const lateError = track.onerror!;
    await vi.advanceTimersByTimeAsync(0);
    lateError();
    expect(track.paused).toBe(true);
    expect(onError).toHaveBeenCalledExactlyOnceWith("旁白音频加载失败。");
    expect(tts.speak).not.toHaveBeenCalled();
  });

  it("ignores stale media callbacks and late play completion after cancellation", async () => {
    controller.setPreferences({ music: false });
    let resolve!: () => void;
    nextNarrationPlay = () => new Promise<void>(done => { resolve = done; });
    controller.unlock();
    controller.update(state(), "host", true);
    const old = narrations()[0];
    const error = old.onerror!;
    const ended = old.onended!;
    controller.update(state("vote"), "host", true);
    old.paused = false;
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    ended(); error();
    expect(old.paused).toBe(true);
    expect(narrations()[1].paused).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("releases all audio on disposal and ignores late callbacks or later updates", () => {
    controller.unlock();
    controller.update(state(), "host", true);
    const track = narrations()[0];
    const playing = track.onplaying!;
    const ended = track.onended!;
    controller.dispose();
    playing(); ended();
    controller.unlock();
    controller.update(state("vote"), "host", true);
    expect(tracks.every(track => track.paused)).toBe(true);
    expect(narrations()).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("Music and independent result effects", () => {
  it("crossfades waiting/game music without restarting on sync", () => {
    controller.update(state("lobby"), "host", true);
    expect(tracks).toHaveLength(0);
    controller.unlock();
    vi.advanceTimersByTime(650);
    expect(music("waiting").initialSrc).toContain("medieval-fair");
    expect(music("waiting").volume).toBeCloseTo(.25);
    controller.update(state(), "host", true);
    vi.advanceTimersByTime(650);
    expect(music("waiting").paused).toBe(true);
    expect(music("game").volume).toBeCloseTo(.25);
    controller.update(state(), "host", true);
    expect(music("game").play).toHaveBeenCalledOnce();
    expect(narrations()).toHaveLength(1);
    expect(musicMode(state("result"))).toBe("waiting");
    expect(musicMode(null)).toBe("waiting");
  });

  it("ducks music while narration plays and ignores old completion callbacks", () => {
    controller.unlock();
    controller.update(state(), "host", true);
    const first = narrations()[0];
    const oldEnd = first.onended!;
    first.onplaying!();
    vi.advanceTimersByTime(650);
    expect(music("game").volume).toBeCloseTo(.05);
    controller.update(state("vote"), "host", true);
    const second = narrations()[1];
    second.onplaying!();
    oldEnd();
    vi.advanceTimersByTime(650);
    expect(music("game").volume).toBeCloseTo(.05);
    second.onended!();
    vi.advanceTimersByTime(650);
    expect(music("game").volume).toBeCloseTo(.25);
  });

  it("keeps music ducked for real-time voice independently of narration", () => {
    controller.unlock();
    controller.update(state(), "host", true);
    controller.setVoiceActive(true);
    narrations()[0].onplaying!();
    narrations()[0].onended!();
    vi.advanceTimersByTime(650);
    expect(music("game").volume).toBeCloseTo(.05);
    controller.setVoiceActive(false);
    vi.advanceTimersByTime(650);
    expect(music("game").volume).toBeCloseTo(.25);
  });

  it("plays rejection once but never on rejoin or reconnect", () => {
    controller.setPreferences({ music: false, narration: false });
    controller.unlock();
    controller.update(rejected(), "other", true);
    expect(tracks).toHaveLength(0);
    controller.update(state("vote"), "other", true);
    controller.update(rejected(), "other", true);
    controller.update(structuredClone(rejected()), "other", true);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].src).toBe("/assets/mission-fail.wav");
    expect(tracks[0].play).toHaveBeenCalledOnce();
    controller.update(rejected(), "other", false);
    controller.update(rejected(), "other", true);
    expect(tracks[0].play).toHaveBeenCalledOnce();
    expect(tracks[0].paused).toBe(true);
  });

  it("plays success and failure effects with music and narration off", () => {
    controller.setPreferences({ music: false, narration: false, effectsVolume: .35 });
    controller.unlock();
    controller.update(state("mission"), "other", true);
    controller.update(outcome("success"), "other", true);
    controller.update(structuredClone(outcome("success")), "other", true);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].src).toBe("/assets/mission-success.wav");
    expect(tracks[0].play).toHaveBeenCalledOnce();
    expect(tracks[0].volume).toBeCloseTo(.35);
    controller.update(state("mission"), "other", true);
    controller.update(outcome("fail"), "other", true);
    expect(tracks[1].src).toBe("/assets/mission-fail.wav");
    controller.setPreferences({ effects: false });
    expect(tracks.every(track => track.paused)).toBe(true);
  });

  it("does not replay effects after reconnect, stops on leave and can mute all channels", () => {
    controller.setPreferences({ music: false, narration: false });
    controller.unlock();
    controller.update(state("mission"), "other", false);
    controller.update(outcome("success"), "other", true);
    expect(tracks).toHaveLength(0);
    controller.update(state("mission"), "other", true);
    controller.update(outcome("success"), "other", true);
    controller.update(null, null, true);
    expect(tracks[0].paused).toBe(true);
    controller.setPreferences({ music: true, effects: false });
    controller.update(state(), "host", true);
    expect(tracks.some(track => track.dataset.musicMode === "game")).toBe(true);
    controller.setPreferences({ music: false, narration: false, effects: false });
    vi.advanceTimersByTime(650);
    expect(tracks.every(track => track.paused)).toBe(true);
  });
});
