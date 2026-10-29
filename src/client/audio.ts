import type { PublicRoomState } from "../shared/game";
import { narrationCue } from "../shared/narration";
import type { NarrationCueId } from "../shared/narration";
import { narrationAsset } from "./narrationAssets";
import { serverClock } from "./serverClock";

export type AudioPreferences = {
  music: boolean;
  musicVolume: number;
  narration: boolean | null;
  narrationVolume: number;
  effects: boolean;
  effectsVolume: number;
};

const STORAGE_KEY = "awalong-audio";
const defaults: AudioPreferences = { music: true, musicVolume: 0.25, narration: null, narrationVolume: 0.85, effects: true, effectsVolume: .5 };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function musicMode(state: PublicRoomState | null): "waiting" | "game" {
  return !state || state.phase === "lobby" || state.phase === "result" ? "waiting" : "game";
}

export function announcementKey(state: PublicRoomState): string {
  return JSON.stringify([state.roomCode, state.phase, state.leaderId, state.questIndex,
    state.rejectCount, state.history.length, state.proposal, state.timer?.speakerId,
    state.winner, state.recovery?.deadline ?? null]);
}

export class GameAudio {
  preferences: AudioPreferences;
  readonly narrationSupported = typeof Audio !== "undefined";
  private tracks: Partial<Record<"waiting" | "game", HTMLAudioElement>> = {};
  private effectsTracks: Partial<Record<"success" | "fail", HTMLAudioElement>> = {};
  private state: PublicRoomState | null = null;
  private myId: string | null = null;
  private connected = true;
  private unlocked = false;
  private key = "";
  private pendingCue: NarrationCueId | null = null;
  private narrationTrack: HTMLAudioElement | null = null;
  private narrationTimer: ReturnType<typeof setTimeout> | null = null;
  private narrationGeneration = 0;
  private disposed = false;
  private speaking = false;
  private voiceActive = false;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private musicGeneration = 0;

  constructor(private onError: (message: string) => void = () => {}) {
    let saved: Partial<AudioPreferences> = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"); } catch { /* Keep defaults if storage is unavailable. */ }
    this.preferences = {
      music: typeof saved?.music === "boolean" ? saved.music : defaults.music,
      musicVolume: typeof saved?.musicVolume === "number" && Number.isFinite(saved.musicVolume) ? clamp(saved.musicVolume) : defaults.musicVolume,
      narration: typeof saved?.narration === "boolean" ? saved.narration : null,
      narrationVolume: typeof saved?.narrationVolume === "number" && Number.isFinite(saved.narrationVolume) ? clamp(saved.narrationVolume) : defaults.narrationVolume,
      effects: typeof saved?.effects === "boolean" ? saved.effects : defaults.effects,
      effectsVolume: typeof saved?.effectsVolume === "number" && Number.isFinite(saved.effectsVolume) ? clamp(saved.effectsVolume) : defaults.effectsVolume,
    };
  }

  get narrationEnabled(): boolean {
    return this.preferences.narration ?? (!!this.myId && this.myId === this.state?.hostId);
  }

  setVoiceActive(active: boolean): void {
    if (this.disposed) return;
    if (this.voiceActive === active) return;
    this.voiceActive = active;
    this.updateMusic();
  }

  update(state: PublicRoomState | null, myId: string | null, connected: boolean): void {
    if (this.disposed) return;
    const previous = this.state;
    const wasEnabled = this.narrationEnabled;
    const wasConnected = this.connected;
    this.state = state;
    this.myId = myId;
    this.connected = connected;
    const showingOutcome = state?.phase === "missionResult" || state?.phase === "proposalResult";
    if (!connected || !showingOutcome) {
      for (const track of Object.values(this.effectsTracks)) track.pause();
    }
    this.updateMusic();
    if (connected && wasConnected && previous && state && previous.roomCode === state.roomCode && showingOutcome && previous.phase !== state.phase) {
      if (state.phase === "proposalResult") this.playResultEffect("fail");
      else {
        const latest = [...state.history].reverse().find(h => h.type === "mission");
        if (latest?.result) this.playResultEffect(latest.result);
      }
    }
    const key = state ? announcementKey(state) : "";
    if (key !== this.key || wasEnabled !== this.narrationEnabled || wasConnected !== connected) {
      this.key = key;
      this.cancelNarration();
      this.pendingCue = state && connected && this.narrationEnabled
        ? narrationCue(state, wasConnected && previous?.roomCode === state.roomCode ? previous : null) : null;
      this.playPendingNarration();
    }
  }

  unlock(): void {
    if (this.disposed || this.unlocked) return;
    this.unlocked = true;
    this.updateMusic();
    this.playPendingNarration();
  }

