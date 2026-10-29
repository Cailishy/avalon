import { GameAudio } from "./audio";
import { icon } from "./icons";

let popup: HTMLDivElement | null = null;

export function soundButton(audio: GameAudio, className: string): string {
  return `<button class="${className} sound-button" data-action="sound" title="声音设置" aria-label="声音设置" aria-haspopup="dialog">${icon(audio.preferences.music ? "volume" : "muted", 20)}</button>`;
}

export function closeSoundSettings(): void {
  popup?.remove();
  popup = null;
}

export function bindSoundSettings(root: HTMLElement, audio: GameAudio, signal?: AbortSignal): void {
  const button = root.querySelector<HTMLButtonElement>("[data-action='sound']");
  button?.addEventListener("click", () => {
    audio.unlock();
    if (popup) { closeSoundSettings(); return; }
    popup = document.createElement("div");
    popup.className = "sound-settings";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "声音设置");
    const prefs = audio.preferences;
    popup.innerHTML = `
      <div class="sound-settings-heading"><strong>声音设置</strong><button class="sound-close" title="关闭声音设置" aria-label="关闭声音设置">${icon("close")}</button></div>
      <label class="sound-option"><span>背景音乐</span><input type="checkbox" data-sound="music" ${prefs.music ? "checked" : ""}></label>
      <label class="sound-volume"><span>音乐音量</span><input type="range" min="0" max="100" value="${Math.round(prefs.musicVolume * 100)}" data-sound="musicVolume"><output>${Math.round(prefs.musicVolume * 100)}%</output></label>
      <label class="sound-option"><span>游戏旁白</span><input type="checkbox" data-sound="narration" ${audio.narrationEnabled ? "checked" : ""} ${!audio.narrationSupported ? "disabled" : ""} title="${audio.narrationSupported ? "房主默认开启" : "当前浏览器不支持音频播放"}"></label>
      <label class="sound-volume"><span>旁白音量</span><input type="range" min="0" max="100" value="${Math.round(prefs.narrationVolume * 100)}" data-sound="narrationVolume" ${!audio.narrationSupported ? "disabled" : ""}><output>${Math.round(prefs.narrationVolume * 100)}%</output></label>
      <label class="sound-option"><span>结果音效</span><input type="checkbox" data-sound="effects" ${prefs.effects ? "checked" : ""}></label>
      <label class="sound-volume"><span>音效音量</span><input type="range" min="0" max="100" value="${Math.round(prefs.effectsVolume * 100)}" data-sound="effectsVolume"><output>${Math.round(prefs.effectsVolume * 100)}%</output></label>`;
    document.body.appendChild(popup);
    popup.querySelector(".sound-close")?.addEventListener("click", () => { closeSoundSettings(); button.focus(); });
    popup.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeSoundSettings(); button.focus(); } });
    popup.querySelectorAll<HTMLInputElement>("[data-sound]").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.dataset.sound!;
        if (key === "music" || key === "narration" || key === "effects") audio.setPreferences({ [key]: input.checked });
        else {
          audio.setPreferences({ [key]: Number(input.value) / 100 });
          input.nextElementSibling!.textContent = `${input.value}%`;
        }
        const currentButton = root.querySelector<HTMLButtonElement>("[data-action='sound']");
        if (currentButton) currentButton.innerHTML = icon(audio.preferences.music ? "volume" : "muted", 20);
      });
    });
    popup.querySelector<HTMLButtonElement>(".sound-close")?.focus();
  }, { signal });
}
