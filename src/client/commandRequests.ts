import { COMMAND_TTL_MS, isCommand, needsPhase, type GameAck, type CommandStatusReply } from "../shared/protocol";

interface Transport {
  connected: boolean;
  emit(event: string, payload: object, ack: (result?: CommandStatusReply) => void): unknown;
}
type Pending = { event: string; payload: Record<string, unknown>; callback: (ack: GameAck) => void; timer?: ReturnType<typeof setTimeout>; attempts: number; waiting: boolean };

export class CommandRequests {
  private pending = new Map<string, Pending>();
  constructor(private socket: Transport, private options: {
    phaseId: () => string | undefined;
    now: () => number;
    reconcile: () => void;
    uncertain: () => void;
    canSend?: (event: string) => boolean;
    timeoutMs?: number;
    requestId?: () => string;
  }) {}

  send(event: string, value: Record<string, unknown>, callback: (ack: GameAck) => void): void {
    if (this.pending.has(event)) return;
    const payload = structuredClone(value);
    if (isCommand(event)) {
      payload.requestId = this.options.requestId?.() ?? makeRequestId();
      payload.issuedAt = Math.floor(this.options.now());
      if (needsPhase(event)) payload.phaseId = this.options.phaseId();
    }
    const pending: Pending = { event, payload, callback, attempts: 0, waiting: false };
    this.pending.set(event, pending);
    this.attempt(pending);
  }

  resume(): void {
    for (const request of this.pending.values()) {
      if (!request.waiting || request.timer) continue;
      if (isCommand(request.event) && this.options.now() - Number(request.payload.issuedAt) >= COMMAND_TTL_MS) {
        this.finish(request, { ok: false, code: "REQUEST_EXPIRED", error: "操作已过期，请根据当前状态重新操作。" });
      } else { request.attempts = 0; this.attempt(request); }
    }
  }

  phaseChanged(): void {
    for (const request of this.pending.values()) {
      if (request.waiting && needsPhase(request.event) && request.payload.phaseId !== this.options.phaseId()) {
        this.finish(request, { ok: false, code: "UNCONFIRMED", error: "原操作尚未确认，阶段已更新，请以当前对局状态为准。" });
      }
    }
  }

  cancel(): void {
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.pending.clear();
  }

  private attempt(request: Pending): void {
    if (this.pending.get(request.event) !== request) return;
    clearTimeout(request.timer);
    request.waiting = false;
    if (!this.socket.connected || (isCommand(request.event) && this.options.canSend?.(request.event) === false)) { request.waiting = true; this.options.uncertain(); return; }
    request.attempts++;
    request.timer = setTimeout(() => {
      request.timer = undefined;
      if (this.pending.get(request.event) !== request) return;
      this.options.reconcile();
      if (isCommand(request.event) && this.socket.connected) {
        this.socket.emit("command:status", { event: request.event, requestId: request.payload.requestId, ...(request.payload.sessionToken ? { sessionToken: request.payload.sessionToken } : {}) }, status => {
          if (this.pending.get(request.event) === request && status?.ok && status.result) this.finish(request, status.result);
        });
      }
      if (!isCommand(request.event)) {
        this.finish(request, { ok: false, code: "UNCONFIRMED", error: "请求尚未确认，请检查连接后重试。" });
      } else if (request.attempts < 3 && this.socket.connected) this.attempt(request);
      else { request.waiting = true; this.phaseChanged(); if (this.pending.get(request.event) === request) this.options.uncertain(); }
    }, this.options.timeoutMs ?? 5000);
    // Late acknowledgements still settle the same intent, even after its retry.
    this.socket.emit(request.event, request.payload, result => {
      if (this.pending.get(request.event) !== request) return;
      if (!result) return;
      this.finish(request, result);
    });
  }

  private finish(request: Pending, result: GameAck): void {
    clearTimeout(request.timer);
    this.pending.delete(request.event);
    request.callback(result);
  }
}

function makeRequestId(): string {
  return `r_${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
