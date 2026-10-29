import { randomBytes } from "node:crypto";
import { isCommand, needsPhase } from "../../src/shared/protocol";

export function commandPayload(event: string, payload: Record<string, unknown>, phaseId?: string): Record<string, unknown> {
  return isCommand(event) ? {
    ...payload,
    requestId: `r_${randomBytes(16).toString("hex")}`,
    issuedAt: Date.now(),
    ...(needsPhase(event) ? { phaseId: phaseId ?? `phase_${"a".repeat(32)}` } : {}),
  } : payload;
}
