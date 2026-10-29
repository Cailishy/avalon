import { FACTION_NAMES, getTeamSize, type PublicRoomState } from "../../shared/game";
import { icon } from "../icons";
import { seatPortraitMarkup } from "../portraits";
import { formatRoleName } from "../roleLabels";
import { escapeHtml, getTargetPlayerCount, getTimerRemainingMs } from "../viewHelpers";
import type { GameViewContext } from "./context";

import { renderVoteDetails } from "./history";

export function renderMissionOutcome(state: PublicRoomState): string {
  const entry = [...state.history].reverse().find(h => h.type === "mission");
  if (!entry) return "";
  const successful = entry.result === "success";
  const fails = entry.fails ?? 0;
  const successes = entry.team.length - fails;
  const teamNames = entry.team.map(id => escapeHtml(state.players.find(p => p.id === id)?.name ?? "")).join("、");
  return `<section class="round-table mission-outcome ${successful ? "outcome-success" : "outcome-fail"}" data-render-key="mission:${state.phaseId}" aria-label="任务结果">
    <div class="outcome-emblem">${icon(successful ? "shield" : "swords", 64)}</div>
    <p class="outcome-kicker">任务 ${entry.quest} · ${entry.team.length} 人执行</p>
    <h2>${successful ? "任务成功" : "任务失败"}</h2>
    <div class="outcome-cards" aria-label="任务牌汇总">${Array.from({ length: entry.team.length }, (_, i) => `<div class="outcome-card ${i < successes ? "success" : "fail"}" style="--card-order:${i}">${icon(i < successes ? "check" : "close", 28)}<span>${i < successes ? "成功" : "失败"}</span></div>`).join("")}</div>
    <p class="outcome-tally">${successes} 张成功牌 <span>·</span> ${fails} 张失败牌</p>
    <p class="outcome-team">${teamNames}</p>
    <div class="outcome-score"><span>成功 <strong>${state.score.success}</strong></span><span>失败 <strong>${state.score.fail}</strong></span></div>
    <div class="identity-progress outcome-progress"><div data-phase-progress style="width:100%"></div></div>
  </section>`;
}

export function renderProposalOutcome(state: PublicRoomState): string {
  const entry = state.history.at(-1);
  if (entry?.type !== "vote" || !entry.rejections) return "";
  const elapsed = state.timer ? Math.max(0, state.timer.durationMs - getTimerRemainingMs(state.timer.deadline)) : 0;
  return `<section class="round-table proposal-outcome" data-render-key="proposal:${state.phaseId}" aria-label="发车结果" style="--result-offset:-${elapsed}ms">
    <div class="proposal-seal">${icon("shieldX", 58)}</div>
    <p class="outcome-kicker">任务 ${entry.quest} · 第 ${state.rejectCount} / ${state.players.length} 次提案</p>
    <h2>发车失败</h2>
    <p class="proposal-caption">队伍提案被否决</p>
    <div class="proposal-team-list" aria-label="本次提议队员">${entry.team.map((id, index) => {
      const player = state.players.find(candidate => candidate.id === id);
      return `<div class="proposal-team-member" style="--member-order:${index}" title="${escapeHtml(player?.name ?? "玩家")}"><span class="proposal-avatar">${seatPortraitMarkup(player?.position ?? index, "avatar-art")}</span><span>${escapeHtml(player?.name ?? "玩家")}</span></div>`;
    }).join("")}</div>
    <div class="proposal-vote-counts"><span>${icon("check", 16)}赞成 <strong>${entry.approvals ?? 0}</strong></span><span>${icon("close", 16)}反对 <strong>${entry.rejections}</strong></span></div>
    ${renderVoteDetails(entry, state)}
    <div class="identity-progress outcome-progress"><div data-phase-progress style="width:100%"></div></div>
  </section>`;
}

