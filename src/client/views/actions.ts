import { FACTION_NAMES, getRequiredFails, getTeamSize, isForcedLaunch } from "../../shared/game";
import { icon } from "../icons";
import { portraitMarkup, rolePortraitCell, seatPortraitMarkup } from "../portraits";
import { formatRoleName, formatRoleText, formatWinnerReason } from "../roleLabels";
import { escapeHtml, getCompletedQuestIndexes, getTargetPlayerCount, getTimerRemainingMs } from "../viewHelpers";
import type { GameViewContext } from "./context";

export function renderActionPanel(context: GameViewContext, myId: string): string {
  const { publicState, privateState, pendingTeam, pendingQuestIndex, pendingAssassinTarget, pendingActions, serverConnected } = context;
  const getTeamSizeForDisplay = (index: number) => getTeamSize(getTargetPlayerCount(publicState), index);
  const getRequiredFailsForDisplay = (index: number) => getRequiredFails(getTargetPlayerCount(publicState), index);

  const state = publicState!;
  if (state.recovery) return `<section class="action-panel stage-wait" role="status"><span>对局恢复中</span><strong data-phase-countdown>${Math.ceil(getTimerRemainingMs(state.recovery.deadline) / 1000)} 秒</strong><p>${state.recovery.connected} / ${state.recovery.expected} 位玩家已恢复连接</p></section>`;
  const priv = privateState;
  const me = state.players.find((p) => p.id === myId)!;
  if (state.phase === "reveal" || state.phase === "proposalResult" || state.phase === "missionResult") return `<section class="action-panel stage-wait"><span>${state.phase === "reveal" ? "身份揭晓" : state.phase === "proposalResult" ? "下一阶段 · 下一位队长组队" : state.score.fail >= 3 ? "下一阶段 · 对局结算" : state.score.success >= 3 ? "下一阶段 · 藏锋者密议" : "下一阶段 · 轮流发言"}</span><strong data-phase-countdown>${Math.ceil(getTimerRemainingMs(state.timer?.deadline ?? Date.now()) / 1000)} 秒</strong></section>`;

  if (state.phase === "lobby") {
    const targetPlayerCount = getTargetPlayerCount(state);
    const readyTargetCount = Math.max(targetPlayerCount - 1, 0);
    const readyCount = state.players.filter((player) => !player.isHost && Boolean(player.ready)).length;
    const connectedCount = state.players.filter((player) => Boolean(player.connected)).length;
    const hasTargetPlayers = state.players.length === targetPlayerCount;
    const allConnected = connectedCount === state.players.length;
    const allReady = readyCount === readyTargetCount;
    const isLobbyBusy = !serverConnected;
    const canStart = me.isHost && hasTargetPlayers && allConnected && allReady && !isLobbyBusy;
    const startHint = !hasTargetPlayers
      ? `等待 ${Math.max(targetPlayerCount - state.players.length, 0)} 名玩家加入`
      : !allConnected
        ? `还有 ${state.players.length - connectedCount} 名玩家离线`
        : allReady
          ? "所有队员已准备"
          : `还有 ${readyTargetCount - readyCount} 名队员未准备`;
    return `
      <div class="action-panel">
        <div class="action-title">大厅</div>
        <div class="action-content">
          <div class="lobby-status">
            <div><span>玩家</span><strong>${state.players.length}/${targetPlayerCount}</strong></div>
            <div><span>在线</span><strong>${connectedCount}/${state.players.length}</strong></div>
            <div><span>准备</span><strong>${readyCount}/${readyTargetCount}</strong></div>
          </div>
          ${me.isHost ? `
            <label class="lobby-target-control">
              <span>本局人数</span>
              <select id="lobbyPlayerCount" ${isLobbyBusy ? "disabled" : ""}>
                ${[5, 6, 7, 8, 9, 10].map((count) => `
                  <option value="${count}" ${count === targetPlayerCount ? "selected" : ""} ${count < state.players.length ? "disabled" : ""}>
                    ${count} 人
                  </option>
                `).join("")}
              </select>
            </label>
          ` : `<p style="text-align: center; color: var(--parchment); opacity: 0.8;">本局目标人数：${targetPlayerCount} 人</p>`}
          ${me.isHost ? "" : `
            <button class="btn ${me.ready ? "btn-secondary" : "btn-primary"}" data-action="ready" ${isLobbyBusy ? "disabled" : ""}>
              ${me.ready ? "取消准备" : "准备"}
            </button>
          `}
          ${me.isHost ? `
            <p class="lobby-start-hint">${escapeHtml(startHint)}</p>
            <button class="btn btn-primary" data-action="start" ${canStart ? "" : "disabled"}>
              开始游戏
            </button>
            <button class="btn btn-danger" data-action="dissolve" ${isLobbyBusy ? "disabled" : ""}>
              解散房间
            </button>
          ` : `<p style="text-align: center; opacity: 0.7;">等待房主开始游戏...</p>`}
        </div>
      </div>
    `;
  }

  if (state.phase === "team") {
    if (priv?.canPropose && state.leaderId === myId) {
      const completedQuests = getCompletedQuestIndexes(state);
      const selectedQuest = completedQuests.has(pendingQuestIndex) ? state.questIndex : pendingQuestIndex;
      const selectedTeamSize = getTeamSizeForDisplay(selectedQuest);
      const questOptions = Array.from({ length: 5 }, (_, index) => {
        const disabled = completedQuests.has(index);
        const requiredFails = getRequiredFailsForDisplay(index);
        return `
          <button class="quest-choice ${index === selectedQuest ? "active" : ""}" data-quest-index="${index}" ${disabled ? "disabled" : ""}>
            <span>任务 ${index + 1}</span>
            <strong>${getTeamSizeForDisplay(index)} 人</strong>
            <em>${requiredFails} 失败</em>
          </button>
        `;
      }).join("");
      return `
        <div class="action-panel">
          <div class="action-title">选择队伍</div>
          <div class="action-content">
            <p class="launch-status">${isForcedLaunch(state.rejectCount, state.players.length) ? `已连续否决 ${state.rejectCount} 次，本次队伍提交后强制发车` : `第 ${state.rejectCount + 1} / ${state.players.length} 次提案`}</p>
            <div class="quest-choice-grid">
              ${questOptions}
            </div>
            <div class="team-candidates" role="group" aria-label="可选队员">${state.players.map(player => {
              const selected = pendingTeam.has(player.id);
              const disabled = !player.connected || (!selected && pendingTeam.size >= selectedTeamSize) || pendingActions.has("team:propose");
              return `<button class="team-candidate ${selected ? "selected" : ""}" data-team-player="${player.id}" aria-label="选择 ${escapeHtml(player.name)}" aria-pressed="${selected}" title="${escapeHtml(player.name)}${!player.connected ? " · 离线" : ""}" ${disabled ? "disabled" : ""}>
                <span class="candidate-avatar">${seatPortraitMarkup(player.position, "avatar-art")}</span><span class="candidate-name">${escapeHtml(player.name)}</span><span class="candidate-check" aria-hidden="true">${selected ? icon("check", 14) : ""}</span>
              </button>`;
            }).join("")}</div>
            <div class="draft-summary">
              <span>已选 ${pendingTeam.size} / ${selectedTeamSize} 人</span>
              <span class="selected-names">${[...pendingTeam].map(id => escapeHtml(state.players.find(p => p.id === id)?.name ?? "")).join("、")}</span>
            </div>
            <button class="btn btn-primary" data-action="propose" ${pendingTeam.size === selectedTeamSize ? "" : "disabled"}>
              ${isForcedLaunch(state.rejectCount, state.players.length) ? "确认发车" : "提交队伍"}
            </button>
          </div>
        </div>
      `;
    }
    return `
      <div class="action-panel">
        <div class="action-content">
          <p style="text-align: center; opacity: 0.8;">${isForcedLaunch(state.rejectCount, state.players.length) ? "本次强制发车，等待队长确认队伍" : "队长正在选择队伍..."}</p>
        </div>
      </div>
    `;
  }

  if (state.phase === "vote") {
    const teamNames = state.proposal.map(id => state.players.find(p => p.id === id)?.name ?? "?").join("、");
    const votedCount = state.voteSubmitted.length;
    const totalVoters = state.players.length;
    const voteProgress = totalVoters > 0 ? (votedCount / totalVoters) * 100 : 0;

    if (state.leaderId === myId) {
      return `
        <div class="action-panel">
          <div class="action-title">等待表决</div>
          <div class="action-content">
            <p style="text-align: center; color: var(--parchment); font-size: 0.9rem;">
              你已提交队伍：${escapeHtml(teamNames)}，已自动投赞成票
            </p>
            <div class="vote-progress-container">
              <div class="vote-progress-bar">
                <div class="vote-progress-fill" style="width: ${voteProgress}%"></div>
              </div>
              <div class="vote-progress-text">${votedCount} / ${totalVoters} 已投票</div>
            </div>
          </div>
        </div>
      `;
    }
    if (priv?.canVote) {
      return `
        <div class="action-panel">
          <div class="action-title">投票表决</div>
          <div class="action-content">
            <p style="text-align: center; color: var(--parchment); font-size: 0.9rem;">
              提议队伍：${escapeHtml(teamNames)}
            </p>
            <div class="vote-progress-container">
              <div class="vote-progress-bar">
                <div class="vote-progress-fill" style="width: ${voteProgress}%"></div>
              </div>
              <div class="vote-progress-text">${votedCount} / ${totalVoters} 已投票</div>
            </div>
            <div class="vote-buttons">
              <button class="btn btn-approve" data-action="vote-yes">
                <span class="btn-icon">${icon("check")}</span>
                <span>赞成</span>
              </button>
              <button class="btn btn-reject" data-action="vote-no">
                <span class="btn-icon">${icon("close")}</span>
                <span>反对</span>
              </button>
            </div>
          </div>
        </div>
      `;
    }
    return `
      <div class="action-panel">
        <div class="action-title">投票中</div>
        <div class="action-content">
          <div class="vote-progress-container">
            <div class="vote-progress-bar">
              <div class="vote-progress-fill" style="width: ${voteProgress}%"></div>
            </div>
            <div class="vote-progress-text">${votedCount} / ${totalVoters} 已投票</div>
          </div>
          <p style="text-align: center; opacity: 0.7; font-size: 0.85rem; margin-top: 0.5rem;">
            等待其他玩家投票...
          </p>
        </div>
      </div>
    `;
  }

  if (state.phase === "mission") {
    const missionProgress = state.proposal.length > 0 ? (state.missionSubmitted.length / state.proposal.length) * 100 : 0;

    if (priv?.canMission) {
      return `
        <div class="action-panel">
          <div class="action-title">执行任务</div>
          <div class="action-content">
            <p style="text-align: center; color: var(--gold-crown); font-size: 0.85rem;">
              选择你的行动
            </p>
            <div class="vote-progress-container">
              <div class="vote-progress-bar">
                <div class="vote-progress-fill mission-progress" style="width: ${missionProgress}%"></div>
              </div>
              <div class="vote-progress-text">${state.missionSubmitted.length} / ${state.proposal.length} 已提交</div>
            </div>
            <div class="mission-buttons">
              <button class="btn btn-approve" data-action="mission-success">
                <span class="btn-icon">${icon("check")}</span>
                <span>成功</span>
              </button>
              <button class="btn btn-reject" data-action="mission-fail" ${priv.canFailMission ? "" : "disabled"}>
                <span class="btn-icon">${icon("close")}</span>
                <span>失败</span>
              </button>
            </div>
          </div>
        </div>
      `;
    }
    return `
      <div class="action-panel">
        <div class="action-title">任务进行中</div>
        <div class="action-content">
          <div class="vote-progress-container">
            <div class="vote-progress-bar">
              <div class="vote-progress-fill mission-progress" style="width: ${missionProgress}%"></div>
            </div>
            <div class="vote-progress-text">${state.missionSubmitted.length} / ${state.proposal.length} 已提交</div>
          </div>
          <p style="text-align: center; opacity: 0.7; font-size: 0.85rem; margin-top: 0.5rem;">
            等待队员提交任务卡...
          </p>
        </div>
      </div>
    `;
  }

  if (state.phase === "speech") {
    const speaker = state.timer?.speakerId ? state.players.find((player) => player.id === state.timer?.speakerId) : null;
    const isMyTurn = speaker?.id === myId;
    const order = state.speechOrder ?? [];
    const currentIndex = order.indexOf(speaker?.id ?? "");
    const leaderName = state.players.find(player => player.id === state.leaderId)?.name ?? "玩家";
    return `
      <div class="action-panel">
        <div class="action-title">发言时间</div>
        <div class="action-content">
          <p style="text-align: center; color: var(--gold-bright); font-size: 1.2rem; margin-bottom: 0.75rem;">
            ${isMyTurn ? "轮到你发言" : `${escapeHtml(speaker?.name ?? "玩家")} 正在发言`}
          </p>
          <div class="speech-summary"><span>下一位队长 <strong>${escapeHtml(leaderName)}</strong></span><span>${currentIndex < 0 ? 0 : currentIndex + 1} / ${order.length}</span></div>
          <ol class="speech-roster" aria-label="发言顺序">${order.map((id, index) => {
            const player = state.players.find(p => p.id === id);
            if (!player) return "";
            return `<li class="speech-member ${id === speaker?.id ? "current" : index < currentIndex ? "finished" : ""}" title="${escapeHtml(player.name)}" ${id === speaker?.id ? 'aria-current="step"' : ""}>${seatPortraitMarkup(player.position, "speech-art")}<span>${escapeHtml(player.name)}</span><span aria-hidden="true">${id === state.leaderId ? icon("crown", 13) : index < currentIndex ? icon("check", 13) : ""}</span></li>`;
          }).join("")}</ol>
          ${isMyTurn ? `
            <button class="btn btn-secondary" data-action="end-speech" style="margin-top: 1rem;">
              结束发言
            </button>
          ` : ""}
        </div>
      </div>
    `;
  }

  if (state.phase === "assassin") {
    const disclosed = `<section class="assassin-disclosure" aria-label="藏锋者已亮明身份"><h2>藏锋者密议</h2><p class="assassin-discussion-label">讨论与刺杀 · 2 分钟</p><ul>${state.revealedRoles.filter(role => role.side === "evil").map(role => {
      const player = state.players.find(candidate => candidate.id === role.playerId);
      return `<li data-disclosed-player="${role.playerId}">${portraitMarkup(rolePortraitCell(role.role), "disclosed-art")}<div><strong>${escapeHtml(player?.name ?? "离场玩家")}</strong><span>${formatRoleName(role.roleName)}</span></div></li>`;
    }).join("")}</ul></section>`;
    if (priv?.canAssassinate) {
      return `
        ${disclosed}
        <div class="action-panel">
          <div class="action-title">刺杀</div>
          <div class="action-content">
            <p style="text-align: center; color: var(--mordred-red); font-size: 0.9rem;">
              ${formatRoleText("选择你认为是梅林的玩家")}
            </p>
            <p class="assassin-target">${pendingAssassinTarget ? `已选 ${escapeHtml(state.players.find(p => p.id === pendingAssassinTarget)?.name ?? "")}` : "尚未选择目标"}</p>
            <button class="btn btn-danger" data-action="assassinate" ${pendingAssassinTarget ? "" : "disabled"}>${icon("target")} 确认刺杀</button>
          </div>
        </div>
      `;
    }
    return `
      ${disclosed}
      <div class="action-panel">
        <div class="action-title">刺杀阶段</div>
        <div class="action-content">
          <p style="text-align: center; opacity: 0.8;">${formatRoleText("刺客正在选择...")}</p>
        </div>
      </div>
    `;
  }

  if (state.phase === "result") {
    const winnerText = `${FACTION_NAMES[state.winner ?? "evil"]}胜利`;
    return `
      <section class="action-panel game-settlement" aria-label="对局结算">
        <div class="action-content">
          <header class="settlement-heading ${state.winner ?? "evil"}">
            <span class="settlement-emblem" aria-hidden="true">${icon(state.winner === "good" ? "crown" : "swords", 30)}</span>
            <p class="settlement-kicker">游戏结束</p>
            <h2>${winnerText}</h2>
            <p class="settlement-reason">${escapeHtml(formatWinnerReason(state.winnerReason))}</p>
            <div class="result-score"><span>${state.score.success} 次成功</span><span>${state.score.fail} 次失败</span></div>
          </header>
          <div class="result-roster">${state.revealedRoles.map(r => `<div class="result-player">${portraitMarkup(rolePortraitCell(r.role, r.servantVariant), "roster-art")}<strong>${escapeHtml(state.players.find(p => p.id === r.playerId)?.name ?? "")}</strong><span>${escapeHtml(formatRoleName(r.roleName))}</span><span class="role-badge ${r.side}">${FACTION_NAMES[r.side]}</span></div>`).join("")}</div>
          ${me.isHost ? `
            <button class="btn btn-primary" data-action="restart" style="margin-top: 1.5rem;">
              重新开始
            </button>
          ` : ""}
        </div>
      </section>
    `;
  }

  return `<div class="action-panel"></div>`;
}
