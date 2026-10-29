import type { PublicRoomState, QuestHistoryEntry } from "../shared/game";

export interface CompletedQuestDetails {
  mission: QuestHistoryEntry;
  proposal: QuestHistoryEntry | null;
}

export function getCompletedQuestDetails(state: Pick<PublicRoomState, "history">, questIndex: number): CompletedQuestDetails | null {
  if (!Number.isInteger(questIndex) || questIndex < 0 || questIndex > 4) return null;
  const missionIndex = state.history.findIndex(entry => entry.type === "mission" && entry.quest === questIndex + 1);
  if (missionIndex < 0) return null;
  const mission = state.history[missionIndex];
  // A quest may have several rejected proposals before its actual launch.
  for (let index = missionIndex - 1; index >= 0; index--) {
    const entry = state.history[index];
    if (entry.type === "vote" && entry.quest === mission.quest && entry.result === "success"
      && entry.leader === mission.leader && entry.team.length === mission.team.length
      && entry.team.every(id => mission.team.includes(id))) return { mission, proposal: entry };
  }
  return { mission, proposal: null };
}
