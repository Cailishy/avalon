export type RoleKey = "merlin" | "percival" | "servant" | "assassin" | "morgana" | "mordred" | "oberon" | "minion";
export type Side = "good" | "evil";
export type ServantVariant = "male" | "female";
export const FACTION_NAMES: Record<Side, string> = { good: "守誓者", evil: "藏锋者" };
export type RoomPhase = "lobby" | "reveal" | "team" | "vote" | "proposalResult" | "mission" | "missionResult" | "speech" | "assassin" | "result";
export type Winner = "good" | "evil";
export type TimerKind = "reveal" | "team" | "vote" | "proposalResult" | "mission" | "missionResult" | "speech" | "assassin" | "recovery";

export interface RoleDef {
  name: string;
  side: Side;
  symbol: string;
  text: string;
}

export interface PlayerPublic {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  position: number;
  ready: boolean;
}

export interface RevealedRole {
  playerId: string;
  role: RoleKey;
  roleName: string;
  side: Side;
  servantVariant: ServantVariant | null;
}

export interface QuestHistoryEntry {
  type: "vote" | "mission";
  quest: number;
  leader?: string;
  team: string[];
  approvals?: number;
  rejections?: number;
  voteDetails?: { playerId: string; approved: boolean }[];
  forced?: boolean;
  fails?: number;
  result?: "success" | "fail";
}

export interface PublicRoomState {
  phaseId: string;
  recovery?: { deadline: number; connected: number; expected: number };
  roomCode: string;
  phase: RoomPhase;
  players: PlayerPublic[];
  hostId: string;
  targetPlayerCount: number;
  localUrls: string[];
  leaderId: string | null;
  questIndex: number;
  teamSize: number;
  requiredFails: number;
  rejectCount: number;
  score: { success: number; fail: number };
  proposal: string[];
  voteSubmitted: string[];
  missionSubmitted: string[];
  history: QuestHistoryEntry[];
  winner: Winner | null;
  winnerReason: string;
  revealedRoles: RevealedRole[];
  servantCounts: Record<ServantVariant, number> | null;
  speechOrder: string[];
  timer: {
    kind: TimerKind;
    label: string;
    deadline: number;
    durationMs: number;
    speakerId?: string;
  } | null;
}

export interface PrivatePlayerState {
  playerId: string;
  role: RoleKey | null;
  roleName: string | null;
  side: Side | null;
  servantVariant: ServantVariant | null;
  roleText: string;
  knowledge: string;
  canPropose: boolean;
  canVote: boolean;
  canMission: boolean;
  canFailMission: boolean;
  canAssassinate: boolean;
}

export const ROLE_REVEAL_DURATION_MS = 10_000;
export const MISSION_RESULT_DURATION_MS = 8_000;
export const PROPOSAL_REJECTION_DURATION_MS = 5_000;
export const TEAM_SELECTION_DURATION_MS = 30_000;
export const ASSASSINATION_DURATION_MS = 120_000;

export function getProposalRejectionThreshold(playerCount: number): number {
  return Math.floor(playerCount / 2) + 1;
}

export function isForcedLaunch(rejectCount: number, playerCount: number): boolean {
  return rejectCount >= playerCount - 1;
}

