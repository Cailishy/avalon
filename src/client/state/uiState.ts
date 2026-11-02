export type LandingMode = "create" | "join";

export interface LandingDraft {
  name: string;
  roomCode: string;
  count: string;
}

/** State that is intentionally local to the current browser view. */
export class UiStateStore {
  toastTimer: number | null = null;
  pendingTeam = new Set<string>();
  pendingTeamDraftKey = "";
  pendingQuestIndex = 0;
  pendingAssassinTarget: string | null = null;
  lastGameResultKey = "";
  gallerySide = "all";
  showRulesModal = false;
  showGalleryModal = false;
  showShareModal = false;
  showDissolveConfirm = false;
  showLeaveConfirm = false;
  hidePrivateRole = false;
  roleConfigurationExpanded = false;
  landingMode: LandingMode;
  landingDraft: LandingDraft;
  showRoleDetailModal = false;
  showSoloModal = false;
  selectedQuestForDetail: number | null = null;
  soloPlayerCount = 5;
  expandedVoteRecords = new Set<string>();
  selectedRoleForDetail: string | null = null;
  roleDetailReturnTo: "rules" | "gallery" | null = null;
  rulesPlayerCount = 5;

  constructor(landingMode: LandingMode, landingDraft: LandingDraft) {
    this.landingMode = landingMode;
    this.landingDraft = landingDraft;
  }

  resetSessionView(): void {
    this.pendingTeam.clear();
    this.pendingTeamDraftKey = "";
    this.pendingQuestIndex = 0;
    this.pendingAssassinTarget = null;
    this.showLeaveConfirm = false;
    this.hidePrivateRole = false;
    this.roleConfigurationExpanded = false;
    this.showRulesModal = false;
    this.showGalleryModal = false;
    this.showShareModal = false;
    this.showDissolveConfirm = false;
    this.showRoleDetailModal = false;
    this.selectedRoleForDetail = null;
    this.roleDetailReturnTo = null;
    this.showSoloModal = false;
    this.selectedQuestForDetail = null;
    this.expandedVoteRecords.clear();
  }
}
