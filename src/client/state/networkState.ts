/** Connection, synchronization, and command delivery state. */
export class NetworkStateStore {
  serverConnected: boolean;
  sessionReady: boolean;
  syncInFlight = false;
  stateSyncGeneration = 0;
  pendingActions = new Set<string>();
  reconnectAttempts = 0;
  showReconnectingIndicator = false;
  clockGeneration = 0;
  clockInFlight = false;
  uncertainNotice = false;

  constructor(connected: boolean) {
    this.serverConnected = connected;
    this.sessionReady = connected;
  }

  resetSync(): void {
    this.syncInFlight = false;
    this.stateSyncGeneration += 1;
  }

  markDisconnected(): void {
    this.serverConnected = false;
    this.sessionReady = false;
    this.resetSync();
  }

  markConnected(): void {
    this.serverConnected = true;
    this.reconnectAttempts = 0;
    this.showReconnectingIndicator = false;
  }
}
