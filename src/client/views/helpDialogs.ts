import { FACTION_NAMES, getProposalRejectionThreshold, getRequiredSuccesses } from "../../shared/game";
import { icon } from "../icons";
import { portraitMarkup } from "../portraits";
import { getAllRoles, getRulesByPlayerCount, normalizeRoleName } from "../roleCatalog";
import { formatRoleName, formatRoleText } from "../roleLabels";

export function renderRulesModal(rulesPlayerCount: number): string {
  const rules = getRulesByPlayerCount(rulesPlayerCount);

  return `
    <div class="modal-overlay" data-action="close-modal">
      <div class="modal-content" data-modal-panel>
        <div class="modal-header">
          <h2>游戏规则</h2>
          <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="player-count-selector">
            <label>选择人数：</label>
            <select id="rulePlayerCount">
              ${[5, 6, 7, 8, 9, 10].map(n => `
                <option value="${n}" ${n === rulesPlayerCount ? "selected" : ""}>${n} 人</option>
              `).join("")}
            </select>
          </div>

          <div class="rules-content">
            <h3>游戏概述</h3>
            <p>阿瓦隆是一款隐藏身份的社交推理游戏。玩家分为<span class="good-text">${FACTION_NAMES.good}</span>和<span class="evil-text">${FACTION_NAMES.evil}</span>两个阵营，围绕5个任务进行投票和执行，队长可选择任意未完成的任务。</p>

            <h3>${rulesPlayerCount} 人配置</h3>
            <div class="config-box">
              <div class="config-item">
                <span class="label">${FACTION_NAMES.good}：</span>
                <span class="value good-text">${rules.good} 人</span>
              </div>
              <div class="config-item">
                <span class="label">${FACTION_NAMES.evil}：</span>
                <span class="value evil-text">${rules.evil} 人</span>
              </div>
            </div>

            <h3>角色配置</h3>
            <div class="roles-config">
              ${rules.roles.map((role: string, index: number) => `
                <button class="role-tag clickable ${rules.roleDetails[index]?.side ?? "good"}" data-role="${role}">
                  ${formatRoleText(role)}
                </button>
              `).join("")}
            </div>

            <h3>任务配置</h3>
            <table class="quest-table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>队伍人数</th>
                  <th>成功牌数量</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                ${rules.quests.map((q, i) => `
                  <tr>
                    <td>任务 ${i + 1}</td>
                    <td>${q.teamSize} 人</td>
                    <td>${getRequiredSuccesses(rulesPlayerCount, i)} 张成功牌</td>
                    <td>${q.failsNeeded === 2 ? '<span class="highlight">至少2张反对（失败）任务牌才失败，1张反对仍成功</span>' : '1张反对（失败）任务牌即失败'}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>

            <h3>游戏流程</h3>
            <ol class="game-flow">
              <li><strong>组建队伍：</strong>开局随机分配首位队长，30秒内选择未完成的任务和对应人数的队员，超时直接换下一位队长，之后顺时针轮换</li>
              <li><strong>投票表决：</strong>队长自动投赞成票，其他玩家可投赞成或反对；本局至少 ${getProposalRejectionThreshold(rulesPlayerCount)} 票反对才发车失败，失败展示后直接由下一位队长组队</li>
              <li><strong>执行任务：</strong>队伍通过后，队员秘密提交任务卡（成功或失败）</li>
              <li><strong>结算：</strong>公开任务结果，根据失败牌数量判定任务成败</li>
              <li><strong>轮流发言：</strong>未累计3次任务成功或失败时，任务结果展示后进入全员发言，结束后由下一位队长组队</li>
              <li><strong>刺杀阶段：</strong>${formatRoleText("累计3次任务成功后，结果展示结束即进入藏锋者的刺杀阶段，不再轮流发言。所有藏锋者亮明身份，获得2分钟讨论与选择目标的时间；由刺客提交目标，命中梅林则藏锋者翻盘，否则守誓者获胜；超时未提交视为放弃。刺客可在本阶段的讨论时间内提前提交，但不能在此前的游戏过程中刺杀")}</li>
            </ol>

            <h3>胜利条件</h3>
            <ul class="victory-conditions">
              <li class="good-text"><strong>${FACTION_NAMES.good}胜利：</strong>
                <div>• ${formatRoleText("累计3次任务成功，并在刺杀阶段保住梅林")}</div>
              </li>
              <li class="evil-text"><strong>${FACTION_NAMES.evil}胜利：</strong>
                <div>• 任务失败 3 次</div>
                <div>• ${formatRoleText("成功刺杀梅林")}</div>
              </li>
            </ul>

            <h3>重要规则</h3>
            <ul class="important-rules">
              <li>队伍表决中，队长自动赞成且不可修改，其他正反双方玩家均可赞成或反对；反对票严格超过本局实际人数的一半才否决，平票通过</li>
              <li>队伍表决与任务提交均有30秒倒计时，全员提前提交即判定；未投票默认赞成，未交任务卡默认成功</li>
              <li><strong>终局流程：</strong>累计3次任务失败，结果展示后藏锋者获胜；累计3次任务成功，结果展示后进入刺杀阶段，由藏锋者在2分钟内讨论，再由『刺客』选择目标并提交。达到上述任一条件后，不再进入全员发言阶段</li>
              <li><strong>发言顺序：</strong>普通任务结果展示后，从下一位队长的顺时针下一位开始，按顺时针逐人发言，下一位队长最后发言。真人每人1分钟，可提前结束；AI按顺序短暂发言后自动结束。例如座次为 A、B、C、D、E，A 本轮发车，下一位队长为 B，则发言顺序为 C、D、E、A、B。发车被否决后不发言，直接换下一位队长组队</li>
              <li>本局 ${rulesPlayerCount} 人，连续否决 ${rulesPlayerCount - 1} 次后，第 ${rulesPlayerCount} 次合法队伍提案直接发车，不再表决</li>
              <li>${FACTION_NAMES.good}在任务中只能打出成功牌</li>
              <li>${FACTION_NAMES.evil}可以选择打出成功牌或失败牌</li>
              <li>投票是公开的，但任务卡是秘密提交的</li>
              <li>${formatRoleText("只有进入刺杀阶段后，刺客才可选择并提交刺杀目标；此前不能提前刺杀")}</li>
              <li>${formatRoleText("梅林被刺杀时，游戏立即结束，反方获胜")}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderGalleryModal(gallerySide: string): string {
  const roles = getAllRoles();
  const sides = (["good", "evil"] as const).filter(side => gallerySide === "all" || side === gallerySide);

  return `
    <div class="modal-overlay" data-action="close-modal">
      <div class="modal-content modal-wide" data-modal-panel>
        <div class="modal-header">
          <h2>角色收藏馆</h2>
          <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="gallery-tabs" role="tablist" aria-label="阵营筛选">${[["all", "全部"], ["good", FACTION_NAMES.good], ["evil", FACTION_NAMES.evil]].map(([value, label]) => `<button role="tab" aria-selected="${gallerySide === value}" data-gallery-side="${value}">${label}</button>`).join("")}</div>
          ${sides.map(side => `<section class="gallery-group" aria-label="${FACTION_NAMES[side]}角色">
            <h3 class="gallery-group-heading ${side}-text">${FACTION_NAMES[side]}</h3>
            <div class="gallery-grid">
            ${roles.filter(role => role.side === side).map(role => `
              <button class="role-card-gallery ${role.side}" data-role="${role.name}">
                ${portraitMarkup(role.portraitCell, "gallery-art")}
                <div class="role-card-header">
                  <div class="role-title">
                    <h3>${formatRoleName(role.name)}</h3>
                    <p class="role-name-en">${formatRoleName(role.nameEn)}</p>
                    <span class="role-badge ${role.side}">${FACTION_NAMES[role.side]}</span>
                  </div>
                </div>
                <div class="role-card-body">
                  <p class="role-short-desc">${formatRoleText(role.shortDesc)}</p>
                </div>
              </button>
            `).join("")}
            </div>
          </section>`).join("")}
        </div>
      </div>
    </div>
  `;
}

export function renderRoleDetailModal(roleName: string): string {
  const normalizedRoleName = normalizeRoleName(roleName);
  const role = getAllRoles().find(r => r.name === normalizedRoleName);
  if (!role) return "";

  return `
    <div class="modal-overlay" data-action="close-modal">
      <div class="modal-content" data-modal-panel>
        <div class="modal-header">
          <h2>${formatRoleName(role.name)}</h2>
          <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="role-card-gallery role-detail-card ${role.side}">
            ${portraitMarkup(role.portraitCell, "detail-art")}
            <div class="role-card-header">
              <div class="role-title">
                <h3>${formatRoleName(role.name)}</h3>
                <p class="role-name-en">${formatRoleName(role.nameEn)}</p>
                <span class="role-badge ${role.side}">${FACTION_NAMES[role.side]}</span>
              </div>
            </div>
            <div class="role-card-body">
              <p class="role-short-desc">${formatRoleText(role.shortDesc)}</p>
              <h4>角色能力</h4>
              <ul class="role-abilities">
                ${role.abilities.map(ability => `<li>${formatRoleText(ability)}</li>`).join("")}
              </ul>
              ${role.tips ? `
                <div class="role-tips">
                  <strong>游戏提示</strong>
                  <p>${formatRoleText(role.tips)}</p>
                </div>
              ` : ""}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
