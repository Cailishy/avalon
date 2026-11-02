import type { GameViewContext } from "../views/context";
import { NetworkStateStore } from "./networkState";
import { ServerStateStore } from "./serverState";
import { UiStateStore } from "./uiState";

/** Converts the three state owners into the narrow read model used by views. */
export function selectGameViewContext(server: ServerStateStore, ui: UiStateStore, network: NetworkStateStore): GameViewContext {
  return {
    publicState: server.publicState!,
    privateState: server.privateState,
    identity: server.identity,
    pendingTeam: ui.pendingTeam,
    pendingQuestIndex: ui.pendingQuestIndex,
    pendingAssassinTarget: ui.pendingAssassinTarget,
    pendingActions: network.pendingActions,
    serverConnected: network.serverConnected && (!server.identity || network.sessionReady),
    roleConfigurationExpanded: ui.roleConfigurationExpanded,
    hidePrivateRole: ui.hidePrivateRole,
    expandedVoteRecords: ui.expandedVoteRecords,
  };
}