  setPreferences(patch: Partial<AudioPreferences>): void {
    if (this.disposed) return;
    const wasEnabled = this.narrationEnabled;
    this.preferences = { ...this.preferences, ...patch };
    this.preferences.musicVolume = clamp(this.preferences.musicVolume);
    this.preferences.narrationVolume = clamp(this.preferences.narrationVolume);
    this.preferences.effectsVolume = clamp(this.preferences.effectsVolume);
    if (this.narrationTrack) this.narrationTrack.volume = this.preferences.narrationVolume;
    for (const track of Object.values(this.effectsTracks)) {
      track.volume = this.preferences.effectsVolume;
      if (!this.preferences.effects) track.pause();
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.preferences)); } catch { /* Audio remains usable without storage. */ }
    if (wasEnabled !== this.narrationEnabled) {
      this.cancelNarration();
      this.pendingCue = this.narrationEnabled && this.state && this.connected ? narrationCue(this.state, null) : null;
      this.playPendingNarration();
    }
    this.updateMusic();
  }

  dispose(): void {
    this.disposed = true;
    this.musicGeneration++;
    this.cancelNarration();
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    this.unlocked = false;
    for (const track of Object.values(this.tracks)) { track.pause(); track.remove(); }
    this.tracks = {};
    for (const track of Object.values(this.effectsTracks)) { track.pause(); track.remove(); }
    this.effectsTracks = {};
  }

  private playResultEffect(result: "success" | "fail"): void {
    if (!this.unlocked || !this.preferences.effects) return;
    let track = this.effectsTracks[result];
    if (!track) {
      track = new Audio(`/assets/mission-${result}.wav`);
      track.hidden = true;
      track.preload = "auto";
      track.dataset.soundEffect = result;
      document.body.appendChild(track);
      this.effectsTracks[result] = track;
    }
    track.currentTime = 0;
    track.volume = this.preferences.effectsVolume;
    void track.play().catch(error => {
      if (!["NotAllowedError", "AbortError"].includes(error.name)) this.onError("任务音效加载失败。");
    });
  }

  private cancelNarration(): void {
    this.narrationGeneration++;
    if (this.narrationTimer) clearTimeout(this.narrationTimer);
    this.narrationTimer = null;
    const track = this.narrationTrack;
    this.narrationTrack = null;
    if (track) {
      track.onplaying = null;
      track.onended = null;
      track.onerror = null;
      track.pause();
      track.removeAttribute("src");
      track.load();
      track.remove();
    }
    this.speaking = false;
    this.pendingCue = null;
    this.updateMusic();
  }

  private playPendingNarration(): void {
    if (this.disposed || !this.unlocked || !this.narrationSupported || !this.pendingCue || !this.state || !this.narrationEnabled || !this.connected) return;
    const cue = this.pendingCue;
    this.pendingCue = null;
    const asset = narrationAsset(cue);
    const remaining = this.state.timer ? this.state.timer.deadline - serverClock.now() : Infinity;
    // A late gesture must not start a clip that cannot fit before the server-owned deadline.
    if (remaining < asset.durationMs + 100) return;
    const track = new Audio(asset.src);
    track.hidden = true;
    track.preload = "auto";
    track.volume = this.preferences.narrationVolume;
    track.dataset.narrationCue = cue;
    document.body.appendChild(track);
    this.narrationTrack = track;
    const generation = ++this.narrationGeneration;
    const current = () => generation === this.narrationGeneration && this.narrationTrack === track;
    track.onplaying = () => {
      if (!current()) return;
      this.speaking = true;
      this.updateMusic();
    };
    const finish = () => {
      if (current()) this.cancelNarration();
    };
    track.onended = finish;
    track.onerror = () => {
      if (!current()) return;
      const aborted = track.error?.code === 1;
      this.cancelNarration();
      if (!aborted) this.onError("旁白音频加载失败。");
    };
    this.narrationTimer = setTimeout(finish, Math.min(asset.durationMs + 3_000, remaining));
    void track.play().then(() => {
      if (!current()) track.pause();
    }).catch((error: DOMException) => {
      if (!current()) return;
      if (error.name === "NotAllowedError") {
        this.unlocked = false;
        this.cancelNarration();
        this.pendingCue = cue;
      } else {
        this.cancelNarration();
        if (error.name !== "AbortError") this.onError("旁白音频加载失败。");
      }
    });
  }

  private updateMusic(): void {
    if (this.disposed || !this.unlocked) return;
    const mode = musicMode(this.state);
    if (this.preferences.music && !this.tracks[mode]) {
      const track = new Audio(mode === "waiting" ? "/assets/medieval-fair-loop.ogg" : "/assets/game-investigation-loop.ogg");
      track.loop = true;
      track.preload = "auto";
      track.volume = 0;
      track.hidden = true;
      track.dataset.musicMode = mode;
      document.body.appendChild(track);
      this.tracks[mode] = track;
    }
    const generation = ++this.musicGeneration;
    const active = this.tracks[mode];
    if (this.preferences.music && active?.paused) {
      void active.play().catch((error: DOMException) => {
        if (generation !== this.musicGeneration || error.name === "AbortError") return;
        if (error.name === "NotAllowedError") { this.unlocked = false; return; }
        this.onError("背景音乐加载失败，请检查音乐素材是否完整。");
      });
    }
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    const starts = Object.fromEntries(Object.entries(this.tracks).map(([key, track]) => [key, track.volume]));
    const start = Date.now();
    this.fadeTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / 600);
      for (const [key, track] of Object.entries(this.tracks)) {
        const target = this.preferences.music && key === mode ? this.preferences.musicVolume * (this.speaking || this.voiceActive ? 0.2 : 1) : 0;
        track.volume = clamp(starts[key] + (target - starts[key]) * progress);
        if (progress === 1 && target === 0) track.pause();
      }
      if (progress === 1 && this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; }
    }, 50);
  }
}
