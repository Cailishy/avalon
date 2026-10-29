import { z } from "zod";
import { COMMAND_EVENTS } from "../shared/protocol";

export const receiptSchema = z.strictObject({
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().regex(/^r_[a-f0-9]{32}$/),
  event: z.enum(COMMAND_EVENTS),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().nonnegative(),
  result: z.strictObject({
    ok: z.boolean(), error: z.string().max(1024).optional(), code: z.string().max(64).optional(),
    roomCode: z.string().regex(/^[A-F0-9]{5,8}$/).optional(),
    playerId: z.string().regex(/^p_[a-f0-9]{24}$/).optional(),
    sessionToken: z.string().regex(/^s_[a-f0-9]{24}$/).optional(),
  }),
});
export type CommandReceipt = z.infer<typeof receiptSchema>;
export const RECEIPTS_PER_OWNER = 256;
export const MAX_RECEIPTS = 16384;

export class CommandCapacityError extends Error {
  constructor() { super("操作确认记录已达限额，请稍后再试。"); }
}