export const TEAM_SIZES: Record<number, number[]> = {
  5: [2, 2, 3, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

export const ALIGNMENT_COUNTS: Record<number, { good: number; evil: number }> = {
  5: { good: 3, evil: 2 },
  6: { good: 4, evil: 2 },
  7: { good: 4, evil: 3 },
  8: { good: 5, evil: 3 },
  9: { good: 5, evil: 4 },
  10: { good: 6, evil: 4 },
};

export const ROLE_DEFS: Record<RoleKey, RoleDef> = {
  merlin: {
    name: "梅林",
    side: "good",
    symbol: "M",
    text: "知道除莫德雷德外的反方玩家。正方三任务成功后若被刺客命中，反方翻盘。",
  },
  percival: {
    name: "派西维尔",
    side: "good",
    symbol: "P",
    text: "知道谁可能是梅林，但莫甘娜会伪装成梅林。",
  },
  servant: {
    name: "亚瑟忠臣",
    side: "good",
    symbol: "A",
    text: "没有额外初始信息，依靠发言、投票和任务结果推理。",
  },
  assassin: {
    name: "刺客",
    side: "evil",
    symbol: "X",
    text: "反方。若正方完成三个任务，你负责刺杀梅林。",
  },
  morgana: {
    name: "莫甘娜",
    side: "evil",
    symbol: "G",
    text: "反方。在派西维尔眼中会显示为梅林候选。",
  },
  mordred: {
    name: "莫德雷德",
    side: "evil",
    symbol: "D",
    text: "反方，并且不会被梅林识别。",
  },
  oberon: {
    name: "奥伯伦",
    side: "evil",
    symbol: "O",
    text: "反方，但不认识其他反方玩家，他们也不知道你。",
  },
  minion: {
    name: "莫德雷德的爪牙",
    side: "evil",
    symbol: "N",
    text: "反方。你知道除奥伯伦外的其他反方同伴。",
  },
};

export function assertPlayerCount(count: number): void {
  if (!TEAM_SIZES[count]) {
    throw new Error("阿瓦隆需要 5 到 10 名玩家。");
  }
}

export function buildRoles(count: number, random = Math.random): RoleKey[] {
  return shuffle(getRoleDeck(count), random);
}

export function getRoleCounts(count: number): Array<{ role: RoleKey; count: number }> {
  const counts = new Map<RoleKey, number>();
  for (const role of getRoleDeck(count)) counts.set(role, (counts.get(role) ?? 0) + 1);
  return [...counts].map(([role, count]) => ({ role, count }));
}

function getRoleDeck(count: number): RoleKey[] {
  assertPlayerCount(count);
  const { good } = ALIGNMENT_COUNTS[count];

  // 基础角色：梅林、派西维尔、刺客、莫甘娜（2正2反）
  const roles: RoleKey[] = ["merlin", "percival", "assassin", "morgana"];

  if (count >= 7) roles.push("mordred");
  if (count >= 9) roles.push("oberon");

  // 填充正方忠臣至所需数量
  while (roles.filter((role) => ROLE_DEFS[role].side === "good").length < good) {
    roles.push("servant");
  }

  return roles;
}

export function getTeamSize(playerCount: number, questIndex: number): number {
  assertPlayerCount(playerCount);
  const size = TEAM_SIZES[playerCount][questIndex];
  if (!size) throw new Error("任务序号无效。");
  return size;
}

export function getRequiredFails(playerCount: number, questIndex: number): number {
  assertPlayerCount(playerCount);
  return playerCount >= 7 && questIndex === 3 ? 2 : 1;
}

export function getRequiredSuccesses(playerCount: number, questIndex: number): number {
  return getTeamSize(playerCount, questIndex) - getRequiredFails(playerCount, questIndex) + 1;
}

export function getRoleKnowledge(
  current: { id: string; name: string; role: RoleKey },
  players: Array<{ id: string; name: string; role: RoleKey }>,
): string {
  const evilPlayers = players.filter((player) => ROLE_DEFS[player.role].side === "evil");

  if (current.role === "merlin") {
    const visible = evilPlayers.filter((player) => player.role !== "mordred").map((player) => player.name);
    return visible.length ? `你看到的反方玩家：${visible.join("、")}。` : "你没有看到反方玩家。";
  }

  if (current.role === "percival") {
    const visible = players.filter((player) => player.role === "merlin" || player.role === "morgana").map((player) => player.name);
    return `你看到的梅林候选：${visible.join("、")}。`;
  }

  if (ROLE_DEFS[current.role].side === "evil" && current.role !== "oberon") {
    const visible = evilPlayers
      .filter((player) => player.id !== current.id && player.role !== "oberon")
      .map((player) => player.name);
    return visible.length ? `你认识的反方同伴：${visible.join("、")}。奥伯伦若在场不会显示。` : "你没有看到其他反方同伴。";
  }

  if (current.role === "oberon") {
    return "你不认识其他反方玩家，他们也不知道你。";
  }

  return "你没有额外初始信息。";
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
