import { ROLE_DEFS, getRequiredFails, getRoleKnowledge, getTeamSize, type PrivatePlayerState, type PublicRoomState, type RoleKey } from "../shared/game";
import type { PlayerInternal, RoomInternal } from "./roomTypes";

export function publicRoomState(room: RoomInternal): PublicRoomState {
    const recovery = room.recovery;
    const revealedRoles =
      room.phase === "result" || room.phase === "assassin"
        ? room.players
            .filter((player): player is PlayerInternal & { role: RoleKey } => Boolean(player.role))
            .filter(player => room.phase === "result" || ROLE_DEFS[player.role].side === "evil")
            .map((player) => ({
              playerId: player.id,
              role: player.role,
              roleName: ROLE_DEFS[player.role].name,
              side: ROLE_DEFS[player.role].side,
              servantVariant: player.servantVariant,
            }))
        : [];
    const playerCount = room.players.length;
    const hasGame = room.phase !== "lobby";

    return {
      phaseId: room.phaseId,
      ...(recovery ? { recovery: { deadline: recovery.deadline, connected: recovery.expectedPlayerIds.filter(id => room.players.some(player => player.id === id && player.connected)).length, expected: recovery.expectedPlayerIds.length } } : {}),
      roomCode: room.code,
      phase: room.phase,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        connected: player.connected,
        position: player.position,
        ready: player.ready,
      })),
      hostId: room.hostId,
      targetPlayerCount: room.targetPlayerCount,
      localUrls: room.localUrls.map((url) => `${url}?room=${room.code}`),
      leaderId: hasGame ? room.players[room.leaderIndex]?.id ?? null : null,
      questIndex: room.questIndex,
      teamSize: hasGame ? getTeamSize(playerCount, room.questIndex) : 0,
      requiredFails: hasGame ? getRequiredFails(playerCount, room.questIndex) : 0,
      rejectCount: room.rejectCount,
      score: { ...room.score },
      proposal: [...room.proposal],
      voteSubmitted: [...room.votes.keys()],
      missionSubmitted: [...room.missionVotes.keys()],
      history: [...room.history],
      winner: room.winner,
      winnerReason: room.winnerReason,
      revealedRoles,
      servantCounts: hasGame ? {
        male: room.players.filter(player => player.role === "servant" && player.servantVariant === "male").length,
        female: room.players.filter(player => player.role === "servant" && player.servantVariant === "female").length,
      } : null,
      speechOrder: [...room.speechOrder],
      timer: recovery ? { kind: "recovery", label: "等待玩家恢复连接", deadline: recovery.deadline, durationMs: 60000 } : room.timer
        ? {
            kind: room.timer.kind,
            label: room.timer.label,
            deadline: room.timer.deadline,
            durationMs: room.timer.durationMs,
            speakerId: room.timer.speakerId,
          }
        : null,
    };
  }

export function privatePlayerState(room: RoomInternal, player: PlayerInternal): PrivatePlayerState {
    const role = player.role;
    const roleDef = role ? ROLE_DEFS[role] : null;
    const gamePlayers = room.players.filter((candidate): candidate is PlayerInternal & { role: RoleKey } => Boolean(candidate.role));

    return {
      playerId: player.id,
      role,
      roleName: roleDef?.name ?? null,
      side: roleDef?.side ?? null,
      servantVariant: player.servantVariant,
      roleText: roleDef?.text ?? "",
      knowledge: role ? getRoleKnowledge({ id: player.id, name: player.name, role }, gamePlayers) : "",
      canPropose: !room.recovery && room.phase === "team" && room.players[room.leaderIndex]?.id === player.id,
      canVote: !room.recovery && room.phase === "vote" && room.players[room.leaderIndex]?.id !== player.id && !room.votes.has(player.id),
      canMission: !room.recovery && room.phase === "mission" && room.proposal.includes(player.id) && !room.missionVotes.has(player.id),
      canFailMission: !room.recovery && room.phase === "mission" && room.proposal.includes(player.id) && roleDef?.side === "evil",
      canAssassinate: !room.recovery && room.phase === "assassin" && role === "assassin",
    };
  }
