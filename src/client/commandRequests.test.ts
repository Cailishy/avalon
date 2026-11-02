import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRequests } from "./commandRequests";
import { COMMAND_TTL_MS, type CommandStatusReply } from "../shared/protocol";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const sent: Array<{ event: string; payload: Record<string, unknown>; ack: (result?: CommandStatusReply) => void }> = [];
  const socket = { connected: true, emit: (event: string, payload: object, ack: (result?: CommandStatusReply) => void) => { sent.push({ event, payload: payload as Record<string, unknown>, ack }); } };
  const options = { phaseId: () => `phase_${"a".repeat(32)}`, now: () => Date.now(), reconcile: vi.fn(), uncertain: vi.fn(), timeoutMs: 100, requestId: () => `r_${"b".repeat(32)}` };
  return { requests: new CommandRequests(socket, options), sent, socket, options };
}

describe("Confirmed command requests", () => {
  it("does not resend a game command until the player session has been restored", () => {
    const { socket, sent, options } = setup(); let ready = false;
    const requests = new CommandRequests(socket, { ...options, canSend: () => ready });
    requests.send("vote:submit", { approved: true }, vi.fn());
    expect(sent).toHaveLength(0);
    requests.resume(); expect(sent).toHaveLength(0);
    ready = true; requests.resume();
    expect(sent).toHaveLength(1); expect(sent[0].event).toBe("vote:submit");
    requests.cancel();
  });

  it("confirms a committed operation through the read-only status query after its acknowledgement is lost", () => {
    const { requests, sent } = setup(); const done = vi.fn();
    requests.send("room:create", { name: "Host" }, done);
    vi.advanceTimersByTime(100);
    const status = sent.find(value => value.event === "command:status")!;
    status.ack({ ok: true, result: { ok: true, roomCode: "ABCDE" } });
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ ok: true, roomCode: "ABCDE" });
    vi.advanceTimersByTime(1000);
    expect(sent.filter(value => value.event === "room:create")).toHaveLength(2);
  });

  it("retries the same immutable intent and accepts a late original acknowledgement only once", () => {
    const { requests, sent, options } = setup(); const done = vi.fn();
    const payload = { team: ["one", "two"] };
    requests.send("team:propose", payload, done); payload.team.push("three");
    vi.advanceTimersByTime(100);
    expect(options.reconcile).toHaveBeenCalledOnce();
    expect(sent.filter(value => value.event === "team:propose")).toHaveLength(2);
    expect(sent[2].payload).toEqual(sent[0].payload);
    expect(sent[0].payload.team).toEqual(["one", "two"]);
    sent[0].ack({ ok: true }); sent[2].ack({ ok: true });
    expect(done).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000); expect(sent.filter(value => value.event === "team:propose")).toHaveLength(2);
  });
  it.each(["team:propose", "vote:submit", "mission:submit", "assassin:choose", "room:start", "room:restart"])("waits for the original acknowledgement when %s advances the authoritative phase", event => {
    const { sent, socket, options } = setup(); const done = vi.fn();
    let activePhase = options.phaseId();
    const phaseAware = new CommandRequests(socket, { ...options, phaseId: () => activePhase });
    phaseAware.send(event, {}, done);
    activePhase = `phase_${"c".repeat(32)}`;
    phaseAware.phaseChanged();
    expect(done).not.toHaveBeenCalled();
    sent[0].ack({ ok: true });
    expect(done).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });
  it("confirms a phase-advancing command from its receipt when the acknowledgement is lost", () => {
    const { sent, socket, options } = setup(); const done = vi.fn();
    let activePhase = options.phaseId();
    const phaseAware = new CommandRequests(socket, { ...options, phaseId: () => activePhase });
    phaseAware.send("mission:submit", { failed: false }, done);
    activePhase = `phase_${"c".repeat(32)}`;
    phaseAware.phaseChanged();
    vi.advanceTimersByTime(100);
    sent.find(request => request.event === "command:status")!.ack({ ok: true, result: { ok: true } });
    expect(done).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });
  it("releases an unconfirmed phase-bound action after bounded retries", () => {
    const { sent, socket, options } = setup(); const done = vi.fn();
    let activePhase = options.phaseId();
    const phaseAware = new CommandRequests(socket, { ...options, phaseId: () => activePhase });
    phaseAware.send("speech:end", {}, done);
    activePhase = `phase_${"c".repeat(32)}`;
    phaseAware.phaseChanged();
    vi.advanceTimersByTime(300);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "UNCONFIRMED" }));
    phaseAware.send("speech:end", {}, vi.fn());
    expect(sent.filter(request => request.event === "speech:end")).toHaveLength(4);
  });
  it("confirms speech end when the authoritative snapshot moved to another speaker", () => {
    const { sent, socket, options } = setup(); const done = vi.fn();
    let activePhase = options.phaseId();
    let currentSpeaker = "speaker-a";
    const phaseAware = new CommandRequests(socket, {
      ...options,
      phaseId: () => activePhase,
      confirmPhaseChange: request => request.event === "speech:end" && currentSpeaker !== request.payload.playerId,
    });
    phaseAware.send("speech:end", { playerId: "speaker-a" }, done);
    activePhase = `phase_${"d".repeat(32)}`;
    currentSpeaker = "speaker-b";
    phaseAware.phaseChanged();
    expect(done).toHaveBeenCalledWith({ ok: true });
    expect(sent).toHaveLength(1);
  });
  it("does not turn lost responses into a false failure or a fresh operation", () => {
    const { requests, sent, options } = setup(); const done = vi.fn();
    requests.send("room:create", { name: "Host" }, done);
    requests.send("room:create", { name: "Other" }, done);
    vi.advanceTimersByTime(300);
    expect(sent.filter(value => value.event === "room:create")).toHaveLength(3); expect(done).not.toHaveBeenCalled();
    expect(options.uncertain).toHaveBeenCalledOnce();
    requests.resume(); expect(sent.filter(value => value.event === "room:create")).toHaveLength(4);
    expect(new Set(sent.map(value => value.payload.requestId)).size).toBe(1);
    sent.at(-1)!.ack({ ok: true, roomCode: "ABCDE" });
    expect(done).toHaveBeenCalledWith({ ok: true, roomCode: "ABCDE" });
  });
  it("waits while disconnected and expires an old intent rather than renewing it", () => {
    const { requests, sent, socket } = setup(); const done = vi.fn();
    socket.connected = false; requests.send("vote:submit", { approved: true }, done);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(COMMAND_TTL_MS); socket.connected = true; requests.resume();
    expect(sent).toHaveLength(0);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "REQUEST_EXPIRED" }));
  });
  it("keeps read-only queries free of mutation metadata and cancels old callbacks on leaving", () => {
    const { requests, sent } = setup(); const done = vi.fn();
    requests.send("room:rejoin", { roomCode: "ABCDE" }, done);
    expect(sent[0].payload).toEqual({ roomCode: "ABCDE" });
    requests.cancel(); sent[0].ack({ ok: true });
    vi.advanceTimersByTime(1000); expect(done).not.toHaveBeenCalled();
  });
  it("retries a pending rejoin immediately on a fresh socket", () => {
    const { requests, sent } = setup();
    requests.send("room:rejoin", { roomCode: "ABCDE" }, vi.fn());
    expect(sent).toHaveLength(1);
    expect(requests.retry("room:rejoin")).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0].payload).toEqual(sent[1].payload);
  });
});
