import { io, type Socket } from "socket.io-client";
import type { PrivatePlayerState, PublicRoomState } from "../shared/game";
import { FACTION_NAMES, getTeamSize } from "../shared/game";
import type { VoiceAccess, VoicePolicy } from "../shared/voice";
import { GameAudio } from "./audio";
import { bindSoundSettings, closeSoundSettings, soundButton } from "./audioControls";
import { DialogMotion } from "./dialogMotion";
import { icon } from "./icons";
import { portraitMarkup, rolePortraitCell } from "./portraits";
import { getCompletedQuestDetails } from "./questDetails";
import { formatRoleKnowledge, formatRoleKnowledgeInfo, formatRoleName, formatRoleText, formatWinnerReason } from "./roleLabels";
import "./table-theme.css";
import { minimumTableDiameter, tableLayout } from "./tableLayout";
import { escapeHtml, getTargetPlayerCount, getTimerRemainingMs } from "./viewHelpers";
import * as views from "./views";
import { renderEntry } from "./views/entry";
import { renderGalleryModal, renderRoleDetailModal, renderRulesModal } from "./views/helpDialogs";
import { renderDissolveConfirmModal, renderLeaveConfirmModal, renderShareModal, renderSoloModal } from "./views/roomDialogs";
import { VoiceChat } from "./voice";
import { CommandRequests } from "./commandRequests";
import { serverClock } from "./serverClock";
import { PROTOCOL_VERSION, type ClockReply, type GameAck } from "../shared/protocol";
import { patchHtml, RenderEvents } from "./domRenderer";
import { NetworkStateStore } from "./state/networkState";
import { ServerStateStore, type ClientIdentity } from "./state/serverState";
import { selectGameViewContext } from "./state/selectors";
import { UiStateStore } from "./state/uiState";

type Ack = GameAck;
type Identity = ClientIdentity;

const SESSION_KEY = "awalong-lan-session";
const STATE_SYNC_INTERVAL_MS = 1500;
const STATE_SYNC_TIMEOUT_MS = 3000;
const REQUEST_ACTIONS: Record<string, string[]> = {
  "room:create": ["create", "solo-start"], "room:join": ["join"], "room:start": ["start"],
  "player:setReady": ["ready"], "team:propose": ["propose"],
  "vote:submit": ["vote-yes", "vote-no"], "mission:submit": ["mission-success", "mission-fail"],
  "assassin:choose": ["assassinate"], "room:leave": ["leave-confirm"],
  "speech:end": ["end-speech"],
  "room:restart": ["restart"], "room:dissolve": ["dissolve-confirm"],
};
const SYNC_AFTER_ACK_EVENTS = new Set([
  "room:create",
  "room:join",
  "room:rejoin",
  "room:setPlayerCount",
  "player:setReady",
  "room:start",
  "room:restart",
  "room:leave",
  "player:kick",
  "team:propose",
  "vote:submit",
  "mission:submit",
  "assassin:choose",
  "speech:end",
]);
const socket: Socket = io();
const app = document.querySelector<HTMLDivElement>("#app");

const serverState = new ServerStateStore(readSession());
const landingMode: "create" | "join" = window.location.search.includes("room=") ? "join" : "create";
const uiState = new UiStateStore(landingMode, { name: "", roomCode: new URLSearchParams(window.location.search).get("room") ?? "", count: "5" });
const networkState = new NetworkStateStore(socket.connected);
const gameAudio = new GameAudio((message) => showToast(message));
const voice = new VoiceChat({
  requestAccess: () => new Promise((resolve, reject) => {
    if (!serverState.identity || !socket.connected) { reject(new Error("游戏连接已断开。")); return; }
    socket.timeout(7000).emit("voice:join", authPayload(), (error: Error | null, result: Ack & { access?: VoiceAccess }) => {
      if (error || !result?.ok || !result.access) reject(new Error(result?.error ?? "语音连接超时。"));
      else resolve(result.access);
    });
  }),
  notify: message => showToast(message),
  changed: active => gameAudio.setVoiceActive(active),
});
let tableObserver: ResizeObserver | null = null;
let tableSurface: HTMLElement | null = null;
const renderEvents = new RenderEvents();
const listen = renderEvents.listen.bind(renderEvents);
const dialogMotion = new DialogMotion();
const animatedDialogs = new WeakSet<HTMLElement>();
const commands = new CommandRequests(socket, {
  phaseId: () => serverState.publicState?.phaseId,
  now: () => serverClock.now(),
  canSend: () => !serverState.identity || networkState.sessionReady,
  confirmPhaseChange: request => {
    if (request.event !== "speech:end") return false;
    const state = serverState.publicState;
    const playerId = request.payload.playerId;
    return state?.phase !== "speech" || state.timer?.speakerId !== playerId;
  },
  reconcile: () => { syncClock(); requestStateSync(); },
  uncertain: () => {
    if (!networkState.uncertainNotice) showToast("操作结果尚未确认，连接恢复后会继续核对。");
    networkState.uncertainNotice = true;
  },
});

if (!app) throw new Error("App root not found");

window.addEventListener("pointerdown", () => gameAudio.unlock(), { capture: true });
window.addEventListener("keydown", () => gameAudio.unlock(), { capture: true });
window.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const close = document.querySelector<HTMLElement>(".role-reveal-overlay .modal-close") ?? app?.querySelector<HTMLElement>(".modal-content .modal-close");
  close?.click();
  if (!close && uiState.roleConfigurationExpanded) {
    uiState.roleConfigurationExpanded = false;
    render();
  }
});
window.addEventListener("pagehide", () => { commands.cancel(); voice.dispose(); gameAudio.dispose(); });
document.addEventListener?.("visibilitychange", () => {
  if (document.visibilityState === "visible") { syncClock(true); requestStateSync(); }
});
socket.on("server:hello", (hello: { protocolVersion?: number }) => {
  if (hello.protocolVersion !== PROTOCOL_VERSION) window.location.reload();
});

socket.on("connect", () => {
  const wasDisconnected = !networkState.serverConnected;
  networkState.markConnected();
  syncClock(true);

  if (serverState.identity) {
    networkState.sessionReady = false;
    if (networkState.pendingActions.has("room:rejoin")) {
      // The previous reconnect attempt may still be waiting for an ack. Keep
      // its idempotent request and retry it on the fresh socket instead of
      // letting the duplicate-event guard leave the session locked.
      commands.retry("room:rejoin");
      render();
      return;
    }
    emitAck("room:rejoin", authPayload(), (ack) => {
      if (!ack.ok) {
        if (ack.code === "UNCONFIRMED" && networkState.sessionReady) return;
        if (isSessionInvalid(ack.error ?? "", ack.code)) leaveLocal(ack.error);
        else showToast(ack.error ?? "重连尚未确认，正在继续核对。");
      } else {
        networkState.sessionReady = true;
        if (wasDisconnected) {
          showToast("已重新连接", "success");
        }
        requestStateSync();
        commands.resume();
        render();
      }
    });
  } else {
    networkState.sessionReady = true;
    commands.resume();
    render();
  }
});

