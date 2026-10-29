import { ALIGNMENT_COUNTS, ROLE_DEFS, getRoleCounts, getTeamSize, getRequiredFails, type Side } from "../shared/game";

export function normalizeRoleName(roleName: string): string {
  const baseName = roleName.trim().replace(/\s*x\d+$/i, "");
  if (baseName.includes("忠臣") && baseName.includes("女性")) return "亚瑟的忠臣（女性）";
  if (baseName.includes("忠臣")) return "亚瑟的忠臣";
  if (baseName.includes("爪牙")) return "莫德雷德的爪牙";
  return baseName;
}

export function getAllRoles() {
  const definitions: Array<{ name: string; nameEn: string; side: Side; icon: string; shortDesc: string; abilities: string[]; tips: string }> = [
    {
      name: "梅林",
      nameEn: "Merlin",
      side: "good",
      icon: "🧙",
      shortDesc: "全知的法师",
      abilities: [
        "游戏开始时，梅林会看到所有反方玩家的身份（莫德雷德除外）",
        "梅林必须用智慧暗示正方玩家反方的身份，但不能暴露自己",
        "如果正方完成3个任务，刺客将有机会刺杀梅林",
        "如果梅林被成功刺杀，反方获胜"
      ],
      tips: "梅林需要巧妙地引导队友，既要提供信息又不能太明显而被刺客识破"
    },
    {
      name: "派西维尔",
      nameEn: "Percival",
      side: "good",
      icon: "🛡️",
      shortDesc: "忠诚的骑士",
      abilities: [
        "游戏开始时，派西维尔会看到梅林和莫甘娜",
        "派西维尔需要辨别出谁是真正的梅林，谁是伪装的莫甘娜",
        "派西维尔的主要任务是保护梅林不被刺客识破",
        "派西维尔可以通过观察玩家的投票和发言来判断真假梅林"
      ],
      tips: "仔细观察梅林候选人的行为，真正的梅林会更有洞察力"
    },
    {
      name: "亚瑟的忠臣",
      nameEn: "Loyal Servant of Arthur",
      side: "good",
      icon: "⚔️",
      shortDesc: "普通的正方玩家",
      abilities: [
        "忠臣没有任何特殊信息，不知道任何人的身份",
        "忠臣必须通过逻辑推理和观察来识别反方玩家",
        "忠臣在任务中只能打出成功牌",
        "忠臣需要信任梅林的暗示并配合队友行动"
      ],
      tips: "仔细观察每个人的投票模式和任务结果，用逻辑推理找出反方"
    },
    {
      name: "莫甘娜",
      nameEn: "Morgana",
      side: "evil",
      icon: "🔮",
      shortDesc: "伪装的女巫",
      abilities: [
        "游戏开始时，莫甘娜会看到其他反方玩家（奥伯伦除外）",
        "莫甘娜会在派西维尔眼中显示为梅林候选",
        "莫甘娜需要伪装成梅林来混淆派西维尔的判断",
        "莫甘娜在任务中可以打出失败牌来破坏任务"
      ],
      tips: "模仿梅林的行为模式，让派西维尔无法确定真正的梅林"
    },
    {
      name: "刺客",
      nameEn: "Assassin",
      side: "evil",
      icon: "🗡️",
      shortDesc: "致命的杀手",
      abilities: [
        "游戏开始时，刺客会看到其他反方玩家（奥伯伦除外）",
        "如果正方完成3个任务，刺客获得一次刺杀机会",
        "刺客需要指认一名玩家作为梅林进行刺杀",
        "如果刺杀成功命中梅林，反方立即获胜"
      ],
      tips: "在游戏过程中密切观察谁最像梅林，记住暗示信息的人"
    },
    {
      name: "莫德雷德的爪牙",
      nameEn: "Minion of Mordred",
      side: "evil",
      icon: "🔪",
      shortDesc: "普通的反方玩家",
      abilities: [
        "游戏开始时，爪牙会看到其他反方玩家（奥伯伦除外）",
        "爪牙在任务中可以打出失败牌来破坏任务",
        "爪牙需要配合其他反方玩家行动",
        "爪牙没有特殊技能，是反方的基础角色"
      ],
      tips: "隐藏身份，配合队友破坏任务，避免过早暴露"
    },
    {
      name: "莫德雷德",
      nameEn: "Mordred",
      side: "evil",
      icon: "👑",
      shortDesc: "隐藏的叛徒",
      abilities: [
        "游戏开始时，莫德雷德会看到其他反方玩家（奥伯伦除外）",
        "莫德雷德对梅林不可见，梅林无法识别莫德雷德",
        "莫德雷德在任务中可以打出失败牌",
        "莫德雷德是反方最隐蔽的角色"
      ],
      tips: "利用梅林无法识破你的优势，大胆行动而不被怀疑"
    },
    {
      name: "奥伯伦",
      nameEn: "Oberon",
      side: "evil",
      icon: "👻",
      shortDesc: "孤独的间谍",
      abilities: [
        "游戏开始时，奥伯伦不认识任何反方玩家",
        "其他反方玩家也不知道奥伯伦的身份",
        "奥伯伦在任务中可以打出失败牌",
        "奥伯伦必须独自判断队友并避免暴露"
      ],
      tips: "仔细观察任务结果和投票，猜测其他反方的身份并配合行动"
    }
  ];
  const roles = definitions.map((role, portraitCell) => ({ ...role, portraitCell }));
  const servant = roles.find(r => r.name === "亚瑟的忠臣")!;
  return [...roles, { ...servant, name: "亚瑟的忠臣（女性）", portraitCell: 8 }];
}

export function getRulesByPlayerCount(count: number) {
  const allRoles = getAllRoles();
  const configuredCount = ALIGNMENT_COUNTS[count] ? count : 5;
  const roleCounts = getRoleCounts(configuredCount).sort((a, b) => Number(ROLE_DEFS[b.role].side === "good") - Number(ROLE_DEFS[a.role].side === "good"));
  const roles = roleCounts.map(item => `${normalizeRoleName(ROLE_DEFS[item.role].name)}${item.count > 1 ? ` x${item.count}` : ""}`);
  const roleDetails = roles.map(name => allRoles.find(role => role.name === normalizeRoleName(name))!);
  return { ...ALIGNMENT_COUNTS[configuredCount], roles, roleDetails, quests: Array.from({ length: 5 }, (_, index) => ({ teamSize: getTeamSize(configuredCount, index), failsNeeded: getRequiredFails(configuredCount, index) })) };
}
