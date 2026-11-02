import { getTeamSize, type QuestHistoryEntry } from "../../shared/game";

export interface ConnectedPlayer {
  id: string;
  connected: boolean;
}

export function findNextLeaderIndex(players: readonly ConnectedPlayer[], fromIndex: number): number {
  const hasConnectedPlayers = players.some(player => player.connected);
  for (let offset = 1; offset <= players.length; offset += 1) {
    const nextIndex = (fromIndex + offset) % players.length;
    if (!hasConnectedPlayers || players[nextIndex]?.connected) return nextIndex;
  }
  return fromIndex;
}

export function buildSpeechOrder(players: readonly ConnectedPlayer[], leaderIndex: number): string[] {
  const order: string[] = [];
  for (let offset = 1; offset <= players.length; offset += 1) {
    const player = players[(leaderIndex + offset) % players.length];
    if (player?.connected) order.push(player.id);
  }
  return order;
}

export function resolveQuestIndex(input: {
  requestedIndex?: number;
  currentIndex: number;
  playerCount: number;
  history: readonly QuestHistoryEntry[];
}): number {
  if (input.requestedIndex !== undefined && !Number.isInteger(input.requestedIndex)) throw new Error("任务序号无效。");
  const normalized = input.requestedIndex ?? input.currentIndex;
  if (normalized < 0 || normalized > 4) throw new Error("任务序号无效。");
  if (input.history.some(entry => entry.type === "mission" && entry.quest === normalized + 1)) {
    throw new Error("该任务已经完成。");
  }
  getTeamSize(input.playerCount, normalized);
  return normalized;
}

export function nextOpenQuestIndex(history: readonly QuestHistoryEntry[], fallback: number): number {
  const completed = new Set(history.filter(entry => entry.type === "mission").map(entry => entry.quest - 1));
  for (let index = 0; index < 5; index += 1) {
    if (!completed.has(index)) return index;
  }
  return Math.min(fallback, 4);
}
