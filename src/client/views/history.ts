import type { PublicRoomState, QuestHistoryEntry } from "../../shared/game";
import { icon } from "../icons";
import { seatPortraitMarkup } from "../portraits";
import { getCompletedQuestDetails } from "../questDetails";
import { escapeHtml } from "../viewHelpers";
import type { GameViewContext } from "./context";

export function renderHistoryPanel(context: GameViewContext): string {
  const { publicState, expandedVoteRecords } = context;
  
  

  const state = publicState!;
  const entries = state.history.slice(-8).reverse();

  return `
    <section class="history-panel">
      <div class="history-title">
        <span class="history-icon">${icon("rules")}</span>
        <span>对局记录</span>
      </div>
      <div class="history-list">
        ${entries.length ? entries.map((entry, index) => {
          const teamNames = entry.team
            .map((id) => state.players.find((player) => player.id === id)?.name ?? "?")
            .join("、");

          if (entry.type === "vote") {
            const approvals = entry.approvals ?? 0;
            const rejections = entry.rejections ?? 0;
            const total = approvals + rejections;
            const approvalRate = total > 0 ? Math.round((approvals / total) * 100) : 0;
            const voteDataAttr = entry.voteDetails ? `data-vote-details='${JSON.stringify(entry.voteDetails)}'` : "";
            const isPassed = entry.result === "success";
            const voteIcon = isPassed ? "✓" : "×";
            const voteTitle = entry.forced ? "强制发车" : isPassed ? "提案通过" : "提案被否决";
            const voteClass = isPassed ? "vote-approved" : "vote-rejected";
            const recordId = String(state.history.length - 1 - index);

            return `
              <div class="history-entry ${voteClass}" data-render-key="history:${state.history.length - 1 - index}">
                <div class="history-entry-header">
                  <span class="history-entry-icon">${voteIcon}</span>
                  <div class="history-entry-title">任务 ${entry.quest} - ${voteTitle}</div>
                </div>
                <div class="history-entry-body">
                  <div class="history-team-info">
                    <span class="history-label">队伍</span>
                    <span class="history-value">${escapeHtml(teamNames)}</span>
                  </div>
                  ${entry.forced ? `<p class="history-fails">第 ${state.players.length} 次提案，免表决</p>` : `<div class="history-vote-result" ${voteDataAttr} aria-label="赞成 ${approvals} 票，反对 ${rejections} 票">
                    <div class="history-vote-summary"><span class="vote-count approve">${icon("check", 13)}赞成 <strong>${approvals}</strong></span><span class="vote-count reject ${rejections === 0 ? "empty" : ""}">${icon("close", 13)}反对 <strong>${rejections}</strong></span></div>
                    <div class="history-vote-bar" aria-hidden="true"><div class="vote-approve" style="width: ${approvalRate}%"></div><div class="vote-reject" style="width: ${total > 0 ? 100 - approvalRate : 0}%"></div></div>
                  </div>`}
                  ${!entry.forced && entry.voteDetails?.length ? `<details class="history-vote-details" data-vote-record="${recordId}" ${expandedVoteRecords.has(recordId) ? "open" : ""}><summary>投票明细 ${icon("chevron", 12)}</summary>${renderVoteDetails(entry, state)}</details>` : ""}
                </div>
              </div>
            `;
          }

          const isSuccess = entry.result === "success";
          const failCount = entry.fails ?? 0;
          return `
            <div class="history-entry ${isSuccess ? "mission-success" : "mission-fail"}" data-render-key="history:${state.history.length - 1 - index}">
              <div class="history-entry-header">
                <span class="history-entry-icon">${isSuccess ? "✓" : "✕"}</span>
                <div class="history-entry-title">任务 ${entry.quest} - ${isSuccess ? "成功" : "失败"}</div>
              </div>
              <div class="history-entry-body">
                <div class="history-team-info">
                  <span class="history-label">队伍</span>
                  <span class="history-value">${escapeHtml(teamNames)}</span>
                </div>
                <div class="history-fails">${failCount} 张失败票</div>
              </div>
            </div>
          `;
        }).join("") : `<div class="history-empty">暂无记录</div>`}
      </div>
    </section>
  `;
}

