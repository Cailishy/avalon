import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceChat } from "./voice";
import type { VoicePolicy } from "../shared/voice";

vi.mock("./icons", () => ({ icon: () => "" }));
const policy: VoicePolicy = { configured: true, roomCode: "ABCDE", epoch: "epoch-1", canSpeak: true };
const events = { TrackSubscribed: "track", TrackUnsubscribed: "untrack", ActiveSpeakersChanged: "speakers", ParticipantConnected: "join", ParticipantDisconnected: "leave", TrackMuted: "muted", TrackUnmuted: "unmuted", Reconnecting: "reconnecting", Reconnected: "reconnected", Disconnected: "disconnected" };
let rooms: FakeRoom[];
let controls: Map<string, (event?: unknown) => void>;
let appended: unknown[];
class FakeRoom {
  handlers = new Map<string, (...args: any[]) => void>();
  localParticipant = { identity: "self", name: "Me", isMicrophoneEnabled: false, setMicrophoneEnabled: vi.fn(async (enabled: boolean) => { this.localParticipant.isMicrophoneEnabled = enabled; }) };
  remoteParticipants = new Map();
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  startAudio = vi.fn(async () => {});
  constructor(readonly options?: { singlePeerConnection: boolean }) { rooms.push(this); }
  on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); return this; }
}
function element() {
  return { innerHTML: "", className: "", setAttribute: vi.fn(), remove: vi.fn(), addEventListener: vi.fn(), querySelectorAll: () => [], querySelector: (selector: string) => ({ addEventListener: (event: string, handler: (event?: unknown) => void) => controls.set(`${selector}:${event}`, handler), focus: vi.fn() }) };
}
function setup() {
  const access = vi.fn(async () => ({ ...policy, url: "wss://voice.example.com", token: "server-token" }));
  const notify = vi.fn();
  const changed = vi.fn();
  const voice = new VoiceChat({ requestAccess: access, notify, changed, loadClient: async () => ({ Room: FakeRoom, RoomEvent: events, Track: { Kind: { Audio: "audio" } } }) as never });
  voice.updateContext(policy.roomCode, true);
  voice.setPolicy(policy);
  return { voice, access, notify, changed };
}
beforeEach(() => {
  rooms = [];
  controls = new Map();
  appended = [];
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("RTCPeerConnection", class {});
  vi.stubGlobal("document", { querySelectorAll: () => [], createElement: element, body: { appendChild: (value: unknown) => appended.push(value) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Live voice client", () => {
  it("hides unconfigured voice and never loads a media connection for the base game", async () => {
    const { voice, access } = setup();
    voice.setPolicy({ ...policy, configured: false });
    expect(voice.headerButton()).toContain("hidden");
    await voice.join();
    expect(rooms).toEqual([]);
    expect(access).not.toHaveBeenCalled();
    voice.dispose();
  });
  it("never captures a microphone just by opening a game or joining to listen", async () => {
    const { voice, access } = setup();
    expect(access).not.toHaveBeenCalled();
    await voice.join();
    expect(rooms[0].options?.singlePeerConnection).toBe(false);
    expect(rooms[0].connect).toHaveBeenCalledWith("wss://voice.example.com", "server-token", { autoSubscribe: true });
    expect(rooms[0].localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(voice.headerButton()).toContain('aria-pressed="true"');
    voice.dispose();
  });
  it("only enables the microphone after an explicit toggle and permission", async () => {
    const { voice } = setup();
    const root = { querySelector: () => ({ addEventListener: (_: string, handler: () => void) => controls.set("open", handler) }) };
    voice.bind(root as unknown as HTMLElement);
    controls.get("open")!();
    await voice.join();
    controls.get("[data-voice='mic']:change")!({ target: { checked: true } });
    await Promise.resolve();
    expect(rooms[0].localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    voice.dispose();
  });
  it("rotates connections on a server epoch and cannot publish while forced to listen", async () => {
    const { voice, access } = setup();
    await voice.join();
    access.mockResolvedValueOnce({ ...policy, epoch: "epoch-2", canSpeak: false, url: "wss://voice.example.com", token: "new" });
    voice.setPolicy({ ...policy, epoch: "epoch-2", canSpeak: false });
    await vi.waitFor(() => expect(rooms).toHaveLength(2));
    expect(rooms[0].disconnect).toHaveBeenCalled();
    expect(rooms[1].localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
    voice.dispose();
  });
  it("reconnects an established media connection, but not after leaving", async () => {
    vi.useFakeTimers();
    const { voice, access } = setup();
    try {
      await voice.join();
      rooms[0].handlers.get("disconnected")!();
      await vi.advanceTimersByTimeAsync(500);
      expect(access).toHaveBeenCalledTimes(2);
      expect(rooms).toHaveLength(2);
      rooms[1].handlers.get("disconnected")!();
      voice.leave();
      await vi.advanceTimersByTimeAsync(1000);
      expect(access).toHaveBeenCalledTimes(2);
    } finally { voice.dispose(); vi.useRealTimers(); }
  });
  it("does not loop when the initial transport fails or log sensitive error text", async () => {
    const { voice, notify } = setup();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const connect = vi.spyOn(FakeRoom.prototype, "on").mockImplementation(function (this: FakeRoom, event, handler) {
      this.handlers.set(event, handler);
      this.connect = vi.fn(async () => {
        this.handlers.get("disconnected")?.();
        throw new Error("secret-token");
      });
      return this;
    });
    try {
      await voice.join();
      expect(rooms).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith("语音连接失败，请重试");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("secret-token");
    } finally { voice.dispose(); connect.mockRestore(); warning.mockRestore(); }
  });
  it("attaches remote audio separately from the game DOM and cleans it up on leave", async () => {
    const { voice } = setup();
    await voice.join();
    const audio = { style: {}, remove: vi.fn() };
    const track = { kind: "audio", setVolume: vi.fn(), attach: () => audio, detach: () => [audio] };
    rooms[0].handlers.get("track")!(track);
    expect(appended).toContain(audio);
    expect(track.setVolume).toHaveBeenCalledWith(0.8);
    voice.leave();
    expect(audio.remove).toHaveBeenCalled();
    expect(rooms[0].disconnect).toHaveBeenCalled();
  });
  it("ignores an in-flight token response after the user leaves", async () => {
    const { voice, access } = setup();
    let finish!: (value: any) => void;
    access.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = voice.join();
    await Promise.resolve();
    voice.leave();
    finish({ ...policy, url: "wss://voice.example.com", token: "late" });
    await pending;
    expect(rooms).toHaveLength(0);
  });
  it("handles unavailable media services and insecure contexts without requesting a microphone", async () => {
    const { voice, access, notify } = setup();
    access.mockRejectedValueOnce(new Error("语音服务暂不可用"));
    await voice.join();
    expect(notify).toHaveBeenCalledWith("语音服务暂不可用");
    vi.stubGlobal("window", { isSecureContext: false });
    await voice.join();
    expect(access).toHaveBeenCalledOnce();
    expect(rooms).toHaveLength(0);
  });
});