socket.on("disconnect", (reason) => {
  networkState.clockGeneration++;
  networkState.clockInFlight = false;
  networkState.markDisconnected();
  networkState.showReconnectingIndicator = false;
  if (reason === "io server disconnect") {
    showToast("连接已断开");
  }
  render();
});

socket.on("access:required", () => window.location.reload());

socket.on("connect_error", (error) => {
  if ((error as Error & { data?: { code?: string } })?.data?.code === "ACCESS_REQUIRED") {
    window.location.reload();
    return;
  }
  networkState.markDisconnected();
  networkState.reconnectAttempts += 1;

  if (networkState.reconnectAttempts >= 3 && !networkState.showReconnectingIndicator) {
    networkState.showReconnectingIndicator = true;
    render();
  }
});

socket.on("room:state", (state: PublicRoomState) => {
  const previousState = serverState.publicState;
  const applied = serverState.applyPublic(state);
  if (!applied.accepted) return;
  // Entry snapshots can arrive before the join ack; defer their UI effects.
  if (!serverState.identity) return;
  if (!state.players.some(player => player.id === serverState.identity?.playerId)) { render(); return; }
  const stateChanged = applied.changed;
  const wasRecovering = applied.wasRecovering;

  // Rejoining a finished game must not replay its victory animation.
  if (!previousState) {
    if (state.phase === "result" && state.winner) {
      uiState.lastGameResultKey = `${state.roomCode}:${state.winner}:${state.winnerReason}`;
    }
  }

  maybeShowGameResult(state);
  commands.phaseChanged();
  if (state.recovery || state.phase !== "reveal") document.querySelector(".role-reveal-overlay")?.remove();
  if (state.phase !== "assassin") uiState.pendingAssassinTarget = null;
  if (state.phase === "lobby") uiState.lastGameResultKey = "";
  reconcilePendingTeam(state);
  if (state.phase === "lobby") {
    uiState.expandedVoteRecords.clear();
    uiState.rulesPlayerCount = getTargetPlayerCount(state);
  }
  if (stateChanged) render();
  if (wasRecovering && !state.recovery && state.phase === "reveal" && serverState.privateState?.role) showRoleReveal(serverState.privateState);
});

socket.on("player:privateState", (state: PrivatePlayerState) => {
  const { accepted, changed: stateChanged, hadRole } = serverState.applyPrivate(state);
  if (!accepted || !serverState.identity) return;

  if (!hadRole && state.role && serverState.publicState?.phase === "reveal" && !serverState.publicState.recovery) {
    showRoleReveal(state);
  } else if (stateChanged) {
    render();
  }
});

socket.on("room:removed", (payload: { message?: string }) => {
  leaveForced(payload.message ?? "你已被移出房间。");
});

socket.on("room:dissolved", (payload: { message?: string }) => {
  leaveForced(payload.message ?? "房间已解散。");
});

socket.on("voice:policy", (policy: VoicePolicy) => voice.setPolicy(policy));

window.setInterval(() => requestStateSync(), STATE_SYNC_INTERVAL_MS);
window.setInterval(() => syncClock(), 30_000);

function syncClock(force = false): void {
  if (force) { networkState.clockGeneration++; networkState.clockInFlight = false; serverClock.forgetSamples(); }
  if (!socket.connected || networkState.clockInFlight) return;
  networkState.clockInFlight = true;
  const generation = ++networkState.clockGeneration;
  const sent = performance.now();
  const timer = window.setTimeout(() => { if (generation === networkState.clockGeneration) networkState.clockInFlight = false; }, 5000);
  socket.emit("clock:sync", {}, (reply?: ClockReply) => {
    if (generation !== networkState.clockGeneration) return;
    window.clearTimeout(timer);
    networkState.clockInFlight = false;
    if (reply && serverClock.sample(sent, reply)) { updateTimerDisplay(); commands.resume(); }
  });
}

let timerAnimationFrame: number | null = null;
function scheduleTimerUpdate(): void {
  if (timerAnimationFrame !== null) return;

  function updateLoop(): void {
    updateTimerDisplay();
    timerAnimationFrame = window.requestAnimationFrame(updateLoop);
  }

  timerAnimationFrame = window.requestAnimationFrame(updateLoop);
}

scheduleTimerUpdate();
render();

function showPageTransition(callback: () => void): void {
  const transition = document.createElement("div");
  transition.className = "page-transition";
  document.body.appendChild(transition);

  setTimeout(() => {
    callback();
    transition.classList.add("leaving");
    setTimeout(() => {
      transition.remove();
    }, 650);
  }, 520);
}

function leaveForced(message: string): void {
  leaveLocal(message);
}

function leaveLocal(message?: string): void {
  commands.cancel();
  networkState.pendingActions.clear();
  closeSoundSettings();
  document.querySelectorAll(".role-reveal-overlay, .mission-result-overlay, .game-result-overlay").forEach(overlay => overlay.remove());
  clearSession();
  serverState.clear();
  uiState.resetSessionView();
  uiState.lastGameResultKey = "";
  render();
  if (message) showToast(message);
}

function showRoleReveal(state: PrivatePlayerState): void {
  const sideClass = state.side === "good" ? "good" : state.side === "evil" ? "evil" : "";

  document.querySelector(".role-reveal-overlay")?.remove();
  const remainingMs = getTimerRemainingMs(serverState.publicState?.timer?.deadline ?? serverClock.now());
  const overlay = document.createElement("div");
  overlay.className = "role-reveal-overlay";
  overlay.innerHTML = `
    <div class="role-reveal-card ${sideClass}">
      ${state.role ? `<div class="identity-art">${portraitMarkup(rolePortraitCell(state.role, state.servantVariant), "reveal-art")}<div class="identity-seal">${icon("shield", 70)}</div></div>` : ""}
      <div class="reveal-copy">
        <p>你的身份</p>
        <h2 class="role-name-reveal">${escapeHtml(formatRoleName(state.roleName))}</h2>
        <div class="role-side-badge ${sideClass}">${FACTION_NAMES[state.side ?? "good"]}</div>
        <p>${escapeHtml(state.knowledgeInfo && serverState.publicState ? formatRoleKnowledgeInfo(state.knowledgeInfo, serverState.publicState.players) : formatRoleKnowledge(state.knowledge))}</p>
        <div class="identity-countdown"><span>身份揭晓</span><strong data-phase-countdown>${Math.ceil(remainingMs / 1000)} 秒</strong></div>
        <div class="identity-progress"><div data-phase-progress style="width:100%"></div></div>
      </div>
    </div>
  `;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "你的身份");
  document.body.appendChild(overlay);
  window.setTimeout(() => overlay.remove(), remainingMs);
  render();
}



