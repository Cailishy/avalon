import { getProposalRejectionThreshold, getRequiredFails, type QuestHistoryEntry } from "../../shared/game";

export interface ProposalVoteDecision {
  accepted: boolean;
  approvals: number;
  rejections: number;
  voteDetails: { playerId: string; approved: boolean }[];
  history: QuestHistoryEntry;
}

export interface MissionDecision {
  questFailed: boolean;
  fails: number;
  requiredFails: number;
  history: QuestHistoryEntry;
}

export function evaluateProposalVote(input: {
  playerCount: number;
  questIndex: number;
  leaderId?: string;
  team: readonly string[];
  votes: ReadonlyMap<string, boolean>;
}): ProposalVoteDecision | null {
  if (input.votes.size !== input.playerCount) return null;

  const voteDetails = [...input.votes.entries()].map(([playerId, approved]) => ({ playerId, approved }));
  const approvals = voteDetails.filter(vote => vote.approved).length;
  const rejections = voteDetails.length - approvals;
  const accepted = rejections < getProposalRejectionThreshold(input.playerCount);

  return {
    accepted,
    approvals,
    rejections,
    voteDetails,
    history: {
      type: "vote",
      quest: input.questIndex + 1,
      leader: input.leaderId,
      team: [...input.team],
      approvals,
      rejections,
      voteDetails,
      result: accepted ? "success" : "fail",
    },
  };
}

export function forcedProposalHistory(input: {
  questIndex: number;
  leaderId?: string;
  team: readonly string[];
}): QuestHistoryEntry {
  return {
    type: "vote",
    quest: input.questIndex + 1,
    leader: input.leaderId,
    team: [...input.team],
    approvals: 0,
    rejections: 0,
    voteDetails: [],
    result: "success",
    forced: true,
  };
}

export function evaluateMission(input: {
  playerCount: number;
  questIndex: number;
  leaderId?: string;
  team: readonly string[];
  missionVotes: ReadonlyMap<string, boolean>;
}): MissionDecision | null {
  if (input.missionVotes.size !== input.team.length) return null;

  const fails = [...input.missionVotes.values()].filter(Boolean).length;
  const requiredFails = getRequiredFails(input.playerCount, input.questIndex);
  const questFailed = fails >= requiredFails;

  return {
    questFailed,
    fails,
    requiredFails,
    history: {
      type: "mission",
      quest: input.questIndex + 1,
      leader: input.leaderId,
      team: [...input.team],
      fails,
      result: questFailed ? "fail" : "success",
    },
  };
}
