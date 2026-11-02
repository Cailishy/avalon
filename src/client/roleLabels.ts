import { FACTION_NAMES, ROLE_DEFS, type RoleKnowledgeInfo, type WinnerDetails } from "../shared/game";

const roleNames = [...new Set([
  ...Object.values(ROLE_DEFS).map(role => role.name),
  "亚瑟的忠臣（女性）", "亚瑟的忠臣", "忠臣", "爪牙",
])].sort((a, b) => b.length - a.length);
const rolePattern = new RegExp(`『[^『』]*』|${roleNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}`, "g");

export function formatRoleName(name: string | null | undefined): string {
  if (!name) return "";
  return name.startsWith("『") && name.endsWith("』") ? name : `『${name}』`;
}

export function formatRoleText(text: string): string {
  return text.replace(/(?:『梅林』|梅林)候选(?:人)?/g, "『梅林？』")
    .replace(rolePattern, formatRoleName).replace(/正方|反方/g, side => FACTION_NAMES[side === "正方" ? "good" : "evil"]);
}

export function formatRoleKnowledge(knowledge: string): string {
  const prefix = knowledge.match(/^(你看到的(?:(?:梅林|『梅林』)候选|『梅林？』)|你看到的(?:反方|藏锋者)玩家|你认识的(?:反方|藏锋者)同伴)：/);
  if (!prefix) return formatRoleText(knowledge);

  // The list between the server's prefix and suffix contains literal player nicknames.
  const suffix = knowledge.match(/。(?:奥伯伦|『奥伯伦』)若在场不会显示。$/)?.[0] ?? "";
  const names = knowledge.slice(prefix[0].length, suffix ? -suffix.length : undefined);
  return formatRoleText(prefix[0]) + names + formatRoleText(suffix);
}

export function formatRoleKnowledgeInfo(info: RoleKnowledgeInfo, players: Array<{ id: string; name: string }>): string {
  const names = info.playerIds.map(id => players.find(player => player.id === id)?.name).filter((name): name is string => Boolean(name));
  if (info.kind === "evilPlayers") return names.length ? `你看到的藏锋者玩家：${names.join("、")}。` : "你没有看到藏锋者玩家。";
  if (info.kind === "merlinCandidates") return `你看到的『梅林？』：${names.join("、")}。`;
  if (info.kind === "evilCompanions") return names.length ? `你认识的藏锋者同伴：${names.join("、")}。『奥伯伦』若在场不会显示。` : "你没有看到其他藏锋者同伴。";
  if (info.kind === "oberon") return "你不认识其他藏锋者，他们也不知道你。";
  return "你没有额外初始信息。";
}

export function formatWinnerReason(reason: string, details?: WinnerDetails): string {
  if (details?.kind === "missionFailure") return "三个任务失败，藏锋者获胜。";
  if (details?.kind === "assassinTimeout") return "刺客未在规定时间内选择目标，守誓者获胜。";
  if (details?.kind === "assassinLeft") return "刺客已离开房间，放弃刺杀，守誓者获胜。";
  const assassination = reason.match(/^((?:刺客|『刺客』)(?:命中 |选择了 ))([\s\S]*)(，(?:梅林|『梅林』)(?:阵亡|安全)。)$/);
  if (!assassination) return formatRoleText(reason);
  return formatRoleText(assassination[1]) + assassination[2] + formatRoleText(assassination[3]);
}