export function renderRoundTable(context: GameViewContext, myId: string): string {
  const { publicState, privateState, pendingTeam, pendingQuestIndex, pendingAssassinTarget } = context;
  const state = publicState!;
  if (!state.recovery && state.phase === "missionResult") return renderMissionOutcome(state);
  if (!state.recovery && state.phase === "proposalResult") return renderProposalOutcome(state);
  const usesLocalTeamDraft = state.phase === "team" && state.leaderId === myId;
  const interactive = (usesLocalTeamDraft && !!privateState?.canPropose) || (state.phase === "assassin" && !!privateState?.canAssassinate);
  const selfIndex = state.players.findIndex((player) => player.id === myId);
  const ordered = [...state.players.slice(selfIndex), ...state.players.slice(0, selfIndex)];
  const count = state.phase === "lobby" ? Math.max(ordered.length, state.targetPlayerCount) : ordered.length;
  const phases = { lobby: "等待入席", reveal: "身份揭晓", team: "队长组队", vote: "队伍表决", proposalResult: "发车结果", mission: "执行任务", missionResult: "任务结果", speech: "轮流发言", assassin: "刺杀阶段", result: "对局结束" };
  const latestEntry = state.history.at(-1);
  const tableDetail = state.phase === "lobby" ? `${state.players.length} / ${state.targetPlayerCount} 人` :
    state.phase === "speech" ? latestEntry?.type === "mission" ? `任务 ${latestEntry.quest} 已完成` : "队伍提案被否决" :
    state.phase === "result" ? `${FACTION_NAMES[state.winner ?? "evil"]}获胜` :
    `任务 ${usesLocalTeamDraft ? pendingQuestIndex + 1 : state.questIndex + 1}`;
  const playerSeats = Array.from({ length: count }, (_, index) => {
    const player = ordered[index];
    if (!player) return `<div class="player-seat empty-seat" aria-label="空座位"><div class="empty-seat-symbol">${icon("user", 22)}</div><span>等待入席</span></div>`;
    const isLeader = player.id === state.leaderId;
    const isSpeaking = state.phase === "speech" && state.timer?.speakerId === player.id;
    const isSelected = state.phase === "assassin" ? pendingAssassinTarget === player.id : usesLocalTeamDraft ? pendingTeam.has(player.id) : state.proposal.includes(player.id);
    const isReady = state.phase === "lobby" && player.ready;
    const revealed = state.revealedRoles.find((r) => r.playerId === player.id);
    const canSelect = interactive && (state.phase !== "assassin" || player.id !== myId && !revealed);
    const sideClass = revealed ? (revealed.side === "good" ? "side-good" : "side-evil") : "";
    const status = !player.connected ? "离线" : revealed ? formatRoleName(revealed.roleName) : (isSpeaking ? "发言中" :
      state.phase === "lobby" ? (player.isHost ? "房主" : isReady ? "已准备" : "未准备") :
      state.phase === "mission" && state.missionSubmitted.includes(player.id) ? "已行动" :
      state.phase === "vote" && state.voteSubmitted.includes(player.id) ? "已投票" : isSelected ? "任务队员" : isLeader ? "队长" : "在场");
    return `
      <div class="player-seat" data-render-key="seat:${player.id}" data-player-id="${player.id}">
        <div class="player-card ${sideClass} ${player.id === myId ? "is-self" : ""} ${isLeader ? "leader" : ""} ${isSpeaking ? "speaking" : ""} ${isSelected ? "selected" : ""} ${isReady ? "ready" : ""} ${!player.connected ? "offline" : ""}"
             data-player-id="${player.id}" ${canSelect ? `role="button" tabindex="0" aria-pressed="${isSelected}"` : ""} title="${escapeHtml(player.name)} · ${escapeHtml(status)}">
          <div class="seat-heading">${player.id === myId ? '<span class="seat-self">你</span>' : ""}${isLeader ? `<span class="seat-crown" title="${state.phase === "speech" ? "下一位队长" : "本轮队长"}">${icon("crown", 15)}</span>` : player.isHost && state.phase !== "lobby" ? '<span class="seat-host">房主</span>' : ""}</div>
          <div class="player-avatar">${seatPortraitMarkup(player.position, "avatar-art")}${isSelected ? `<span class="seat-selected">${icon(state.phase === "assassin" ? "target" : "check", 13)}</span>` : ""}</div>
          <div class="player-name">${escapeHtml(player.name)}</div>
          <div class="player-status">${escapeHtml(status)}</div>
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="round-table" data-render-key="round-table" aria-label="圆桌座位">
      <div class="table-surface" data-player-count="${count}">
        <div class="table-center">
          <div class="table-phase">${state.recovery ? "等待重连" : phases[state.phase]}</div>
          <div class="table-detail">${tableDetail}</div>
          <div class="score">
            <div class="good" title="成功任务">成 <strong>${state.score.success}</strong></div>
            <div class="evil" title="失败任务">败 <strong>${state.score.fail}</strong></div>
          </div>
        </div>
        <div class="players-circle">
          ${playerSeats}
        </div>
      </div>
    </div>
  `;
}

export function renderQuestTrack(context: GameViewContext): string {
  const { publicState, identity, pendingQuestIndex } = context;
  const getTeamSizeForDisplay = (index: number) => getTeamSize(getTargetPlayerCount(publicState), index);

  const state = publicState!;
  const isLeaderDrafting = state.phase === "team" && state.leaderId === identity?.playerId;
  const highlightedQuestIndex = isLeaderDrafting ? pendingQuestIndex : state.questIndex;

  const markers = Array.from({ length: 5 }, (_, i) => {
    const history = state.history.find((h) => h.type === "mission" && h.quest === i + 1);
    const teamSize = getTeamSizeForDisplay(i);
    const isCurrent = state.phase !== "lobby" && highlightedQuestIndex === i && !history;
    const status = history ? history.result === "success" ? "成功" : "失败" : isCurrent ? state.phase === "mission" ? "执行中" : state.phase === "vote" ? "表决中" : state.phase === "proposalResult" ? "待重选" : "待发车" : "待选";
    const statusIcon = history ? history.result === "success" ? "check" : "close" : "flag";

    return `
      <${history ? "button" : "div"} class="quest-marker ${history ? history.result : isCurrent ? "current" : "pending"}" aria-label="任务${i + 1}，${teamSize}人，${status}${history ? "，查看详情" : ""}" ${isCurrent ? 'aria-current="step"' : ""} ${history ? `type="button" data-quest-detail="${i}" aria-haspopup="dialog"` : ""}>
        <span class="quest-index">任务 ${i + 1}</span>
        <div class="quest-status">${icon(statusIcon, 20)}</div>
        <strong class="quest-state">${status}</strong>
        <span class="quest-team">${icon("user", 11)}${teamSize} 人</span>
      </${history ? "button" : "div"}>
    `;
  }).join("");

  return `
    <div class="quest-track" data-render-key="quests">
      ${markers}
    </div>
  `;
}
