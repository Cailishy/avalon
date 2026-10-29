import type { Room, RemoteAudioTrack, RemoteTrack } from "livekit-client";
import type { VoiceAccess, VoicePolicy } from "../shared/voice";
import { icon } from "./icons";

type Client = typeof import("livekit-client");
type VoiceOptions = {
  requestAccess: () => Promise<VoiceAccess>;
  notify: (message: string) => void;
  changed: (active: boolean) => void;
  loadClient?: () => Promise<Client>;
};

export class VoiceChat {
  private policy: VoicePolicy | null = null;
  private roomCode: string | null = null;
  private online = false;
  private wanted = false;
  private microphoneWanted = false;
  private generation = 0;
  private room: Room | null = null;
  private connecting = false;
  private microphoneBusy = false;
  private status = "未加入语音";
  private popup: HTMLDivElement | null = null;
  private popupKey = "";
  private elements = new Set<HTMLMediaElement>();
  private speakers = new Set<string>();
  private volume = 0.8;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: VoiceOptions) {}

  headerButton(): string {
    return `<button class="icon-btn voice-button" data-action="voice" title="实时语音" aria-label="实时语音" aria-haspopup="dialog" aria-pressed="${!!this.room && !this.connecting}" ${this.policy?.configured ? "" : "hidden"}>${this.buttonContent()}</button>`;
  }

  private buttonContent(): string {
    return `${icon(this.room?.localParticipant.isMicrophoneEnabled ? "mic" : "headphones", 20)}<span class="voice-indicator ${this.room && !this.connecting ? "connected" : ""}" aria-hidden="true"></span>`;
  }

  updateContext(roomCode: string | null, online: boolean): void {
    const changed = roomCode !== this.roomCode;
    this.online = online;
    if (changed) {
      this.roomCode = roomCode;
      this.policy = null;
      this.wanted = false;
      this.microphoneWanted = false;
      this.closePopup();
      this.stopMedia();
    } else if (!online && (this.room || this.connecting)) this.stopMedia();
  }

  setPolicy(policy: VoicePolicy): void {
    if (policy.roomCode !== this.roomCode) return;
    const changed = policy.epoch !== this.policy?.epoch;
    this.policy = policy;
    if (changed && this.wanted) {
      this.stopMedia();
      void this.connect();
    }
    this.refresh();
  }

  bind(root: HTMLElement, signal?: AbortSignal): void {
    root.querySelector("[data-action='voice']")?.addEventListener("click", () => this.togglePopup(), { signal });
  }

  refresh(): void {
    document.querySelectorAll<HTMLElement>("[data-action='voice']").forEach(button => {
      button.hidden = !this.policy?.configured;
      button.innerHTML = this.buttonContent();
      button.setAttribute("aria-pressed", String(!!this.room && !this.connecting));
    });
    document.querySelectorAll<HTMLElement>(".player-card[data-player-id]").forEach(card => card.classList.toggle("voice-speaking", this.speakers.has(card.dataset.playerId ?? "")));
    if (this.popup) this.renderPopup();
    this.options.changed(!!this.room);
  }

  async join(): Promise<void> {
    this.wanted = true;
    await this.connect();
  }

  leave(): void {
    this.wanted = false;
    this.microphoneWanted = false;
    this.stopMedia();
    this.status = "未加入语音";
    this.refresh();
  }

  dispose(): void {
    this.leave();
    this.closePopup();
  }

  private supported(): boolean {
    return window.isSecureContext !== false && typeof RTCPeerConnection !== "undefined";
  }

  private async connect(): Promise<void> {
    if (!this.wanted || !this.online || !this.roomCode || !this.policy?.configured || this.connecting || this.room) return;
    if (!this.supported()) { this.status = "语音需要 HTTPS 或本机安全环境"; this.refresh(); return; }
    const generation = ++this.generation;
    this.connecting = true;
    this.status = "正在连接语音";
    this.refresh();
    let room: Room | undefined;
    try {
      const sdk = await (this.options.loadClient?.() ?? import("livekit-client"));
      sdk.setLogLevel?.("warn");
      const access = await this.options.requestAccess();
      if (generation !== this.generation) return;
      if (access.roomCode !== this.roomCode) throw new Error("语音阶段已更新，请重试。");
      this.policy = access;
      // Dual transports avoid mid-join configuration changes rejected by some WebRTC engines.
      room = new sdk.Room({ singlePeerConnection: false, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, disconnectOnPageLeave: true });
      let established = false;
      const current = () => generation === this.generation && this.room === room;
      room.on(sdk.RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (!current() || track.kind !== sdk.Track.Kind.Audio) return;
        (track as RemoteAudioTrack).setVolume(this.volume);
        const element = track.attach();
        element.style.display = "none";
        this.elements.add(element);
        document.body.appendChild(element);
      });
      room.on(sdk.RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach(element => { element.remove(); this.elements.delete(element); });
      });
      room.on(sdk.RoomEvent.ActiveSpeakersChanged, speakers => {
        if (!current()) return;
        this.speakers = new Set(speakers.map(participant => participant.identity));
        this.refresh();
      });
      for (const event of [sdk.RoomEvent.ParticipantConnected, sdk.RoomEvent.ParticipantDisconnected, sdk.RoomEvent.TrackMuted, sdk.RoomEvent.TrackUnmuted]) {
        room.on(event, () => { if (current()) this.refresh(); });
      }
      room.on(sdk.RoomEvent.Reconnecting, () => { if (current()) { this.status = "语音正在重连"; this.refresh(); } });
      room.on(sdk.RoomEvent.Reconnected, () => { if (current()) { this.status = "语音已连接"; this.refresh(); } });
      room.on(sdk.RoomEvent.Disconnected, () => {
        if (!current() || !established) return;
        this.stopMedia();
        this.status = "语音正在重连";
        this.refresh();
        this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, 500);
      });
      this.room = room;
      await room.connect(access.url, access.token, { autoSubscribe: true });
      if (!current()) { await room.disconnect(); return; }
      established = true;
      this.status = "语音已连接";
      await room.startAudio().catch(() => { this.status = "请启用声音播放"; });
      if (this.microphoneWanted && access.canSpeak) await this.applyMicrophone(room);
    } catch (error) {
      if (generation !== this.generation) { await room?.disconnect(); return; }
      if (error instanceof Error) {
        const reason = "reasonName" in error ? String(error.reasonName) : "unknown";
        const category = error.message.match(/RTCPeerConnection|RTCRtpSender|RTCRtpReceiver|getCapabilities|SDP|ICE|setRemoteDescription|createOffer|crypto|WebSocket|codec|permission|OperationError/i)?.[0] ?? "unknown";
        console.warn(`Voice transport failed (${error.name}; ${reason}; ${category})`);
      }
      this.stopMedia();
      this.wanted = false;
      this.status = error instanceof Error && /语音|麦克风|阶段/.test(error.message) ? error.message : "语音连接失败，请重试";
      this.options.notify(this.status);
    } finally {
      if (generation === this.generation) this.connecting = false;
      this.refresh();
    }
  }

  private stopMedia(): void {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connecting = false;
    this.microphoneBusy = false;
    const room = this.room;
    this.room = null;
    if (room) void room.disconnect(true).catch(() => {});
    this.elements.forEach(element => element.remove());
    this.elements.clear();
    this.speakers.clear();
  }

  private async applyMicrophone(room: Room): Promise<void> {
    if (this.microphoneBusy) return;
    this.microphoneBusy = true;
    try {
      await room.localParticipant.setMicrophoneEnabled(this.microphoneWanted && !!this.policy?.canSpeak);
    } catch {
      this.microphoneWanted = false;
      this.options.notify("麦克风不可用，请检查设备和授权。");
    } finally {
      this.microphoneBusy = false;
      this.refresh();
    }
  }

  private togglePopup(): void {
    if (this.popup) { this.closePopup(); return; }
    this.popup = document.createElement("div");
    this.popup.className = "voice-settings";
    this.popup.setAttribute("role", "dialog");
    this.popup.setAttribute("aria-label", "实时语音");
    document.body.appendChild(this.popup);
    this.popup.addEventListener("keydown", event => { if (event.key === "Escape") this.closePopup(); });
    this.renderPopup();
    this.popup.querySelector<HTMLButtonElement>("[data-voice='close']")?.focus();
  }

  private closePopup(): void { this.popup?.remove(); this.popup = null; this.popupKey = ""; }

  private renderPopup(): void {
    if (!this.popup) return;
    const joined = !!this.room && !this.connecting;
    const status = !this.online ? "游戏连接已断开" : !this.policy?.configured ? "语音服务未配置" : !this.supported() ? "语音需要 HTTPS 或本机安全环境" : joined && !this.policy.canSpeak ? "仅收听" : this.status;
    const peers = this.room ? [this.room.localParticipant, ...this.room.remoteParticipants.values()] : [];
    const key = JSON.stringify([status, joined, this.connecting, this.microphoneBusy, this.policy?.canSpeak, peers.map(peer => [peer.identity, peer.name, peer.isMicrophoneEnabled])]);
    if (key === this.popupKey) {
      this.popup.querySelectorAll<HTMLElement>("[data-voice-id]").forEach(row => row.classList.toggle("speaking", this.speakers.has(row.dataset.voiceId ?? "")));
      return;
    }
    this.popupKey = key;
    this.popup.innerHTML = `<div class="sound-settings-heading"><strong>实时语音</strong><button class="sound-close" data-voice="close" title="关闭实时语音" aria-label="关闭实时语音">${icon("close")}</button></div>
      <p class="voice-status" role="status">${escape(status)}</p>
      <div class="voice-commands"><button class="btn btn-secondary" data-voice="join" ${!this.online || !this.policy?.configured || this.connecting || !this.supported() ? "disabled" : ""}>${icon(joined ? "leave" : "headphones")}${joined ? "离开语音" : this.connecting ? "连接中" : "加入语音"}</button>${joined ? `<button class="icon-btn" data-voice="play" title="启用声音播放" aria-label="启用声音播放">${icon("volume")}</button>` : ""}</div>
      <label class="sound-option"><span>麦克风</span><input type="checkbox" data-voice="mic" ${this.room?.localParticipant.isMicrophoneEnabled ? "checked" : ""} ${!joined || !this.policy?.canSpeak || this.microphoneBusy ? "disabled" : ""} title="${this.policy?.canSpeak ? "麦克风" : "当前阶段不可发言"}"></label>
      <label class="sound-volume"><span>接收音量</span><input type="range" min="0" max="100" value="${Math.round(this.volume * 100)}" data-voice="volume"><output>${Math.round(this.volume * 100)}%</output></label>
      <ul class="voice-peers">${peers.map(peer => `<li data-voice-id="${escape(peer.identity)}" class="${this.speakers.has(peer.identity) ? "speaking" : ""}">${icon(peer.isMicrophoneEnabled ? "mic" : "micOff", 15)}<span>${escape(peer.name || "玩家")}</span></li>`).join("")}</ul>`;
    this.popup.querySelector("[data-voice='close']")?.addEventListener("click", () => this.closePopup());
    this.popup.querySelector("[data-voice='join']")?.addEventListener("click", () => joined ? this.leave() : void this.join());
    this.popup.querySelector("[data-voice='play']")?.addEventListener("click", () => void this.room?.startAudio().catch(() => this.options.notify("暂时无法播放语音。")));
    this.popup.querySelector<HTMLInputElement>("[data-voice='mic']")?.addEventListener("change", event => {
      this.microphoneWanted = (event.target as HTMLInputElement).checked;
      if (this.room && this.policy?.canSpeak) void this.applyMicrophone(this.room);
    });
    this.popup.querySelector<HTMLInputElement>("[data-voice='volume']")?.addEventListener("input", event => {
      const input = event.target as HTMLInputElement;
      this.volume = Math.max(0, Math.min(1, Number(input.value) / 100));
      if (input.nextElementSibling) input.nextElementSibling.textContent = `${Math.round(this.volume * 100)}%`;
      this.room?.remoteParticipants.forEach(peer => peer.audioTrackPublications.forEach(publication => (publication.audioTrack as RemoteAudioTrack | undefined)?.setVolume(this.volume)));
    });
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
