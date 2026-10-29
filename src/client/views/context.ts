import type { PublicRoomState, PrivatePlayerState } from "../../shared/game";

export interface GameViewContext {
  publicState: PublicRoomState;
  privateState: PrivatePlayerState | null;
  identity: { playerId: string } | null;
  pendingTeam: ReadonlySet<string>;
  pendingQuestIndex: number;
  pendingAssassinTarget: string | null;
  pendingActions: ReadonlySet<string>;
  serverConnected: boolean;
  roleConfigurationExpanded: boolean;
  hidePrivateRole: boolean;
  expandedVoteRecords: ReadonlySet<string>;
}
