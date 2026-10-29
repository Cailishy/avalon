import { ALIGNMENT_COUNTS, FACTION_NAMES, ROLE_DEFS, getRoleCounts, type PublicRoomState } from "../../shared/game";
import { icon } from "../icons";
import { portraitMarkup, rolePortraitCell, seatPortraitMarkup } from "../portraits";
import { formatRoleKnowledge, formatRoleName, formatRoleText } from "../roleLabels";
import { escapeHtml, getTargetPlayerCount } from "../viewHelpers";
import type { GameViewContext } from "./context";

export function renderRoleConfiguration(context: GameViewContext, state: PublicRoomState): string {
  const { roleConfigurationExpanded } = context;
  
  

  const count = state.phase === "lobby" ? getTargetPlayerCount(state) : state.players.length;
  const roles = getRoleCounts(count);
  const sides = ALIGNMENT_COUNTS[count];
  const roleCard = (role: typeof roles[number], variant?: "male" | "female") => {
    const name = variant ? `亚瑟的忠臣（${variant === "male" ? "男性" : "女性"}）` : ROLE_DEFS[role.role].name;
    const number = variant ? state.servantCounts?.[variant] : role.count;
    const detailName = variant === "male" ? ROLE_DEFS.servant.name : name;
    return `<button class="role-configuration-card" data-role-count="${role.role}" ${variant ? `data-servant-variant="${variant}"` : ""} aria-label="${formatRoleName(name)} ${number === undefined ? "待分配" : `${number} 人`}，查看角色" data-role-detail="${detailName}" title="查看${formatRoleName(name)}角色卡">${portraitMarkup(rolePortraitCell(role.role, variant), "configuration-art")}<span class="configuration-role-name">${formatRoleName(name)}</span><strong>${number === undefined ? '<small>待分配</small>' : `${number}<small> 人</small>`}</strong></button>`;
  };
  return `<section class="role-configuration" aria-label="本局身份">
    <button class="role-configuration-toggle" data-action="toggle-role-configuration" aria-expanded="${roleConfigurationExpanded}" aria-controls="role-configuration-content">${icon("gallery", 16)}<span>本局身份</span><small>${count} 人局</small>${icon("chevron", 14)}</button>
    <div class="role-configuration-content ${roleConfigurationExpanded ? "expanded" : ""}" id="role-configuration-content">
      <div class="role-configuration-heading"><h2>本局身份</h2><small>${count} 人局 · ${roles.length} 种身份</small></div>
      <div class="role-configuration-groups">${(["good", "evil"] as const).map(side => `<section class="role-configuration-side" aria-label="${FACTION_NAMES[side]}身份配置">
        <h3 class="${side}-text">${FACTION_NAMES[side]}<span>${sides[side]} 人</span></h3>
        <div class="role-configuration-list">${roles.filter(item => ROLE_DEFS[item.role].side === side).map(item => item.role === "servant" ? roleCard(item, "male") + roleCard(item, "female") : roleCard(item)).join("")}</div>
      </section>`).join("")}</div>
    </div>
  </section>`;
}

export function renderRolePanel(context: GameViewContext): string {
  const { publicState, privateState, hidePrivateRole } = context;
  
  

  const priv = privateState;

  if (!priv || !priv.role) {
    return `
      <section class="role-panel lobby-info">
        <h2>圆桌会议</h2>
        <div class="lobby-emblem">${icon("shield", 64)}</div>
        <h3>等待入席</h3>
        <dl><div><dt>房间代码</dt><dd>${escapeHtml(publicState?.roomCode)}</dd></div><div><dt>本局人数</dt><dd>${publicState?.targetPlayerCount} 人</dd></div></dl>
        <button class="btn btn-secondary" data-action="show-share">${icon("share")} 邀请好友</button>
      </section>
    `;
  }

  const sideClass = priv.side === "good" ? "good" : priv.side === "evil" ? "evil" : "";

  return `
    <div class="role-panel">
      <div class="section-heading"><h2>我的身份</h2><button class="icon-btn" data-action="toggle-private" title="${hidePrivateRole ? "显示身份" : "隐藏身份"}" aria-label="${hidePrivateRole ? "显示身份" : "隐藏身份"}">${icon(hidePrivateRole ? "hidden" : "eye")}</button></div>
      ${hidePrivateRole ? `<div class="private-hidden">${icon("shield", 54)}<p>身份已隐藏</p></div>` : `
      <div class="role-card-display ${sideClass} role-card-clickable" data-action="show-own-role" role="button" tabindex="0" title="查看角色卡" aria-label="查看角色卡">
        ${portraitMarkup(rolePortraitCell(priv.role, priv.servantVariant), "role-art")}
        <div class="role-name">${escapeHtml(formatRoleName(priv.roleName))}</div>
        <span class="role-badge ${sideClass}">${FACTION_NAMES[priv.side ?? "good"]}</span>
        <div class="role-description">${escapeHtml(formatRoleText(priv.roleText))}</div>
      </div>
      ${priv.knowledge ? `<section class="role-knowledge"><h3>私密信息</h3><p>${escapeHtml(formatRoleKnowledge(priv.knowledge))}</p></section>` : ""}`}
    </div>
  `;
}

export function renderLobbyRoster(context: GameViewContext, myId: string): string {
  const { publicState } = context;

  const state = publicState!;
  return `<section class="lobby-roster"><h2>玩家列表 <small>${state.players.length} / ${state.targetPlayerCount}</small></h2>
    ${state.players.map(p => `<div class="roster-row">${seatPortraitMarkup(p.position, "roster-art")}<div><strong>${escapeHtml(p.name)}</strong><span>${!p.connected ? "离线" : p.isHost ? "房主" : p.ready ? "已准备" : "未准备"}</span></div>${state.hostId === myId && p.id !== myId ? `<button class="icon-btn" data-kick="${p.id}" title="移除 ${escapeHtml(p.name)}" aria-label="移除 ${escapeHtml(p.name)}">${icon("remove")}</button>` : ""}</div>`).join("")}
    </section>`;
}
