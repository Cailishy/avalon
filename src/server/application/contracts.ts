export interface CommandTransaction {
  markRoomChanged(roomCode: string): void;
  afterCommit(effect: () => void): void;
}
