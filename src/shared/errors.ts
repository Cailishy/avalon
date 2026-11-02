export const ERROR_CODES = [
  "ACCESS_REQUIRED",
  "SESSION_INVALID",
  "ROOM_NOT_FOUND",
  "PLAYER_NOT_FOUND",
  "ROOM_RECOVERING",
  "WRONG_PHASE",
  "NOT_AUTHORIZED",
  "STALE_PHASE",
  "REQUEST_EXPIRED",
  "REQUEST_CONFLICT",
  "RATE_LIMITED",
  "STORAGE_UNAVAILABLE",
  "INVALID_ACTION",
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

export class GameError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "GameError";
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
