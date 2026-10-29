import { FACTION_NAMES, ROLE_DEFS } from "../shared/game";

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

export function formatWinnerReason(reason: string): string {
  const assassination = reason.match(/^((?:刺客|『刺客』)(?:命中 |选择了 ))([\s\S]*)(，(?:梅林|『梅林』)(?:阵亡|安全)。)$/);
  if (!assassination) return formatRoleText(reason);
  return formatRoleText(assassination[1]) + assassination[2] + formatRoleText(assassination[3]);
}