function render(): void {
  renderEvents.reset();
  const identity = serverState.identity;
  const publicState = serverState.publicState;
  gameAudio.update(identity ? publicState : null, identity?.playerId ?? null, networkState.serverConnected);
  voice.updateContext(identity && publicState ? identity.roomCode : null, networkState.serverConnected);
  if (!identity || !publicState) {
    renderLanding();
    return;
  }

  const me = publicState.players.find((player) => player.id === identity?.playerId);
  if (!me) {
    clearSession();
    gameAudio.update(null, null, networkState.serverConnected);
    renderLanding();
    return;
  }

  renderGame(me.id);
}

function renderLanding(): void {
  tableObserver?.disconnect();
  tableObserver = null;
  tableSurface = null;
  patchHtml(app!, renderEntry({
    landingMode: uiState.landingMode, landingDraft: uiState.landingDraft, hasPreviousSession: !!serverState.identity, soundControls: soundButton(gameAudio, "icon-btn"),
    dialogs: {
      rules: uiState.showRulesModal ? renderRulesModal(uiState.rulesPlayerCount) : "",
      gallery: uiState.showGalleryModal ? renderGalleryModal(uiState.gallerySide) : "",
      detail: uiState.showRoleDetailModal && uiState.selectedRoleForDetail ? renderRoleDetailModal(uiState.selectedRoleForDetail) : "",
      solo: uiState.showSoloModal ? renderSoloModal(uiState.soloPlayerCount) : "",
      share: uiState.showShareModal && serverState.publicState ? renderShareModal(serverState.publicState.roomCode, getShareLinks()) : "",
      dissolve: uiState.showDissolveConfirm ? renderDissolveConfirmModal() : "",
    },
  }));
  bindLandingActions();
}

function renderGame(myId: string): void {
  const state = serverState.publicState!;
  if (uiState.selectedQuestForDetail !== null && !getCompletedQuestDetails(state, uiState.selectedQuestForDetail)) uiState.selectedQuestForDetail = null;

  patchHtml(app!, `
    <div class="game-container" data-render-key="game:${state.roomCode}" data-phase="${state.phase}" data-phase-id="${state.phaseId}">
      ${renderConnectionStatus()}
      <header class="game-header" data-render-key="header">
        <div class="title"><strong>阿瓦隆</strong><span class="room-code">房间 ${escapeHtml(state.roomCode)}</span></div>
        <div class="header-timer-slot">
          ${renderTimerBanner()}
        </div>
        <div class="controls">
          <button class="icon-btn" data-action="show-share" title="分享房间" aria-label="分享房间">${icon("share")}</button>
          <button class="icon-btn" data-action="show-rules" title="游戏规则" aria-label="游戏规则">${icon("rules")}</button>
          <button class="icon-btn" data-action="show-gallery" title="角色收藏馆" aria-label="角色收藏馆">${icon("gallery")}</button>
          ${soundButton(gameAudio, "icon-btn")}
          ${voice.headerButton()}
          <button class="icon-btn" data-action="leave" title="离开房间" aria-label="离开房间">
            ${icon("leave")}
          </button>
        </div>
      </header>

      <main class="game-main" data-render-key="workspace">
        ${renderQuestTrack()}
        <aside class="left-stack" data-render-key="identity">
          ${renderRoleConfiguration(state)}
          ${renderRolePanel()}
        </aside>
        ${renderRoundTable(myId)}
        <aside class="side-stack" data-render-key="actions">
          ${renderActionPanel(myId)}
        </aside>
        <aside class="record-stack" data-render-key="records">${state.phase === "lobby" ? renderLobbyRoster(myId) : renderHistoryPanel()}</aside>
      </main>
    </div>
    ${uiState.showRulesModal ? renderRulesModal(uiState.rulesPlayerCount) : ""}
    ${uiState.showGalleryModal ? renderGalleryModal(uiState.gallerySide) : ""}
    ${uiState.showShareModal ? renderShareModal(state.roomCode, getShareLinks()) : ""}
    ${uiState.showDissolveConfirm ? renderDissolveConfirmModal() : ""}
    ${uiState.showLeaveConfirm ? renderLeaveConfirmModal(state.roomCode) : ""}
    ${uiState.showRoleDetailModal && uiState.selectedRoleForDetail ? renderRoleDetailModal(uiState.selectedRoleForDetail) : ""}
    ${uiState.selectedQuestForDetail !== null ? renderQuestDetailModal(uiState.selectedQuestForDetail) : ""}
  `);

  positionPlayersInCircle();
  bindGameActions(myId);
  voice.bind(app!, renderEvents.signal);
  voice.refresh();
  for (const event of networkState.pendingActions) disableActionButtons(event);
}

function renderRoleConfiguration(state: PublicRoomState): string {
  return views.renderRoleConfiguration(selectGameViewContext(serverState, uiState, networkState), state);
}

function renderQuestTrack(): string {
  return views.renderQuestTrack(selectGameViewContext(serverState, uiState, networkState));
}

function renderConnectionStatus(): string {
  if (!networkState.showReconnectingIndicator && networkState.serverConnected) return "";

  if (networkState.showReconnectingIndicator && !networkState.serverConnected) {
    return `
      <div class="connection-status reconnecting">
        <span class="status-icon">⚠️</span>
        <span class="status-text">正在重连服务器...</span>
        <span class="status-attempt">(尝试 ${networkState.reconnectAttempts})</span>
      </div>
    `;
  }

  return "";
}

function renderTimerBanner(): string {
  const publicState = serverState.publicState;
  const timer = publicState?.timer;
  if (!timer) return "";
  const remainingMs = getTimerRemainingMs(timer.deadline);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const progress = Math.max(0, Math.min(100, (remainingMs / timer.durationMs) * 100));
  const isUrgent = remainingMs <= 10_000 && !["reveal", "proposalResult", "missionResult"].includes(timer.kind);
  const speaker = timer.speakerId ? publicState?.players.find((player) => player.id === timer.speakerId) : null;
  const label = timer.kind === "speech" && speaker ? `${speaker.name} 发言` : timer.label;

  return `
    <div class="game-timer ${isUrgent ? "urgent" : ""}" data-timer-deadline="${timer.deadline}" data-timer-duration="${timer.durationMs}">
      <div class="game-timer-main">
        <span class="game-timer-label">${escapeHtml(label)}</span>
        <span class="game-timer-time">${formatTimerSeconds(remainingSeconds)}</span>
      </div>
      <div class="game-timer-track">
        <div class="game-timer-fill" style="width: ${progress}%"></div>
      </div>
    </div>
  `;
}

