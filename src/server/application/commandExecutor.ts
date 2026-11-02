import { createHash } from "node:crypto";
import { COMMAND_TTL_MS, needsPhase, type CommandEvent, type GameAck } from "../../shared/protocol";
import { GameError } from "../../shared/errors";
import { CommandCapacityError, type CommandReceipt } from "../commandReceipt";
import type { CommandTransaction } from "./contracts";

export type { CommandTransaction } from "./contracts";

export type CommandPayload = Record<string, unknown> & {
  requestId: string;
  issuedAt: number;
  phaseId?: string;
  roomCode?: string;
  playerId?: string;
};

export interface CommandExecutorPorts {
  isClosing: () => boolean;
  assertHealthy: () => void;
  receipt: (owner: string, requestId: string) => CommandReceipt | null;
  ensureCommandCapacity: (owner: string) => void;
  commit: (roomCodes: Iterable<string>, receipt: CommandReceipt) => void;
  phaseId: (roomCode: string) => string | undefined;
  markChanged: (roomCode: string) => void;
  publish: (roomCode: string) => void;
}

export interface CommandExecutionInput {
  event: CommandEvent;
  payload: CommandPayload;
  owner: string;
  boundSession?: { roomCode?: string; playerId?: string };
  onDuplicateEntry: (saved: GameAck) => void;
  action: (transaction: CommandTransaction) => object;
}

export class CommandExecutor {
  constructor(private readonly ports: CommandExecutorPorts) {}

  execute(input: CommandExecutionInput): GameAck {
    try {
      if (this.ports.isClosing()) throw new GameError("STORAGE_UNAVAILABLE", "服务正在重启，请稍后重连。");
      this.ports.assertHealthy();
      if (input.payload.issuedAt < Date.now() - COMMAND_TTL_MS || input.payload.issuedAt > Date.now() + 30_000) {
        return { ok: false, code: "REQUEST_EXPIRED", error: "操作已过期或时间未校准，请同步后重新操作。" };
      }

      const fingerprint = createHash("sha256").update(JSON.stringify({ event: input.event, payload: input.payload })).digest("hex");
      const previous = this.ports.receipt(input.owner, input.payload.requestId);
      if (previous) {
        if (previous.event !== input.event || previous.fingerprint !== fingerprint) {
          return { ok: false, code: "REQUEST_CONFLICT", error: "请求编号已用于其他操作，请同步后重试。" };
        }
        const saved = previous.result;
        if (input.event === "room:create" || input.event === "room:join") {
          if (saved.ok && saved.roomCode && saved.playerId && saved.sessionToken) input.onDuplicateEntry(saved);
        }
        return saved;
      }

      this.ports.ensureCommandCapacity(input.owner);
      const changedRooms = new Set<string>();
      const effects: Array<() => void> = [];
      const transaction: CommandTransaction = {
        markRoomChanged: roomCode => changedRooms.add(roomCode),
        afterCommit: effect => effects.push(effect),
      };

      let result: GameAck;
      try {
        const isEntry = input.event === "room:create" || input.event === "room:join";
        const bound = input.boundSession;
        if (isEntry ? Boolean(bound?.playerId) : bound?.playerId !== input.payload.playerId || bound?.roomCode !== input.payload.roomCode) {
          throw new GameError(isEntry ? "NOT_AUTHORIZED" : "SESSION_INVALID", isEntry ? "请先离开当前房间。" : "请先恢复当前玩家会话。");
        }
        if (needsPhase(input.event) && this.ports.phaseId(String(input.payload.roomCode)) !== input.payload.phaseId) {
          result = { ok: false, code: "STALE_PHASE", error: "游戏阶段已更新，请按当前页面重新操作。" };
        } else {
          result = { ok: true, ...input.action(transaction) };
        }
      } catch (error) {
        if (changedRooms.size) throw error;
        result = { ok: false, ...(error instanceof GameError ? { code: error.code } : {}), error: error instanceof Error ? error.message : "操作失败。" };
      }

      const receipt: CommandReceipt = {
        owner: input.owner,
        requestId: input.payload.requestId,
        event: input.event,
        fingerprint,
        expiresAt: input.payload.issuedAt + COMMAND_TTL_MS,
        result,
      };
      changedRooms.forEach(roomCode => this.ports.markChanged(roomCode));
      this.ports.commit(changedRooms, receipt);
      effects.forEach(effect => this.deliverCommitted(effect));
      changedRooms.forEach(roomCode => this.deliverCommitted(() => this.ports.publish(roomCode)));
      return result;
    } catch (error) {
      return {
        ok: false,
        ...(error instanceof CommandCapacityError ? { code: "RATE_LIMITED" } : error instanceof GameError ? { code: error.code } : {}),
        error: error instanceof Error ? error.message : "操作失败。",
      };
    }
  }

  private deliverCommitted(effect: () => void): void {
    try { effect(); }
    catch {
      // Delivery failures cannot undo the durable result or expose backend errors.
      console.error("Post-commit delivery failed; the saved command result is unchanged. Clients can synchronize or check the receipt.");
    }
  }
}
