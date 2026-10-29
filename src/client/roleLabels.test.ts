import { describe, expect, it } from "vitest";
import { ROLE_DEFS, getRoleKnowledge } from "../shared/game";
import { formatRoleKnowledge, formatRoleName, formatRoleText, formatWinnerReason } from "./roleLabels";

describe("Role labels", () => {
  it.each(Object.values(ROLE_DEFS).map(role => role.name))("labels %s without changing the definition", name => {
    expect(formatRoleName(name)).toBe(`『${name}』`);
    expect(Object.values(ROLE_DEFS).some(role => role.name === name)).toBe(true);
  });

  it("handles missing names and already labelled names", () => {
    expect(formatRoleName(null)).toBe("");
    expect(formatRoleName(undefined)).toBe("");
    expect(formatRoleName("")).toBe("");
    expect(formatRoleName("『梅林』")).toBe("『梅林』");
    expect(formatRoleName("Loyal Servant of Arthur")).toBe("『Loyal Servant of Arthur』");
  });

  it("matches full names before aliases and keeps counts outside the label", () => {
    expect(formatRoleText("莫德雷德的爪牙、莫德雷德、亚瑟的忠臣（女性）、亚瑟的忠臣 x2、亚瑟忠臣、忠臣、爪牙"))
      .toBe("『莫德雷德的爪牙』、『莫德雷德』、『亚瑟的忠臣（女性）』、『亚瑟的忠臣』 x2、『亚瑟忠臣』、『忠臣』、『爪牙』");
  });

  it("labels role references in prose without relabelling existing labels or factions", () => {
    const labelled = "守誓者『派西维尔』看到『梅林』和『莫甘娜』；藏锋者『刺客』刺杀『梅林』。";
    expect(formatRoleText("正方派西维尔看到『梅林』和莫甘娜；反方刺客刺杀梅林。")).toBe(labelled);
    expect(formatRoleText(labelled)).toBe(labelled);
  });

  it.each(["merlin", "percival", "assassin"] as const)("protects nicknames in %s knowledge, even when they contain punctuation", role => {
    const players = [
      { id: "self", name: "Player", role },
      { id: "m", name: "梅林。奥伯伦", role: "merlin" as const },
      { id: "g", name: "刺客、忠臣", role: "morgana" as const },
      { id: "x", name: "莫德雷德", role: "assassin" as const },
    ];
    const knowledge = getRoleKnowledge(players[0], players);
    const labelled = formatRoleKnowledge(knowledge);
    const expected = role === "percival"
      ? knowledge.replace("你看到的梅林候选", "你看到的『梅林？』")
      : role === "assassin" ? knowledge.replace(/奥伯伦若在场不会显示。$/, "『奥伯伦』若在场不会显示。") : knowledge;
    expect(labelled).toBe(expected.replace(/反方/g, "藏锋者"));
    expect(formatRoleKnowledge(labelled)).toBe(labelled);
  });

  it("formats knowledge without a player list", () => {
    expect(formatRoleKnowledge("你没有额外初始信息。")).toBe("你没有额外初始信息。");
    expect(formatRoleKnowledge("梅林不会识别莫德雷德。")).toBe("『梅林』不会识别『莫德雷德』。");
  });

  it.each(["梅林候选", "梅林候选人", "『梅林』候选", "『梅林』候选人", "『梅林？』"])("renders uncertain Merlin consistently and idempotently: %s", phrase => {
    expect(formatRoleText(`你看到的是${phrase}。`)).toBe("你看到的是『梅林？』。");
    expect(formatRoleText(formatRoleText(phrase))).toBe("『梅林？』");
  });

  it.each(["你看到的梅林候选：", "你看到的『梅林』候选：", "你看到的『梅林？』："])("preserves literal candidate-like nicknames after prefix %s", prefix => {
    const names = "梅林候选人、正方、反方、梅林。奥伯伦。";
    const result = `你看到的『梅林？』：${names}`;
    expect(formatRoleKnowledge(prefix + names)).toBe(result);
    expect(formatRoleKnowledge(result)).toBe(result);
  });

  it.each([
    ["刺客命中 梅林，梅林阵亡。", "『刺客』命中 梅林，『梅林』阵亡。"],
    ["刺客选择了 刺客，梅林安全。", "『刺客』选择了 刺客，『梅林』安全。"],
    ["刺客命中 莫德雷德，梅林安全。，梅林阵亡。", "『刺客』命中 莫德雷德，梅林安全。，『梅林』阵亡。"],
    ["刺客未在规定时间内选择目标，正方获胜。", "『刺客』未在规定时间内选择目标，守誓者获胜。"],
    ["三个任务失败，反方获胜。", "三个任务失败，藏锋者获胜。"],
  ])("formats result prose while preserving its literal target: %s", (reason, expected) => {
    expect(formatWinnerReason(reason)).toBe(expected);
    expect(formatWinnerReason(expected)).toBe(expected);
  });

  it("preserves faction-like player nicknames in knowledge and assassination results", () => {
    expect(formatRoleKnowledge("你看到的反方玩家：正方、反方、藏锋者、梅林。"))
      .toBe("你看到的藏锋者玩家：正方、反方、藏锋者、梅林。");
    expect(formatRoleKnowledge("你看到的藏锋者玩家：正方、反方、藏锋者、梅林。"))
      .toBe("你看到的藏锋者玩家：正方、反方、藏锋者、梅林。");
    expect(formatWinnerReason("刺客命中 正方反方，梅林阵亡。"))
      .toBe("『刺客』命中 正方反方，『梅林』阵亡。");
  });
});
