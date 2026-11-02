import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CommandReceipt } from "../commandReceipt";
import { CommandExecutor, type CommandExecutorPorts } from "./commandExecutor";
import { GameError } from "../../shared/errors";
import type { CommandTransaction } from "./contracts";

const basePayload = { requestId: `r_${"a".repeat(32)}`, issuedAt: Date.now(), roomCode: "ABCDE", playerId: "p_1", phaseId: "phase_current" };

function ports(overrides: Partial<CommandExecutorPorts> = {}): CommandExecutorPorts {
  return {
    isClosing: () => false,
    assertHealthy: () => undefined,
    receipt: () => null,
    ensureCommandCapacity: () => undefined,
    commit: () => undefined,
    phaseId: () => "phase_current",
    markChanged: () => undefined,
    publish: () => undefined,
    ...overrides,
  };
}

describe("CommandExecutor", () => {
  it("commits before effects and publishes changed rooms", () => {
    const order: string[] = [];
    const executor = new CommandExecutor(ports({
      commit: () => order.push("commit"),
      publish: () => order.push("publish"),
    }));

    const result = executor.execute({
      event: "player:setReady",
      payload: { ...basePayload, ready: true },
      owner: "owner",
      boundSession: { roomCode: "ABCDE", playerId: "p_1" },
      onDuplicateEntry: () => undefined,
      action: transaction => {
        transaction.markRoomChanged("ABCDE");
        transaction.afterCommit(() => order.push("effect"));
        return {};
      },
    });

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["commit", "effect", "publish"]);
  });

  it.each(["effect", "publish"] as const)("keeps the committed result when a post-commit %s fails", stage => {
    const order: string[] = [];
    const action = vi.fn((transaction: CommandTransaction) => {
      transaction.markRoomChanged("ABCDE");
      transaction.markRoomChanged("FGHIJ");
      transaction.afterCommit(() => {
        order.push("effect:first");
        if (stage === "effect") throw new Error("Private backend diagnostics");
      });
      transaction.afterCommit(() => order.push("effect:second"));
      return {};
    });
    let receipt: CommandReceipt | null = null;
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const executor = new CommandExecutor(ports({
        receipt: () => receipt,
        commit: (_rooms, saved) => { order.push("commit"); receipt = saved; },
        publish: code => {
          order.push(`publish:${code}`);
          if (stage === "publish" && code === "ABCDE") throw new Error("Private backend diagnostics");
        },
      }));
      const input = {
        event: "player:setReady" as const,
        payload: { ...basePayload, ready: true },
        owner: "owner",
        boundSession: { roomCode: "ABCDE", playerId: "p_1" },
        onDuplicateEntry: () => undefined,
        action,
      };

      expect(executor.execute(input)).toEqual({ ok: true });
      expect(order).toEqual(["commit", "effect:first", "effect:second", "publish:ABCDE", "publish:FGHIJ"]);
      expect(executor.execute(input)).toEqual({ ok: true });
      expect(action).toHaveBeenCalledTimes(1);
      expect(logger).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.mock.calls)).not.toContain("Private backend diagnostics");
    } finally {
      logger.mockRestore();
    }
  });

  it("does not run effects or publish when the commit fails", () => {
    const effect = vi.fn();
    const publish = vi.fn();
    const executor = new CommandExecutor(ports({
      commit: () => { throw new GameError("STORAGE_UNAVAILABLE", "Synthetic storage failure"); },
      publish,
    }));
    const result = executor.execute({
      event: "player:setReady",
      payload: { ...basePayload, ready: true },
      owner: "owner",
      boundSession: { roomCode: "ABCDE", playerId: "p_1" },
      onDuplicateEntry: () => undefined,
      action: transaction => {
        transaction.markRoomChanged("ABCDE");
        transaction.afterCommit(effect);
        return {};
      },
    });

    expect(result).toMatchObject({ ok: false, code: "STORAGE_UNAVAILABLE" });
    expect(effect).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns the original receipt without running the action again", () => {
    const action = vi.fn(() => ({}));
    const payload = { ...basePayload, ready: true };
    const fingerprint = createHash("sha256").update(JSON.stringify({ event: "player:setReady", payload })).digest("hex");
    const saved: CommandReceipt = {
      owner: "owner",
      requestId: basePayload.requestId,
      event: "player:setReady",
      fingerprint,
      expiresAt: Date.now() + 1000,
      result: { ok: true },
    };
    const executor = new CommandExecutor(ports({ receipt: () => ({ ...saved, fingerprint }) }));

    const result = executor.execute({
      event: "player:setReady",
      payload,
      owner: "owner",
      boundSession: { roomCode: "ABCDE", playerId: "p_1" },
      onDuplicateEntry: () => undefined,
      action,
    });

    expect(result).toEqual({ ok: true });
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects a command from an old phase without invoking domain code", () => {
    const action = vi.fn(() => ({}));
    const executor = new CommandExecutor(ports({ phaseId: () => "phase_new" }));

    const result = executor.execute({
      event: "player:setReady",
      payload: { ...basePayload, ready: true },
      owner: "owner",
      boundSession: { roomCode: "ABCDE", playerId: "p_1" },
      onDuplicateEntry: () => undefined,
      action,
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_PHASE" });
    expect(action).not.toHaveBeenCalled();
  });

  it.each(["SESSION_INVALID", "NOT_AUTHORIZED", "ROOM_RECOVERING"] as const)("preserves the %s error code in a committed failure receipt", code => {
    const commit = vi.fn();
    const executor = new CommandExecutor(ports({ commit }));
    const result = executor.execute({
      event: "player:setReady",
      payload: { ...basePayload, ready: true },
      owner: "owner",
      boundSession: { roomCode: "ABCDE", playerId: "p_1" },
      onDuplicateEntry: () => undefined,
      action: () => { throw new GameError(code, "Synthetic failure"); },
    });
    expect(result).toEqual({ ok: false, code, error: "Synthetic failure" });
    expect(commit).toHaveBeenCalledWith(expect.any(Set), expect.objectContaining({ result }));
  });

  it("preserves SESSION_INVALID when the socket is not bound to the requested player", () => {
    const action = vi.fn(() => ({}));
    const result = new CommandExecutor(ports()).execute({
      event: "player:setReady",
      payload: { ...basePayload, ready: true },
      owner: "owner",
      boundSession: { roomCode: "ABCDE", playerId: "p_other" },
      onDuplicateEntry: () => undefined,
      action,
    });
    expect(result).toMatchObject({ ok: false, code: "SESSION_INVALID" });
    expect(action).not.toHaveBeenCalled();
  });
});
