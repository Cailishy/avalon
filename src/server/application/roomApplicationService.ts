import type { CommandTransaction } from "./contracts";
import type { RoomCommandPort } from "./roomPorts";
import type { JoinResult, RemovedPlayer, SessionSyncResult } from "../domain/roomContracts";

export interface RoomChangePublisher {
  publish(roomCode: string): void;
}

/**
 * Application orchestration for room commands.
 *
 * Socket handlers should translate transport payloads and deal with socket
 * bindings only. This service owns the common command choreography: invoke
 * the room use-case, mark the affected room for persistence, and schedule
 * post-commit AI work where the command can advance the game.
 */
export class RoomApplicationService {
  constructor(private readonly rooms: RoomCommandPort, private readonly changePublisher?: RoomChangePublisher) {}

  createRoom(name: string, targetPlayerCount: number | undefined, transaction: CommandTransaction): JoinResult {
    const result = this.rooms.createRoom(name, targetPlayerCount);
    transaction.markRoomChanged(result.roomCode);
    return result;
  }

  joinRoom(code: string, name: string, transaction: CommandTransaction): JoinResult {
    const result = this.rooms.joinRoom(code, name);
    transaction.markRoomChanged(result.roomCode);
    return result;
  }

  addAIPlayers(code: string, playerId: string, token: string, count: number, transaction: CommandTransaction): void {
    this.rooms.addAIPlayers(code, playerId, token, count);
    transaction.markRoomChanged(code);
  }

  setTargetPlayerCount(code: string, playerId: string, token: string, targetPlayerCount: number, transaction: CommandTransaction): void {
    this.rooms.setTargetPlayerCount(code, playerId, token, targetPlayerCount);
    transaction.markRoomChanged(code);
  }

  setPlayerReady(code: string, playerId: string, token: string, ready: boolean, transaction: CommandTransaction): void {
    this.rooms.setPlayerReady(code, playerId, token, ready);
    transaction.markRoomChanged(code);
  }

  startRoom(code: string, playerId: string, token: string, transaction: CommandTransaction): void {
    this.rooms.startRoom(code, playerId, token);
    this.markAndSimulate(code, transaction);
  }

  kickPlayer(code: string, playerId: string, token: string, targetId: string, transaction: CommandTransaction): RemovedPlayer {
    const removed = this.rooms.kickPlayer(code, playerId, token, targetId);
    transaction.markRoomChanged(code);
    return removed;
  }

  dissolveRoom(code: string, playerId: string, token: string, transaction: CommandTransaction): RemovedPlayer[] {
    const removed = this.rooms.dissolveRoom(code, playerId, token);
    transaction.markRoomChanged(code);
    return removed;
  }

  restartRoom(code: string, playerId: string, token: string, transaction: CommandTransaction): void {
    this.rooms.restartRoom(code, playerId, token);
    transaction.markRoomChanged(code);
  }

  leaveRoom(code: string, playerId: string, token: string, transaction: CommandTransaction): string | null {
    const changedRoomCode = this.rooms.leaveRoom(code, playerId, token);
    transaction.markRoomChanged(code);
    if (changedRoomCode) this.markAndSimulate(changedRoomCode, transaction);
    return changedRoomCode;
  }

  proposeTeam(code: string, playerId: string, token: string, team: string[], questIndex: number | undefined, transaction: CommandTransaction): void {
    this.rooms.proposeTeam(code, playerId, token, team, questIndex);
    this.markAndSimulate(code, transaction);
  }

  submitVote(code: string, playerId: string, token: string, approved: boolean, transaction: CommandTransaction): void {
    this.rooms.submitVote(code, playerId, token, approved);
    this.markAndSimulate(code, transaction);
  }

  submitMission(code: string, playerId: string, token: string, failed: boolean, transaction: CommandTransaction): void {
    this.rooms.submitMission(code, playerId, token, failed);
    this.markAndSimulate(code, transaction);
  }

  chooseAssassinTarget(code: string, playerId: string, token: string, targetId: string, transaction: CommandTransaction): void {
    this.rooms.chooseAssassinTarget(code, playerId, token, targetId);
    transaction.markRoomChanged(code);
  }

  endSpeech(code: string, playerId: string, token: string, transaction: CommandTransaction): void {
    this.rooms.endSpeech(code, playerId, token);
    this.markAndSimulate(code, transaction);
  }

  syncPlayerSession(code: string, playerId: string, token: string): SessionSyncResult {
    return this.rooms.syncPlayerSession(code, playerId, token);
  }

  validatePlayerSession(code: string, playerId: string, token: string): void {
    this.rooms.validatePlayerSession(code, playerId, token);
  }

  disconnectPlayer(playerId: string): string | null {
    return this.rooms.disconnectPlayer(playerId);
  }

  removeDisconnectedLobbyPlayer(playerId: string): string | null {
    return this.rooms.removeDisconnectedLobbyPlayer(playerId);
  }

  markChanged(code: string): void {
    this.rooms.markChanged(code);
  }

  simulateAI(code: string): void {
    this.rooms.simulateAI(code);
  }

  publishRoomState(code: string): void {
    this.changePublisher?.publish(code);
  }

  private markAndSimulate(code: string, transaction: CommandTransaction): void {
    transaction.markRoomChanged(code);
    transaction.afterCommit(() => this.rooms.simulateAI(code));
  }
}
