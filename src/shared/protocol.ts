export const PROTOCOL_VERSION = 2;
export const COMMAND_TTL_MS = 10 * 60_000;
export const COMMAND_EVENTS = [
  "room:create", "room:join", "room:addAI", "room:setPlayerCount", "player:setReady",
  "room:start", "player:kick", "room:dissolve", "room:restart", "room:leave",
  "team:propose", "vote:submit", "mission:submit", "assassin:choose", "speech:end",
] as const;
export type CommandEvent = typeof COMMAND_EVENTS[number];
const commands = new Set<string>(COMMAND_EVENTS);
const unscoped = new Set<string>(["room:create", "room:join", "room:leave", "room:dissolve"]);
export const isCommand = (event: string): event is CommandEvent => commands.has(event);
export const needsPhase = (event: string): boolean => isCommand(event) && !unscoped.has(event);

export interface CommandMeta {
  requestId: string;
  issuedAt: number;
  phaseId?: string;
}

export interface GameAck {
  ok: boolean;
  error?: string;
  code?: string;
  roomCode?: string;
  playerId?: string;
  sessionToken?: string;
}

export interface ClockReply {
  ok: boolean;
  protocolVersion: number;
  serverReceivedAt: number;
  serverSentAt: number;
}

export interface CommandStatusReply extends GameAck { result?: GameAck | null }
