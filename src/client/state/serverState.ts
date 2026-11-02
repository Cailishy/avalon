import type { PrivatePlayerState, PublicRoomState } from "../../shared/game";

export interface ClientIdentity {
  roomCode: string;
  playerId: string;
  sessionToken: string;
  name: string;
}

export interface PublicStateApplyResult {
  accepted: boolean;
  changed: boolean;
  wasRecovering: boolean;
}

/**
 * Owns the last server-authoritative snapshot received by this browser.
 * Local UI code may derive from it, but must not mutate these objects to
 * advance the game.
 */
export class ServerStateStore {
  private currentPublic: PublicRoomState | null = null;
  private currentPrivate: PrivatePlayerState | null = null;
  private publicFingerprint = "";
  private privateFingerprint = "";
  private retiredInstances = new Set<string>();
  private currentIdentity: ClientIdentity | null;

  constructor(identity: ClientIdentity | null = null) {
    this.currentIdentity = identity;
  }

  get publicState(): PublicRoomState | null {
    return this.currentPublic;
  }

  get privateState(): PrivatePlayerState | null {
    return this.currentPrivate;
  }

  get identity(): ClientIdentity | null {
    return this.currentIdentity;
  }

  set identity(value: ClientIdentity | null) {
    if (!value || (this.currentPublic && this.currentPublic.roomCode !== value.roomCode)) this.clearSnapshots();
    if (this.currentPrivate && this.currentPrivate.playerId !== value?.playerId) {
      this.currentPrivate = null;
      this.privateFingerprint = "";
    }
    this.currentIdentity = value;
  }

  applyPublic(next: PublicRoomState): PublicStateApplyResult {
    const previous = this.currentPublic;
    const sameRoom = previous?.roomCode === next.roomCode;
    const rejected = { accepted: false, changed: false, wasRecovering: Boolean(previous?.recovery) };
    if (this.currentIdentity && this.currentIdentity.roomCode !== next.roomCode) return rejected;

    // A reconnect or an old polling response must never move the visible
    // room backwards. Room codes can be reused after cleanup, so only apply
    // revision ordering inside the same room instance.
    if (sameRoom && previous?.instanceId && next.instanceId && previous.instanceId !== next.instanceId) {
      // Revisions are only comparable inside an instance, never across them.
      if (this.retiredInstances.has(next.instanceId)) return rejected;
      this.retiredInstances.add(previous.instanceId);
    } else if (sameRoom && previous?.revision !== undefined && next.revision !== undefined && next.revision < previous.revision) {
      return rejected;
    }
    if (!sameRoom) this.retiredInstances.clear();

    const fingerprint = JSON.stringify(next);
    const changed = fingerprint !== this.publicFingerprint;
    this.currentPublic = next;
    this.publicFingerprint = fingerprint;
    return { accepted: true, changed, wasRecovering: Boolean(previous?.recovery) };
  }

  applyPrivate(next: PrivatePlayerState): { accepted: boolean; changed: boolean; hadRole: boolean } {
    const hadRole = Boolean(this.currentPrivate?.role);
    if (this.currentIdentity && next.playerId !== this.currentIdentity.playerId) return { accepted: false, changed: false, hadRole };
    const fingerprint = JSON.stringify(next);
    const changed = fingerprint !== this.privateFingerprint;
    this.currentPrivate = next;
    this.privateFingerprint = fingerprint;
    return { accepted: true, changed, hadRole };
  }

  clearSnapshots(): void {
    this.currentPublic = null;
    this.currentPrivate = null;
    this.publicFingerprint = "";
    this.privateFingerprint = "";
    this.retiredInstances.clear();
  }

  clear(): void {
    this.clearSnapshots();
    this.currentIdentity = null;
  }
}