function updateTimerDisplay(): void {
  const timer = serverState.publicState?.timer;
  const element = document.querySelector<HTMLElement>(".game-timer");
  if (!timer || !element) return;

  const remainingMs = getTimerRemainingMs(timer.deadline);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const progress = Math.max(0, Math.min(100, (remainingMs / timer.durationMs) * 100));
  element.classList.toggle("urgent", remainingMs <= 10_000 && !["reveal", "proposalResult", "missionResult"].includes(timer.kind));
  element.querySelector<HTMLElement>(".game-timer-time")!.textContent = formatTimerSeconds(remainingSeconds);
  element.querySelector<HTMLElement>(".game-timer-fill")!.style.width = `${progress}%`;
  document.querySelectorAll<HTMLElement>("[data-phase-countdown]").forEach(label => { label.textContent = `${remainingSeconds} 秒`; });
  document.querySelectorAll<HTMLElement>("[data-phase-progress]").forEach(bar => { bar.style.width = `${progress}%`; });
}


function formatTimerSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function renderRoundTable(myId: string): string {
  return views.renderRoundTable(selectGameViewContext(serverState, uiState, networkState), myId);
}

function renderRolePanel(): string {
  return views.renderRolePanel(selectGameViewContext(serverState, uiState, networkState));
}

function renderLobbyRoster(myId: string): string {
  return views.renderLobbyRoster(selectGameViewContext(serverState, uiState, networkState), myId);
}

function renderActionPanel(myId: string): string {
  return views.renderActionPanel(selectGameViewContext(serverState, uiState, networkState), myId);
}

function renderHistoryPanel(): string {
  return views.renderHistoryPanel(selectGameViewContext(serverState, uiState, networkState));
}


function renderQuestDetailModal(questIndex: number): string {
  return views.renderQuestDetailModal(selectGameViewContext(serverState, uiState, networkState), questIndex);
}












function positionPlayersInCircle(): void {
  const surface = app!.querySelector<HTMLElement>(".table-surface");
  if (!surface) { tableObserver?.disconnect(); tableObserver = null; tableSurface = null; return; }
  const position = () => {
    const seats = [...surface.querySelectorAll<HTMLElement>(".player-seat")];
    const first = seats[0];
    if (!first) return;
    surface.style.minWidth = `${minimumTableDiameter(seats.length, first.offsetWidth, first.offsetHeight)}px`;
    const rect = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const layout = tableLayout(seats.length, rect.width, rect.height, first.offsetWidth, first.offsetHeight);
    surface.dataset.layout = layout.mode;
    seats.forEach((seat, index) => {
      seat.style.left = `${layout.points[index].x}px`;
      seat.style.top = `${layout.points[index].y}px`;
    });
  };
  position();
  if (surface !== tableSurface && typeof ResizeObserver !== "undefined") {
    tableObserver?.disconnect();
    tableSurface = surface;
    tableObserver = new ResizeObserver(position);
    tableObserver.observe(surface);
  }
}

function bindLandingActions(): void {
  app!.querySelectorAll<HTMLInputElement>("#nameInput, #joinNameInput").forEach(input => {
    listen(input, "input", () => { uiState.landingDraft.name = input.value; });
  });
  listen(app!.querySelector<HTMLInputElement>("#roomInput"), "input", event => {
    uiState.landingDraft.roomCode = (event.target as HTMLInputElement).value;
  });
  listen(app!.querySelector<HTMLSelectElement>("#createPlayerCount"), "change", event => {
    uiState.landingDraft.count = (event.target as HTMLSelectElement).value;
  });
  app!.querySelectorAll<HTMLElement>("[data-entry-mode]").forEach(button => {
    listen(button, "click", () => {
      uiState.landingMode = button.dataset.entryMode === "join" ? "join" : "create";
      render();
    });
  });
  listen(app!.querySelector("[data-action='create']"), "click", () => {
    const name = requireInput("#nameInput", "请输入你的名字");
    if (!name) return;
    const targetPlayerCount = readNumberInput("#createPlayerCount", 5);
    emitAck("room:create", { name, targetPlayerCount }, (ack) => {
      const { roomCode, playerId, sessionToken } = ack;
      if (ack.ok && roomCode && playerId && sessionToken) {
        showPageTransition(() => {
          setIdentity({ roomCode, playerId, sessionToken, name });
        });
      } else {
        showToast(ack.error ?? "创建房间失败");
      }
    });
  });

  listen(app!.querySelector("[data-action='join']"), "click", () => {
    const name = readInput("#joinNameInput");
    const roomCode = readInput("#roomInput").toUpperCase();
    if (!name && !roomCode) {
      showToast("请输入你的名字和房间代码");
      app!.querySelector<HTMLInputElement>("#joinNameInput")?.focus();
      return;
    }
    if (!name) {
      showToast("请输入你的名字");
      app!.querySelector<HTMLInputElement>("#joinNameInput")?.focus();
      return;
    }
    if (!roomCode) {
      showToast("请输入房间代码");
      app!.querySelector<HTMLInputElement>("#roomInput")?.focus();
      return;
    }
    emitAck("room:join", { roomCode, name }, (ack) => {
      const joinedRoomCode = ack.roomCode;
      const { playerId, sessionToken } = ack;
      if (ack.ok && joinedRoomCode && playerId && sessionToken) {
        showPageTransition(() => {
          setIdentity({ roomCode: joinedRoomCode, playerId, sessionToken, name });
        });
      } else {
        showToast(ack.error ?? "加入房间失败");
      }
    });
  });

  listen(app!.querySelector("[data-action='rejoin']"), "click", () => {
    if (!serverState.identity) return;
    showPageTransition(() => {
      emitAck("room:rejoin", authPayload(), (ack) => {
        if (!ack.ok) {
          if (isSessionInvalid(ack.error ?? "", ack.code)) leaveLocal(ack.error);
          else showToast(ack.error ?? "重连尚未确认，请稍后重试。");
        } else {
          networkState.sessionReady = true;
          commands.resume();
          requestStateSync();
          render();
        }
      });
    });
  });

  listen(app!.querySelector("[data-action='show-rules']"), "click", () => {
    uiState.showRulesModal = true;
    render();
  });

  listen(app!.querySelector("[data-action='show-gallery']"), "click", () => {
    uiState.showGalleryModal = true;
    render();
  });

  listen(app!.querySelector("[data-action='show-share']"), "click", () => {
    uiState.showShareModal = true;
    render();
  });

  bindSoundSettings(app!, gameAudio, renderEvents.signal);

  listen(app!.querySelector("[data-action='solo']"), "click", () => {
    uiState.soloPlayerCount = Number(uiState.landingDraft.count);
    uiState.showSoloModal = true;
    render();
  });

  listen(app!.querySelector("[data-action='solo-start']"), "click", () => {
    const name = uiState.landingDraft.name.trim() || "测试玩家";
    const targetPlayerCount = uiState.soloPlayerCount;
    emitAck("room:create", { name, targetPlayerCount }, (ack) => {
      const { roomCode, playerId, sessionToken } = ack;
      if (ack.ok && roomCode && playerId && sessionToken) {
        uiState.showSoloModal = false;
        render();
        const hostAuth = {
          roomCode,
          playerId,
          sessionToken,
        };
        showPageTransition(() => {
          setIdentity({ roomCode, playerId, sessionToken, name });
          emitAck("room:addAI", { ...hostAuth, count: targetPlayerCount - 1 }, (botAck) => {
            if (!botAck.ok) {
              showToast(botAck.error ?? "添加 AI 失败");
              return;
            }
            emitAck("room:start", hostAuth, ackToast);
          });
        });
      } else {
        showToast(ack.error ?? "创建失败");
      }
    });
  });

  bindModalActions();
}

