export interface JoinResult {
  roomCode: string;
  playerId: string;
  sessionToken: string;
}

export interface RemovedPlayer {
  id: string;
  name: string;
}

export interface SessionSyncResult {
  result: JoinResult;
  connectedChanged: boolean;
}
