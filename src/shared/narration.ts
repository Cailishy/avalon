import type { PublicRoomState } from "./game";
import { isForcedLaunch } from "./game";

export const NARRATION_VOICE = {
  name: "Serene Narrator - Deep,Resonant,Measured",
  language: "Chinese (Mandarin)",
  speed: 0.9,
  pitch: 0,
  direction: "沉稳、清晰、克制的旁白。自然音高，停顿清楚，不使用活泼、夸张或角色表演式语气。",
} as const;

// The public catalog selects prerecorded clips, never player-specific generated speech.
export const NARRATION_CUES = {
  "game-reveal": { text: "游戏开始。请查看自己的身份，十秒后进入组队阶段。", maxDurationMs: 9_500 },
  "team-select": { text: "请当前队长在三十秒内，选择任务和队员。", maxDurationMs: 28_000 },
  "team-select-forced": { text: "本次提案将强制发车。请队长在三十秒内选择任务和队员。", maxDurationMs: 28_000 },
  "team-vote": { text: "队伍已提交，队长默认赞成。请其他玩家在三十秒内投票。", maxDurationMs: 28_000 },
  "proposal-rejected": { text: "队伍未通过，下一位队长组队。", maxDurationMs: 4_500 },
  "mission-play": { text: "队伍通过。请任务队员在三十秒内提交任务牌。守誓者只能提交成功牌。", maxDurationMs: 28_000 },
  "mission-play-forced": { text: "本次队伍强制发车。请队员在三十秒内提交任务牌。守誓者只能提交成功牌。", maxDurationMs: 28_000 },
  "mission-success": { text: "任务成功，结果展示后进入发言阶段。", maxDurationMs: 7_500 },
  "mission-failure": { text: "任务失败，结果展示后进入发言阶段。", maxDurationMs: 7_500 },
  "mission-three-successes": { text: "三个任务成功，随后进入藏锋者讨论与刺杀。", maxDurationMs: 7_500 },
  "mission-three-failures": { text: "三个任务失败，结果展示后藏锋者获胜。", maxDurationMs: 7_500 },
  "speech-start": { text: "进入发言阶段。", maxDurationMs: 2_500 },
  "speech-next": { text: "请下一位玩家发言。", maxDurationMs: 2_500 },
  "assassination": { text: "藏锋者身份已公开，进入两分钟讨论与刺杀阶段。讨论全房间可听，由刺客选择目标并提交。", maxDurationMs: 25_000 },
  "victory-good": { text: "对局结束，守誓者获胜。", maxDurationMs: 10_000 },
  "victory-evil": { text: "对局结束，藏锋者获胜。", maxDurationMs: 10_000 },
} as const;

export type NarrationCueId = keyof typeof NARRATION_CUES;

export type NarrationAssetManifest = {
  schemaVersion: 1;
  version: string;
  voice: typeof NARRATION_VOICE;
  clips: {
    id: NarrationCueId;
    file: string;
    bytes: number;
    durationMs: number;
    sha256: string;
  }[];
};

// Only public phase information selects a fixed clip. Names and winnerReason are never TTS input.
export function narrationCue(state: PublicRoomState, previous: PublicRoomState | null): NarrationCueId | null {
  if (state.recovery) return null;
  if (previous?.recovery && ["missionResult", "proposalResult"].includes(state.phase)) return null;
  const continuing = previous?.roomCode === state.roomCode && previous.phase !== "lobby";
  const newHistory = continuing ? state.history.slice(previous.history.length) : [];
  switch (state.phase) {
    case "lobby": return null;
    case "reveal": return "game-reveal";
    case "team": return isForcedLaunch(state.rejectCount, state.players.length) ? "team-select-forced" : "team-select";
    case "vote": return "team-vote";
    case "proposalResult":
      return newHistory.some(entry => entry.type === "vote" && entry.result !== "success" && (entry.rejections ?? 0) > 0)
        ? "proposal-rejected" : null;
    case "mission": return state.history.at(-1)?.forced ? "mission-play-forced" : "mission-play";
    case "missionResult": {
      const result = [...newHistory].reverse().find(entry => entry.type === "mission")?.result;
      if (!result) return null;
      if (state.score.fail >= 3) return "mission-three-failures";
      if (state.score.success >= 3) return "mission-three-successes";
      return result === "success" ? "mission-success" : "mission-failure";
    }
    case "speech":
      if (!state.timer?.speakerId) return null;
      if (previous?.phase !== "speech" || previous.roomCode !== state.roomCode) return "speech-start";
      return previous.timer?.speakerId === state.timer.speakerId ? null : "speech-next";
    case "assassin": return "assassination";
    case "result": return state.winner === "good" ? "victory-good" : state.winner === "evil" ? "victory-evil" : null;
  }
}