function bindGameActions(myId: string): void {
  const priv = serverState.privateState;

  listen(app!.querySelector("[data-action='toggle-private']"), "click", () => {
    uiState.hidePrivateRole = !uiState.hidePrivateRole;
    render();
  });

  app!.querySelectorAll("[data-action='show-share']").forEach(button => listen(button, "click", () => {
    uiState.showShareModal = true;
    render();
  }));

  listen(app!.querySelector("[data-action='show-rules']"), "click", () => {
    uiState.showRulesModal = true;
    render();
  });

  listen(app!.querySelector("[data-action='show-gallery']"), "click", () => {
    uiState.showGalleryModal = true;
    render();
  });

  bindSoundSettings(app!, gameAudio, renderEvents.signal);

  listen(app!.querySelector("[data-action='show-own-role']"), "click", () => {
    showOwnRoleDetail();
  });

  listen(app!.querySelector("[data-action='show-own-role']"), "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
    keyboardEvent.preventDefault();
    showOwnRoleDetail();
  });

  listen(app!.querySelector("[data-action='leave']"), "click", () => {
    uiState.showLeaveConfirm = true;
    render();
  });
  listen(app!.querySelector("[data-action='leave-confirm']"), "click", () => {
    if (!serverState.identity) return;
    if (!ensureServerConnected()) return;
    const payload = authPayload();
    emitAck("room:leave", payload, (ack) => {
      if (ack.ok) {
        leaveLocal("已离开房间。");
        return;
      }
      showToast(ack.error ?? "离开房间失败");
      requestStateSync(true);
      render();
    });
  });

  listen(app!.querySelector("[data-action='start']"), "click", () => {
    if (!ensureServerConnected()) return;
    emitAck("room:start", authPayload(), ackToast);
  });

  listen(app!.querySelector("[data-action='ready']"), "click", () => {
    if (!ensureServerConnected()) return;
    const me = serverState.publicState!.players.find((player) => player.id === myId);
    if (!me) return;
    const nextReady = !me.ready;
    emitAck("player:setReady", { ...authPayload(), ready: nextReady }, (ack) => {
      if (!ack.ok) {
        showToast(ack.error ?? "准备失败");
      }
    });
  });

  listen(app!.querySelector("#lobbyPlayerCount"), "change", (event) => {
    if (!ensureServerConnected()) {
      render();
      return;
    }
    const targetPlayerCount = parseInt((event.target as HTMLSelectElement).value, 10);
    uiState.rulesPlayerCount = targetPlayerCount;
    emitAck("room:setPlayerCount", { ...authPayload(), targetPlayerCount }, ackToast);
  });

  listen(app!.querySelector("[data-action='restart']"), "click", () => {
    if (!ensureServerConnected()) return;
    emitAck("room:restart", authPayload(), ackToast);
  });

  listen(app!.querySelector("[data-action='dissolve']"), "click", () => {
    if (!ensureServerConnected()) return;
    uiState.showDissolveConfirm = true;
    render();
  });

  listen(app!.querySelector("[data-action='propose']"), "click", () => {
    if (!ensureServerConnected()) return;
    emitAck("team:propose", { ...authPayload(), team: [...uiState.pendingTeam], questIndex: uiState.pendingQuestIndex }, ackToast);
  });

  listen(app!.querySelector("[data-action='vote-yes']"), "click", () => {
    if (!ensureServerConnected()) return;
    emitAck("vote:submit", { ...authPayload(), approved: true }, ackToast);
  });

  listen(app!.querySelector("[data-action='vote-no']"), "click", () => {
    if (!ensureServerConnected()) return;
    emitAck("vote:submit", { ...authPayload(), approved: false }, ackToast);
  });

  listen(app!.querySelector("[data-action='mission-success']"), "click", () => {
    if (!ensureServerConnected()) return;
    emitAck("mission:submit", { ...authPayload(), failed: false }, ackToast);
  });

  listen(app!.querySelector("[data-action='mission-fail']"), "click", () => {
    if (!ensureServerConnected()) return;
    emitAck("mission:submit", { ...authPayload(), failed: true }, ackToast);
  });

  listen(app!.querySelector("[data-action='end-speech']"), "click", () => {
    if (!ensureServerConnected()) return;
    emitAck("speech:end", authPayload(), (ack) => {
      if (!ack.ok) {
        showToast(ack.error ?? "结束发言失败", "error");
      }
    });
  });

  app!.querySelectorAll("[data-kick]").forEach((btn) => {
    listen(btn, "click", () => {
      if (!ensureServerConnected()) return;
      const targetId = (btn as HTMLElement).dataset.kick;
      emitAck("player:kick", { ...authPayload(), targetId }, ackToast);
    });
  });

  app!.querySelectorAll("[data-copy]").forEach((btn) => {
    listen(btn, "click", async () => {
      const url = (btn as HTMLElement).dataset.copy ?? "";
      await navigator.clipboard?.writeText(url);
      showToast("链接已复制！", "success");
    });
  });

  app!.querySelectorAll("[data-copy-code]").forEach((btn) => {
    listen(btn, "click", async () => {
      const code = (btn as HTMLElement).dataset.copyCode ?? "";
      await navigator.clipboard?.writeText(code);
      showToast("房间代码已复制！", "success");
    });
  });

  // Player selection for team proposal
  if (priv?.canPropose) {
    app!.querySelectorAll("[data-quest-index]").forEach((btn) => {
      listen(btn, "click", () => {
        const nextQuestIndex = Number((btn as HTMLElement).dataset.questIndex);
        if (!Number.isInteger(nextQuestIndex)) return;
        uiState.pendingQuestIndex = nextQuestIndex;
        uiState.pendingTeam = new Set([...uiState.pendingTeam].slice(0, getTeamSizeForDisplay(nextQuestIndex)));
        render();
      });
    });

    app!.querySelectorAll(".player-card").forEach(card => listen(card, "click", () => toggleTeamPlayer((card as HTMLElement).dataset.playerId)));
    app!.querySelectorAll<HTMLElement>("[data-team-player]").forEach(button => listen(button, "click", () => toggleTeamPlayer(button.dataset.teamPlayer)));
  }

  // Player selection for assassination
  if (serverState.publicState?.phase === "assassin" && priv?.canAssassinate) {
    app!.querySelectorAll(".player-card").forEach((card) => {
      listen(card, "click", () => {
        const targetId = (card as HTMLElement).dataset.playerId;
        if (!targetId || serverState.publicState?.phase !== "assassin" || targetId === myId || serverState.publicState.revealedRoles.some(role => role.playerId === targetId)) return;

        uiState.pendingAssassinTarget = uiState.pendingAssassinTarget === targetId ? null : targetId;
        render();
      });
    });
    listen(app!.querySelector("[data-action='assassinate']"), "click", () => {
      if (serverState.publicState?.phase !== "assassin" || !serverState.privateState?.canAssassinate || !uiState.pendingAssassinTarget || !ensureServerConnected()) return;
      emitAck("assassin:choose", { ...authPayload(), targetId: uiState.pendingAssassinTarget }, ackToast);
    });
  }

  app!.querySelectorAll<HTMLElement>(".player-card[role='button']").forEach((card) => {
    listen(card, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        card.click();
        app!.querySelector<HTMLElement>(`.player-card[data-player-id="${card.dataset.playerId}"]`)?.focus();
      }
    });
  });

  bindModalActions();
}

