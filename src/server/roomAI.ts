import { ROLE_DEFS, getTeamSize } from "../shared/game";
import type { RoomManager } from "./roomManager";
import type { RoomInternal } from "./roomTypes";

type RoomAIActions = Pick<RoomManager, "getRoom" | "proposeTeam" | "submitVote" | "submitMission" | "endSpeech"> & { notifyRoomChanged: (code: string) => void };
const AI_SPEECH_MS = 3000;

export function clearRoomAI(room: RoomInternal): void {
    if (room.aiTimeout) clearTimeout(room.aiTimeout);
    room.aiTimeout = undefined;
    room.aiSimulating = false;
  }

export function scheduleRoomAI(code: string, actions: RoomAIActions): void {
    const room = actions.getRoom(code);
    if (!room || !["team", "vote", "mission", "speech"].includes(room.phase)) return;
    if (room.aiSimulating) return;

    const aiPlayers = room.players.filter(player => player.isAI && player.connected);
    if (aiPlayers.length === 0) return;
    const speakerId = room.timer?.speakerId;
    const canAct = room.phase === "team"
      ? room.players[room.leaderIndex]?.isAI && room.players[room.leaderIndex]?.connected && room.players.filter(p => p.connected).length >= getTeamSize(room.players.length, room.questIndex)
      : room.phase === "vote"
        ? aiPlayers.some(p => p.id !== room.players[room.leaderIndex]?.id && !room.votes.has(p.id))
        : room.phase === "mission"
          ? aiPlayers.some(p => room.proposal.includes(p.id) && !room.missionVotes.has(p.id))
          : aiPlayers.some(p => p.id === speakerId);
    if (!canAct) return;

    room.aiSimulating = true;

    const timeout = setTimeout(() => {
      const currentRoom = actions.getRoom(code);
      // Cancelled turns must not act on a restarted room or a different speaker.
      if (currentRoom !== room || currentRoom.aiTimeout !== timeout) return;
      currentRoom.aiTimeout = undefined;
      let changed = false;
      try {
        if (currentRoom.phase === "team") {
          const leader = currentRoom.players[currentRoom.leaderIndex];
          if (leader?.isAI && leader.connected) {
            const teamSize = getTeamSize(currentRoom.players.length, currentRoom.questIndex);
            const team = [...currentRoom.players]
              .filter(p => p.connected)
              .sort(() => Math.random() - 0.5)
              .slice(0, teamSize)
              .map(p => p.id);
            if (team.length === teamSize) {
              actions.proposeTeam(code, leader.id, leader.sessionToken, team);
              changed = true;
            }
          }
        } else if (currentRoom.phase === "vote") {
          for (const ai of aiPlayers) {
            if (currentRoom.phase !== "vote") break;
            if (ai.connected && currentRoom.players[currentRoom.leaderIndex]?.id !== ai.id && !currentRoom.votes.has(ai.id)) {
              const vote = Math.random() > 0.3;
              actions.submitVote(code, ai.id, ai.sessionToken, vote);
              changed = true;
            }
          }
        } else if (currentRoom.phase === "mission") {
          for (const ai of aiPlayers) {
            if (currentRoom.phase !== "mission") break;
            if (ai.connected && currentRoom.proposal.includes(ai.id) && !currentRoom.missionVotes.has(ai.id)) {
              const isEvil = Boolean(ai.role && ROLE_DEFS[ai.role].side === "evil");
              const fail = isEvil && Math.random() > 0.5;
              actions.submitMission(code, ai.id, ai.sessionToken, fail);
              changed = true;
            }
          }
        } else if (currentRoom.phase === "speech") {
          const speaker = aiPlayers.find(ai => ai.id === currentRoom.timer?.speakerId && ai.connected);
          if (speaker) {
            actions.endSpeech(code, speaker.id, speaker.sessionToken);
            changed = true;
          }
        }
      } catch (err) {
        console.error("AI simulation error:", err);
      } finally {
        currentRoom.aiSimulating = false;
        if (changed) actions.notifyRoomChanged(code);
      }
    }, room.phase === "speech" ? AI_SPEECH_MS : 1500);
    room.aiTimeout = timeout;
    timeout.unref?.();
  }