export function renderVoteDetails(entry: QuestHistoryEntry, state: PublicRoomState): string {
  if (entry.forced || !entry.voteDetails?.length) return "";
  const votes = entry.voteDetails.map(vote => ({
    ...vote, player: state.players.find(player => player.id === vote.playerId),
  })).sort((a, b) => (a.player?.position ?? 99) - (b.player?.position ?? 99));
  const leader = state.players.find(player => player.id === entry.leader);
  return `<div class="vote-details" aria-label="队伍表决明细">${[true, false].map(approved => {
    const group = votes.filter(vote => vote.approved === approved);
    return `<section class="vote-group ${approved ? "approve" : "reject"}" aria-label="${approved ? "赞成名单" : "反对名单"}"><h3>${icon(approved ? "check" : "close", 14)}${approved ? "赞成" : "反对"}</h3><ul>${group.length ? group.map(vote => `<li class="vote-voter" title="${escapeHtml(vote.player?.name ?? "离场玩家")}"><span class="vote-avatar">${seatPortraitMarkup(vote.player?.position ?? 0, "avatar-art")}</span><span class="vote-voter-name">${escapeHtml(vote.player?.name ?? "离场玩家")}</span></li>`).join("") : '<li class="vote-none">无</li>'}</ul></section>`;
  }).join("")}${leader ? `<p class="vote-leader-exempt">队长 ${escapeHtml(leader.name)} · 自动赞成</p>` : ""}</div>`;
}

export function renderQuestDetailModal(context: GameViewContext, questIndex: number): string {
  const { publicState } = context;

  const state = publicState!;
  const details = getCompletedQuestDetails(state, questIndex);
  if (!details) return "";
  const { mission, proposal } = details;
  const leader = state.players.find(player => player.id === mission.leader);
  const fails = mission.fails ?? 0;
  return `<div class="modal-overlay" data-action="close-modal"><section class="modal-content quest-detail-modal" data-modal-panel>
    <div class="modal-header"><h2>任务 ${mission.quest} 详情</h2><button class="modal-close" data-action="close-modal" aria-label="关闭">${icon("close")}</button></div>
    <div class="modal-body">
      <div class="quest-detail-heading ${mission.result}">${icon(mission.result === "success" ? "shield" : "shieldX", 28)}<strong>任务${mission.result === "success" ? "成功" : "失败"}</strong><span>${mission.team.length} 人执行</span></div>
      <section class="quest-detail-section"><h3>发车队长</h3><div class="quest-detail-leader">${seatPortraitMarkup(leader?.position ?? 0, "quest-detail-art")}<strong>${escapeHtml(leader?.name ?? "离场玩家")}</strong></div></section>
      <section class="quest-detail-section"><h3>上车队员</h3><ul class="quest-detail-members">${mission.team.map(id => {
        const player = state.players.find(candidate => candidate.id === id);
        return `<li>${seatPortraitMarkup(player?.position ?? 0, "quest-detail-art")}<span>${escapeHtml(player?.name ?? "离场玩家")}</span></li>`;
      }).join("")}</ul></section>
      <section class="quest-detail-section"><h3>发车表决</h3>${!proposal ? '<p class="quest-detail-note">发车记录缺失</p>' : proposal.forced ? '<p class="quest-detail-note">强制发车 · 本次免表决</p>' : `<div class="quest-detail-votes"><span class="good-text">${icon("check", 16)}赞成 <strong>${proposal.approvals ?? 0}</strong> 票</span><span class="evil-text">${icon("close", 16)}反对 <strong>${proposal.rejections ?? 0}</strong> 票</span></div>${renderVoteDetails(proposal, state)}`}</section>
      <section class="quest-detail-section"><h3>任务牌结果</h3><div class="quest-detail-votes"><span class="good-text">成功牌 <strong>${mission.team.length - fails}</strong> 张</span><span class="evil-text">失败牌 <strong>${fails}</strong> 张</span></div></section>
    </div>
  </section></div>`;
}