function toggleTeamPlayer(playerId?: string): void {
  const state = serverState.publicState;
  if (!playerId || state?.phase !== "team" || state.leaderId !== serverState.identity?.playerId || !serverState.privateState?.canPropose || networkState.pendingActions.has("team:propose")) return;
  const player = state.players.find(candidate => candidate.id === playerId);
  if (!player?.connected) {
    showToast("不能选择已断线玩家");
    return;
  }
  if (uiState.pendingTeam.has(playerId)) uiState.pendingTeam.delete(playerId);
  else if (uiState.pendingTeam.size < getTeamSizeForDisplay(uiState.pendingQuestIndex)) uiState.pendingTeam.add(playerId);
  render();
}

function showOwnRoleDetail(): void {
  const privateState = serverState.privateState;
  if (!privateState?.roleName) return;
  uiState.showRulesModal = false;
  uiState.showGalleryModal = false;
  uiState.showShareModal = false;
  uiState.showDissolveConfirm = false;
  uiState.showRoleDetailModal = true;
  uiState.selectedRoleForDetail = privateState.role === "servant" && privateState.servantVariant === "female" ? "亚瑟的忠臣（女性）" : privateState.roleName;
  uiState.roleDetailReturnTo = null;
  render();
}

function bindModalActions(): void {
  app!.querySelectorAll<HTMLElement>("[data-modal-panel]").forEach(panel => listen(panel, "click", event => event.stopPropagation()));
  app!.querySelectorAll<HTMLDetailsElement>("[data-vote-record]").forEach(details => listen(details, "toggle", () => {
    const recordId = details.dataset.voteRecord!;
    if (details.open) uiState.expandedVoteRecords.add(recordId);
    else uiState.expandedVoteRecords.delete(recordId);
  }));
  listen(app!.querySelector("#soloPlayerCount"), "change", event => {
    const count = Number((event.target as HTMLSelectElement).value);
    if (!Number.isInteger(count) || count < 5 || count > 10) return;
    uiState.soloPlayerCount = count;
    render();
  });
  listen(app!.querySelector("[data-action='toggle-role-configuration']"), "click", () => {
    uiState.roleConfigurationExpanded = !uiState.roleConfigurationExpanded;
    render();
  });
  app!.querySelectorAll<HTMLElement>("[data-role-detail]").forEach(card => listen(card, "click", () => {
    uiState.roleConfigurationExpanded = false;
    uiState.selectedRoleForDetail = card.dataset.roleDetail ?? null;
    uiState.showRoleDetailModal = !!uiState.selectedRoleForDetail;
    uiState.roleDetailReturnTo = null;
    render();
  }));
  const dialogs = app!.querySelectorAll<HTMLElement>(".modal-content");
  dialogs.forEach(dialog => {
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", dialog.querySelector("h2")?.textContent ?? "对话框");
    dialog.querySelector(".modal-close")?.setAttribute("aria-label", "关闭");
  });
  const dialog = dialogs[dialogs.length - 1];
  const elapsed = dialogMotion.update(dialog?.getAttribute("aria-label") ?? null);
  if (dialog?.parentElement && elapsed !== null && !animatedDialogs.has(dialog.parentElement)) {
    animatedDialogs.add(dialog.parentElement);
    dialog.parentElement.classList.add("dialog-entering");
    dialog.parentElement.style.setProperty("--dialog-offset", `-${elapsed}ms`);
  }
  app!.querySelectorAll("[data-action='leave-cancel']").forEach(button => listen(button, "click", () => {
    uiState.showLeaveConfirm = false;
    render();
  }));
  app!.querySelectorAll<HTMLElement>("[data-gallery-side]").forEach(button => listen(button, "click", () => {
    uiState.gallerySide = button.dataset.gallerySide ?? "all";
    render();
  }));
  app!.querySelectorAll("[data-action='close-modal']").forEach((btn) => {
    listen(btn, "click", () => {
      uiState.showRulesModal = false;
      uiState.showGalleryModal = false;
      uiState.showShareModal = false;
      uiState.showDissolveConfirm = false;
      uiState.showLeaveConfirm = false;
      uiState.showSoloModal = false;
      uiState.selectedQuestForDetail = null;
      if (uiState.showRoleDetailModal && uiState.roleDetailReturnTo) {
        uiState.showRoleDetailModal = false;
        uiState.selectedRoleForDetail = null;
        uiState.showRulesModal = uiState.roleDetailReturnTo === "rules";
        uiState.showGalleryModal = uiState.roleDetailReturnTo === "gallery";
        uiState.roleDetailReturnTo = null;
      } else {
        uiState.showRoleDetailModal = false;
        uiState.selectedRoleForDetail = null;
        uiState.roleDetailReturnTo = null;
      }
      render();
    });
  });

  listen(app!.querySelector("#rulePlayerCount"), "change", (e) => {
    uiState.rulesPlayerCount = parseInt((e.target as HTMLSelectElement).value);
    render();
  });

  app!.querySelectorAll("[data-action='dissolve-cancel']").forEach((btn) => {
    listen(btn, "click", () => {
      uiState.showDissolveConfirm = false;
      render();
    });
  });

  listen(app!.querySelector("[data-action='dissolve-confirm']"), "click", () => {
    uiState.showDissolveConfirm = false;
    emitAck("room:dissolve", authPayload(), (ack) => {
      if (ack.ok) {
        leaveForced("房间已解散。");
      } else {
        showToast(ack.error ?? "解散房间失败");
      }
    });
  });

  app!.querySelectorAll(".role-tag.clickable").forEach((btn) => {
    listen(btn, "click", (e) => {
      e.stopPropagation();
      const roleName = (btn as HTMLElement).dataset.role;
      if (roleName) {
        uiState.showRulesModal = false;
        uiState.showRoleDetailModal = true;
        uiState.selectedRoleForDetail = roleName;
        uiState.roleDetailReturnTo = "rules";
        render();
      }
    });
  });

  app!.querySelectorAll(".role-card-gallery").forEach((card) => {
    listen(card, "click", () => {
      const roleName = (card as HTMLElement).dataset.role;
      if (roleName) {
        uiState.showGalleryModal = false;
        uiState.showRoleDetailModal = true;
        uiState.selectedRoleForDetail = roleName;
        uiState.roleDetailReturnTo = "gallery";
        render();
      }
    });
  });

  app!.querySelectorAll<HTMLElement>(".history-vote-result[data-vote-details]").forEach((bar) => {
    listen(bar, "mouseenter", () => {
      try {
        const details = JSON.parse(bar.dataset.voteDetails!) as { playerId: string; approved: boolean }[];
        for (const vote of details) {
          const card = app!.querySelector<HTMLElement>(`.player-card[data-player-id="${vote.playerId}"]`);
          if (!card) continue;
          card.classList.add(vote.approved ? "vote-highlight-approve" : "vote-highlight-reject");
        }
      } catch { /* ignore */ }
    });
    listen(bar, "mouseleave", () => {
      app!.querySelectorAll(".vote-highlight-approve, .vote-highlight-reject").forEach((el) => {
        el.classList.remove("vote-highlight-approve", "vote-highlight-reject");
      });
    });
  });

  app!.querySelectorAll<HTMLElement>("[data-quest-detail]").forEach(marker => {
    listen(marker, "click", () => {
      const questIndex = Number(marker.dataset.questDetail);
      const state = serverState.publicState;
      if (!state || !getCompletedQuestDetails(state, questIndex)) return;
      uiState.selectedQuestForDetail = questIndex;
      render();
    });
  });
}

