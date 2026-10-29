import { ALIGNMENT_COUNTS, FACTION_NAMES } from "../../shared/game";
import { icon } from "../icons";
import { escapeHtml } from "../viewHelpers";

export function renderSoloModal(soloPlayerCount: number): string {
  const sides = ALIGNMENT_COUNTS[soloPlayerCount];
  return `<div class="modal-overlay" data-action="close-modal"><section class="modal-content solo-modal" data-modal-panel>
    <div class="modal-header"><h2>单机对局</h2><button class="modal-close" data-action="close-modal" aria-label="关闭">${icon("close")}</button></div>
    <div class="modal-body"><div class="field"><label for="soloPlayerCount">本局人数</label><select id="soloPlayerCount">${[5, 6, 7, 8, 9, 10].map(count => `<option value="${count}" ${count === soloPlayerCount ? "selected" : ""}>${count} 人</option>`).join("")}</select></div>
      <dl class="solo-lineup"><div><dt>真人 / AI</dt><dd>1 / ${soloPlayerCount - 1}</dd></div><div><dt>${FACTION_NAMES.good} / ${FACTION_NAMES.evil}</dt><dd>${sides.good} / ${sides.evil}</dd></div></dl>
      <div class="confirm-actions"><button class="btn btn-secondary" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="solo-start">${icon("solo")} 开始对局</button></div>
    </div></section></div>`;
}

export function renderShareModal(roomCode: string, links: Array<{ label: string; url: string }>): string {


  return `
    <div class="modal-overlay" data-action="close-modal">
      <div class="modal-content share-modal" data-modal-panel>
        <div class="modal-header">
          <h2>邀请好友</h2>
          <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="share-room-code-card">
            <div class="share-room-label">房间代码</div>
            <div class="share-room-code-display">${escapeHtml(roomCode)}</div>
            <button class="btn btn-primary btn-copy-code" data-copy-code="${escapeHtml(roomCode)}">
              <span class="btn-icon">${icon("copy")}</span>
              <span>复制代码</span>
            </button>
          </div>
          <div class="share-divider">
            <span>或使用链接</span>
          </div>
          <div class="share-links">
            ${links.map((link) => `
              <button class="share-link" data-copy="${escapeHtml(link.url)}">
                <div class="share-link-header">
                  <span class="share-link-label">${escapeHtml(link.label)}</span>
                  <span class="share-link-icon">${icon("copy")}</span>
                </div>
                <div class="share-link-url">${escapeHtml(link.url)}</div>
              </button>
            `).join("")}
          </div>
          <p class="share-hint">局域网联机需连接同一 Wi-Fi。</p>
        </div>
      </div>
    </div>
  `;
}

export function renderDissolveConfirmModal(): string {
  return `
    <div class="modal-overlay" data-action="dissolve-cancel">
      <div class="modal-content confirm-modal" data-modal-panel>
        <div class="modal-header">
          <h2>解散房间</h2>
          <button class="modal-close" data-action="dissolve-cancel" aria-label="关闭">${icon("close")}</button>
        </div>
        <div class="modal-body confirm-body">
          <p>确定要解散当前房间吗？所有玩家都会收到通知并返回首页。</p>
          <div class="confirm-actions">
            <button class="btn btn-secondary" data-action="dissolve-cancel">取消</button>
            <button class="btn btn-danger" data-action="dissolve-confirm">确认解散</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderLeaveConfirmModal(roomCode: string): string {
  return `<div class="modal-overlay" data-action="leave-cancel"><section class="modal-content confirm-modal" role="dialog" aria-modal="true" aria-label="离开房间" data-modal-panel>
    <div class="modal-header"><h2>离开房间？</h2><button class="modal-close" data-action="leave-cancel" aria-label="关闭">${icon("close")}</button></div>
    <div class="modal-body"><p>房间 ${escapeHtml(roomCode)}</p><div class="confirm-actions"><button class="btn btn-secondary" data-action="leave-cancel">取消</button><button class="btn btn-danger" data-action="leave-confirm">${icon("leave")} 离开</button></div></div>
  </section></div>`;
}
