import { icon } from "../icons";
import { escapeHtml } from "../viewHelpers";

interface EntryView {
  landingMode: "create" | "join";
  landingDraft: {name: string; roomCode: string; count: string};
  hasPreviousSession: boolean;
  soundControls: string;
  dialogs: {rules: string; gallery: string; detail: string; solo: string; share: string; dissolve: string};
}

export function renderEntry(options: EntryView): string {
  const {landingMode,landingDraft,hasPreviousSession,soundControls,dialogs} = options;
  return `
    <div class="landing">
      <header class="entry-header"><strong>阿瓦隆</strong>${soundControls}</header>
      <div class="landing-container">
        <div class="title-section">
          <div class="crown-decoration">${icon("crown", 30)}</div>
          <h1>阿瓦隆</h1>
        </div>
        <div class="entry-tabs" role="tablist" aria-label="进入游戏">
          <button role="tab" aria-selected="${landingMode === "create"}" data-entry-mode="create">创建房间</button>
          <button role="tab" aria-selected="${landingMode === "join"}" data-entry-mode="join">加入房间</button>
        </div>
        <div class="landing-cards-symmetric">
          <div class="landing-card card-create" ${landingMode === "create" ? "" : "hidden"}>
            <div class="field">
              <label for="nameInput">你的名字</label>
              <input id="nameInput" value="${escapeHtml(landingDraft.name)}" maxlength="16" placeholder="输入你的名字" autocomplete="nickname" />
            </div>
            <div class="field">
              <label for="createPlayerCount">本局人数</label>
              <select id="createPlayerCount">
                ${[5, 6, 7, 8, 9, 10].map((count) => `<option value="${count}" ${String(count) === landingDraft.count ? "selected" : ""}>${count} 人</option>`).join("")}
              </select>
            </div>
            <button class="btn btn-primary entry-submit" data-action="create">${icon("crown")} 创建房间</button>
          </div>
          <div class="landing-card card-join" ${landingMode === "join" ? "" : "hidden"}>
            <div class="field">
              <label for="joinNameInput">你的名字</label>
              <input id="joinNameInput" value="${escapeHtml(landingDraft.name)}" maxlength="16" placeholder="输入你的名字" autocomplete="nickname" />
            </div>
            <div class="field">
              <label for="roomInput">房间代码</label>
              <input id="roomInput" maxlength="8" value="${escapeHtml(landingDraft.roomCode)}" placeholder="例如 A1B2C" autocomplete="off" />
            </div>
            <button class="btn btn-primary entry-submit" data-action="join">${icon("leave")} 加入房间</button>
          </div>
        </div>
        ${hasPreviousSession ? `<button class="btn btn-secondary entry-submit" data-action="rejoin">重新加入上次房间</button>` : ""}
        <div class="landing-footer">
          <button class="text-tool" data-action="show-rules">${icon("rules")} 游戏规则</button>
          <button class="text-tool" data-action="show-gallery">${icon("gallery")} 角色收藏馆</button>
          <button class="text-tool" data-action="solo">${icon("solo")} 单机测试</button>
        </div>
      </div>
    </div>
    ${dialogs.rules}
    ${dialogs.gallery}
    ${dialogs.share}
    ${dialogs.dissolve}
    ${dialogs.detail}
    ${dialogs.solo}
  `;
}