function emitAck(event: string, payload: Record<string, unknown>, callback: (ack: Ack) => void): void {
  if (networkState.pendingActions.has(event)) {
    return;
  }

  networkState.pendingActions.add(event);
  disableActionButtons(event);

  commands.send(event, payload, result => {
    networkState.pendingActions.delete(event);
    enableActionButtons(event);
    networkState.uncertainNotice = false;
    if (result.code === "PROTOCOL_MISMATCH") { window.location.reload(); return; }
    if (result.code === "REQUEST_EXPIRED") syncClock();
    if (result.code === "STALE_PHASE") requestStateSync();
    callback(result);
    if (result.ok && SYNC_AFTER_ACK_EVENTS.has(event)) {
      requestStateSync();
    }
  });
}

function disableActionButtons(event: string): void {
  const actions = REQUEST_ACTIONS[event] || [];
  actions.forEach(action => {
    const btn = app?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (btn) {
      btn.disabled = true;
      btn.classList.add("loading");
    }
  });
}

function enableActionButtons(event: string): void {
  const actions = REQUEST_ACTIONS[event] || [];
  actions.forEach(action => {
    const btn = app?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("loading");
      if (action === "mission-fail" && !serverState.privateState?.canFailMission) btn.disabled = true;
      if ((action === "vote-yes" || action === "vote-no") && !serverState.privateState?.canVote) btn.disabled = true;
      if (action === "mission-success" && !serverState.privateState?.canMission) btn.disabled = true;
      if (action === "propose" && (!serverState.privateState?.canPropose || uiState.pendingTeam.size !== getTeamSizeForDisplay(uiState.pendingQuestIndex))) btn.disabled = true;
      if (action === "assassinate" && (!serverState.privateState?.canAssassinate || !uiState.pendingAssassinTarget)) btn.disabled = true;
      if (action === "end-speech" && (serverState.publicState?.phase !== "speech" || serverState.publicState.timer?.speakerId !== serverState.identity?.playerId)) btn.disabled = true;
      if (action === "start" && serverState.publicState) {
        const me = serverState.publicState.players.find(p => p.id === serverState.identity?.playerId);
        btn.disabled = !networkState.serverConnected || !me?.isHost || serverState.publicState.players.length !== serverState.publicState.targetPlayerCount || serverState.publicState.players.some(p => !p.connected || (!p.isHost && !p.ready));
      }
      if (serverState.identity && !networkState.sessionReady) btn.disabled = true;
    }
  });
}

function requestStateSync(showErrors = false): void {
  if (!serverState.identity || networkState.syncInFlight || !socket.connected) return;

  networkState.syncInFlight = true;
  const generation = ++networkState.stateSyncGeneration;
  const payload = authPayload();
  let settled = false;
  const timer = window.setTimeout(() => {
    if (settled || generation !== networkState.stateSyncGeneration) return;
    settled = true;
    networkState.syncInFlight = false;
    if (showErrors) showToast("状态同步超时，请检查网络连接。");
    render();
  }, STATE_SYNC_TIMEOUT_MS);

  socket.emit("room:sync", payload, (ack: Ack | undefined) => {
    if (settled || generation !== networkState.stateSyncGeneration) return;
    settled = true;
    window.clearTimeout(timer);
    networkState.syncInFlight = false;

    if (!ack?.ok) {
      const message = ack?.error ?? "状态同步失败，请重试。";
      if (isSessionInvalid(message, ack?.code)) {
        leaveForced(message);
        return;
      }
      if (showErrors) showToast(message);
      else render();
    } else {
      const needsRender = !networkState.sessionReady;
      networkState.sessionReady = true;
      if (needsRender) render();
      commands.resume();
    }
  });
}

