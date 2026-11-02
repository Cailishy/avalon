import type { JoinResult, RemovedPlayer, SessionSyncResult } from "../domain/roomContracts";

/**
 * The application layer depends on the room use-cases, not on the concrete
 * in-memory state holder. The composition root supplies the implementation.
 */
export interface RoomCommandPort {
  createRoom(name: string, targetPlayerCount?: number): JoinResult;
  joinRoom(code: string, name: string): JoinResult;
  addAIPlayers(code: string, hostId: string, token: string, count: number): void;
  setTargetPlayerCount(code: string, hostId: string, token: string, targetPlayerCount: number): void;
  setPlayerReady(code: string, playerId: string, token: string, ready: boolean): void;
  syncPlayerSession(code: string, playerId: string, sessionToken: string): SessionSyncResult;
  validatePlayerSession(code: string, playerId: string, sessionToken: string): void;
  startRoom(code: string, playerId: string, token: string): void;
  kickPlayer(code: string, hostId: string, token: string, targetId: string): RemovedPlayer;
  dissolveRoom(code: string, hostId: string, token: string): RemovedPlayer[];
  restartRoom(code: string, playerId: string, token: string): void;
  leaveRoom(code: string, playerId: string, token: string): string | null;
  proposeTeam(code: string, playerId: string, token: string, team: string[], questIndex?: number): void;
  submitVote(code: string, playerId: string, token: string, approved: boolean): void;
  submitMission(code: string, playerId: string, token: string, failed: boolean): void;
  chooseAssassinTarget(code: string, playerId: string, token: string, targetId: string): void;
  endSpeech(code: string, playerId: string, token: string): void;
  disconnectPlayer(playerId: string): string | null;
  removeDisconnectedLobbyPlayer(playerId: string): string | null;
  markChanged(code: string): void;
  simulateAI(code: string): void;
}
