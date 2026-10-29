import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { RoomInternal, RoomTimerInternal } from "./roomTypes";

const id = z.string().regex(/^p_[a-f0-9]{24}$/);
const stamp = z.number().int().nonnegative();
const role = z.enum(["merlin", "percival", "servant", "assassin", "morgana", "mordred", "oberon", "minion"]);
const timer = z.strictObject({
  kind: z.enum(["reveal", "team", "vote", "proposalResult", "mission", "missionResult", "speech", "assassin"]),
  label: z.string().max(128), deadline: stamp, durationMs: z.number().int().min(1).max(120000), speakerId: id.optional(),
});
const history = z.strictObject({
  type: z.enum(["vote", "mission"]), quest: z.number().int().min(1).max(5), leader: id.optional(),
  team: z.array(id).min(1).max(10), approvals: z.number().int().min(0).max(10).optional(),
  rejections: z.number().int().min(0).max(10).optional(),
  voteDetails: z.array(z.strictObject({ playerId: id, approved: z.boolean() })).max(10).optional(),
  forced: z.boolean().optional(), fails: z.number().int().min(0).max(10).optional(), result: z.enum(["success", "fail"]).optional(),
});
export const roomSnapshotSchema = z.strictObject({
  version: z.literal(2), phaseId: z.string().regex(/^phase_[a-f0-9]{32}$/), code: z.string().regex(/^[A-F0-9]{5,8}$/), hostId: id,
  phase: z.enum(["lobby", "reveal", "team", "vote", "proposalResult", "mission", "missionResult", "speech", "assassin", "result"]),
  targetPlayerCount: z.number().int().min(5).max(10),
  players: z.array(z.strictObject({
    id, sessionToken: z.string().regex(/^s_[a-f0-9]{24}$/), name: z.string().min(1).max(16),
    isHost: z.boolean(), isAI: z.boolean(), connected: z.boolean(), ready: z.boolean(), position: z.number().int().min(0).max(9),
    role: role.nullable(), servantVariant: z.enum(["male", "female"]).nullable(),
  })).min(1).max(10),
  leaderIndex: z.number().int().min(0).max(9), questIndex: z.number().int().min(0).max(4), rejectCount: z.number().int().min(0).max(9),
  score: z.strictObject({ success: z.number().int().min(0).max(3), fail: z.number().int().min(0).max(3) }),
  proposal: z.array(id).max(10), votes: z.array(z.tuple([id, z.boolean()])).max(10), missionVotes: z.array(z.tuple([id, z.boolean()])).max(10),
  history: z.array(history).max(60), winner: z.enum(["good", "evil"]).nullable(), winnerReason: z.string().max(256),
  timer: timer.nullable(), speechOrder: z.array(id).max(10), speechIndex: z.number().int().min(0).max(10),
  speechNextLeaderIndex: z.number().int().min(0).max(9).nullable(), idleSince: stamp.nullable(), completedAt: stamp.nullable(),
  origin: z.string().max(128).nullable(),
  recovery: z.strictObject({ deadline: stamp, remainingMs: stamp.max(120000), timer: timer.nullable(), expectedPlayerIds: z.array(id).max(10) }).optional(),
}).superRefine((room, ctx) => {
  const ids = new Set(room.players.map(player => player.id));
  const references = [room.hostId, ...room.proposal, ...room.speechOrder, ...room.votes.map(vote => vote[0]), ...room.missionVotes.map(vote => vote[0]), ...(room.recovery?.expectedPlayerIds ?? [])];
  if (ids.size !== room.players.length || references.some(value => !ids.has(value)) || room.leaderIndex >= room.players.length || room.players.length > room.targetPlayerCount) {
    ctx.addIssue({ code: "custom", message: "Invalid room membership." });
  }
  if (room.players.filter(player => player.isHost).length !== 1 || !room.players.some(player => player.isHost && player.id === room.hostId)) {
    ctx.addIssue({ code: "custom", message: "Invalid room host." });
  }
  if (new Set(room.proposal).size !== room.proposal.length || new Set(room.votes.map(vote => vote[0])).size !== room.votes.length || new Set(room.missionVotes.map(vote => vote[0])).size !== room.missionVotes.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate room actions." });
  }
  if (room.phase !== "lobby" && (room.players.length !== room.targetPlayerCount || room.players.some(player => player.role === null))) {
    ctx.addIssue({ code: "custom", message: "Incomplete role allocation." });
  }
  if (!["lobby", "result"].includes(room.phase) && !room.timer && !room.recovery?.timer) {
    ctx.addIssue({ code: "custom", message: "Missing phase timer." });
  }
  const activeTimer = room.recovery?.timer ?? room.timer;
  if ((activeTimer && activeTimer.kind !== room.phase) || room.players.some((player, index) => player.position !== index)) {
    ctx.addIssue({ code: "custom", message: "Invalid room phase or positions." });
  }
});

export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;
export type SavedTimer = Omit<RoomTimerInternal, "timeout">;

export function parseRoomSnapshot(value: unknown): RoomSnapshot {
  if (value && typeof value === "object" && "version" in value && value.version === 1) {
    if ("phaseId" in value) throw new Error("Invalid legacy snapshot.");
    return roomSnapshotSchema.parse({ ...value, version: 2, phaseId: `phase_${randomBytes(16).toString("hex")}` });
  }
  return roomSnapshotSchema.parse(value);
}

function savedTimer(value: RoomTimerInternal | null | undefined): SavedTimer | null {
  if (!value) return null;
  const { timeout: _timeout, ...data } = value;
  return data;
}

export function snapshotRoom(room: RoomInternal, origin: string | null): RoomSnapshot {
  return {
    version: 2, phaseId: room.phaseId, code: room.code, hostId: room.hostId, phase: room.phase, targetPlayerCount: room.targetPlayerCount,
    players: room.players.map(player => ({ ...player })), leaderIndex: room.leaderIndex, questIndex: room.questIndex,
    rejectCount: room.rejectCount, score: { ...room.score }, proposal: [...room.proposal], votes: [...room.votes],
    missionVotes: [...room.missionVotes], history: structuredClone(room.history), winner: room.winner, winnerReason: room.winnerReason,
    timer: savedTimer(room.timer), speechOrder: [...room.speechOrder], speechIndex: room.speechIndex,
    speechNextLeaderIndex: room.speechNextLeaderIndex, idleSince: room.idleSince, completedAt: room.completedAt, origin,
    ...(room.recovery ? { recovery: { deadline: room.recovery.deadline, remainingMs: room.recovery.remainingMs, timer: room.recovery.timer, expectedPlayerIds: [...room.recovery.expectedPlayerIds] } } : {}),
  };
}

export function roomFromSnapshot(snapshot: RoomSnapshot, localUrls: string[]): RoomInternal {
  const { version: _version, origin: _origin, recovery: _recovery, timer: _timer, ...state } = snapshot;
  return { ...structuredClone(state), localUrls, votes: new Map(snapshot.votes), missionVotes: new Map(snapshot.missionVotes), timer: null };
}