function ensureServerConnected(): boolean {
  if (networkState.serverConnected && socket.connected && (!serverState.identity || networkState.sessionReady)) return true;
  showToast("连接已断开，正在重连...");
  requestStateSync(true);
  return false;
}

function isSessionInvalid(message: string, code?: string): boolean {
  if (code === "SESSION_INVALID" || code === "ROOM_NOT_FOUND" || code === "PLAYER_NOT_FOUND") return true;
  const text = message.toLowerCase();
  return message.includes("房间不存在") || message.includes("玩家不存在") || message.includes("会话已失效") || message.includes("请求格式不正确") || text.includes("room does not exist") || text.includes("session expired");
}

function ackToast(ack: Ack): void {
  if (!ack.ok) showToast(formatRoleText(ack.error ?? "Action failed"));
}

function authPayload(): Record<string, string> {
  const identity = serverState.identity;
  if (!identity) throw new Error("Not joined");
  return {
    roomCode: identity.roomCode,
    playerId: identity.playerId,
    sessionToken: identity.sessionToken,
  };
}

function setIdentity(next: Identity): void {
  serverState.identity = next;
  networkState.sessionReady = true;
  localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  requestStateSync();
  render();
}

function readSession(): Identity | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

function clearSession(): void {
  commands.cancel();
  networkState.pendingActions.clear();
  networkState.stateSyncGeneration++;
  networkState.syncInFlight = false;
  serverState.clear();
  uiState.pendingTeamDraftKey = "";
  uiState.pendingQuestIndex = 0;
  localStorage.removeItem(SESSION_KEY);
}

function reconcilePendingTeam(state: PublicRoomState): void {
  const draftKey = `${state.roomCode}:${state.phaseId}:${state.phase}:${state.questIndex}:${state.leaderId ?? ""}`;
  const isMyTeamDraft = state.phase === "team" && state.leaderId === serverState.identity?.playerId;

  if (!isMyTeamDraft || draftKey !== uiState.pendingTeamDraftKey) {
    uiState.pendingTeam = new Set(state.proposal);
    uiState.pendingQuestIndex = state.questIndex;
    uiState.pendingTeamDraftKey = draftKey;
    return;
  }

  const validPlayerIds = new Set(state.players.filter((player) => player.connected).map((player) => player.id));
  uiState.pendingTeam = new Set([...uiState.pendingTeam].filter((playerId) => validPlayerIds.has(playerId)).slice(0, getTeamSizeForDisplay(uiState.pendingQuestIndex)));
}

function showToast(message: string, type: "info" | "success" | "error" = "info"): void {
  document.querySelector(".toast")?.remove();
  if (uiState.toastTimer !== null) {
    window.clearTimeout(uiState.toastTimer);
    uiState.toastTimer = null;
  }

  const icons = { info: "info", success: "check", error: "alert" };
  const titles = { info: "房间提示", success: "操作完成", error: "操作未完成" };
  const toastElement = document.createElement("div");
  toastElement.className = `toast toast-${type}`;
  toastElement.setAttribute("role", "alert");
  toastElement.innerHTML = `
    <span class="toast-icon">${icon(icons[type], 22)}</span>
    <div class="toast-copy"><strong>${titles[type]}</strong><span class="toast-message">${escapeHtml(message)}</span></div>
    <button class="toast-close icon-btn" type="button" title="关闭提示" aria-label="关闭提示">${icon("close")}</button>
  `;

  const closeToast = () => {
    toastElement.remove();
    if (uiState.toastTimer !== null) {
      window.clearTimeout(uiState.toastTimer);
      uiState.toastTimer = null;
    }
  };

  toastElement.querySelector(".toast-close")?.addEventListener("click", closeToast);
  document.body.appendChild(toastElement);
  uiState.toastTimer = window.setTimeout(closeToast, 6000);
}

function readInput(selector: string): string {
  return app!.querySelector<HTMLInputElement>(selector)?.value.trim() ?? "";
}

function requireInput(selector: string, message: string): string {
  const input = app!.querySelector<HTMLInputElement>(selector);
  const value = input?.value.trim() ?? "";
  if (!value) {
    showToast(message);
    input?.focus();
  }
  return value;
}

function readNumberInput(selector: string, fallback: number): number {
  const value = app!.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value;
  const parsed = value ? parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
function getTeamSizeForDisplay(index: number): number {
  const state = serverState.publicState;
  const count = state ? getTargetPlayerCount(state) : 5;
  return getTeamSize(count, index);
}

function maybeShowGameResult(state: PublicRoomState): void {
  if (state.recovery || state.phase !== "result" || !state.winner) return;

  const resultKey = `${state.roomCode}:${state.winner}:${state.winnerReason}`;
  if (resultKey === uiState.lastGameResultKey) return;

  uiState.lastGameResultKey = resultKey;

  document.querySelector(".game-result-overlay")?.remove();
  const overlay = document.createElement("div");
  const isGoodWin = state.winner === "good";
  overlay.className = `game-result-overlay ${isGoodWin ? "good-victory" : "evil-victory"}`;
  overlay.innerHTML = `
    <div class="game-result-card">
      <button class="modal-close" aria-label="关闭对局结果">${icon("close")}</button>
      <div class="game-result-ring"></div>
      <div class="game-result-crown">${icon(isGoodWin ? "crown" : "swords", 40)}</div>
      <div class="game-result-title">${FACTION_NAMES[isGoodWin ? "good" : "evil"]}胜利</div>
      <div class="game-result-subtitle">${escapeHtml(formatWinnerReason(state.winnerReason, state.winnerDetails))}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector(".modal-close")?.addEventListener("click", () => overlay.remove());
  window.setTimeout(() => overlay.classList.add("leaving"), 3500);
  window.setTimeout(() => overlay.remove(), 4200);
}

function getShareLinks(): Array<{ label: string; url: string }> {
  const state = serverState.publicState!;
  const roomParam = `?room=${encodeURIComponent(state.roomCode)}`;
  const currentOrigin = window.location.origin || "http://localhost:3000";
  const currentUrl = `${currentOrigin}${roomParam}`;
  const localhostUrl = state.localUrls.find((url) => url.includes("localhost")) ?? `http://localhost:3000${roomParam}`;
  const lanUrl = state.localUrls.find((url) => !url.includes("localhost")) ?? currentUrl;

  return [
    { label: "本机链接", url: localhostUrl },
    { label: "当前链接", url: currentUrl },
    { label: "局域网链接", url: lanUrl },
  ];
}
