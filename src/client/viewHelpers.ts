import type { PublicRoomState } from "../shared/game";
import { serverClock } from "./serverClock";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function getTargetPlayerCount(state: PublicRoomState): number {
  const count = Number(state.targetPlayerCount);
  if (Number.isInteger(count) && count >= 5 && count <= 10) return count;
  return Math.min(10, Math.max(5, state.players.length));
}

export function getCompletedQuestIndexes(state: PublicRoomState): Set<number> {
  return new Set(state.history.filter((entry) => entry.type === "mission").map((entry) => entry.quest - 1));
}

export function getTimerRemainingMs(deadline: number): number {
  return Math.max(0, deadline - serverClock.now());
}

export function extractKnownEvilNames(knowledge: string): string[] {
  if (!knowledge) return [];

  // Match pattern: "你认识的反方同伴：name1、name2、name3。" or "你看到的反方玩家：name1、name2。"
  const match = knowledge.match(/(?:你认识的反方同伴|你看到的反方玩家)：([^。]+)。/);
  if (!match) return [];

  const namesText = match[1];
  // Split by Chinese comma "、"
  const names = namesText.split("、").map(n => n.trim()).filter(Boolean);
  return names;
}
