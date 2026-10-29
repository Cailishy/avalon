import type { QuestHistoryEntry, RoleKey, RoomPhase, ServantVariant, TimerKind, Winner } from "../shared/game";
import type { RoomRecoveryState } from "./roomRecovery";

export interface PlayerInternal {
  id: string;
  sessionToken: string;
  name: string;
  isHost: boolean;
  isAI: boolean;
  connected: boolean;
  position: number;
  ready: boolean;
  role: RoleKey | null;
  servantVariant: ServantVariant | null;
}

export interface RoomInternal {
  phaseId: string;
  recovery?: RoomRecoveryState;
  code: string;
  hostId: string;
  targetPlayerCount: number;
  phase: RoomPhase;
  players: PlayerInternal[];
  leaderIndex: number;
  questIndex: number;
  rejectCount: number;
  score: { success: number; fail: number };
  proposal: string[];
  votes: Map<string, boolean>;
  missionVotes: Map<string, boolean>;
  history: QuestHistoryEntry[];
  winner: Winner | null;
  winnerReason: string;
  localUrls: string[];
  aiSimulating?: boolean;
  aiTimeout?: NodeJS.Timeout;
  timer?: RoomTimerInternal | null;
  speechOrder: string[];
  speechIndex: number;
  speechNextLeaderIndex: number | null;
  idleSince: number | null;
  completedAt: number | null;
}

export interface RoomTimerInternal {
  kind: Exclude<TimerKind, "recovery">;
  label: string;
  deadline: number;
  durationMs: number;
  timeout: NodeJS.Timeout;
  speakerId?: string;
}
