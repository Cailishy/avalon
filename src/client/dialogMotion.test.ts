import { describe, expect, it } from "vitest";
import { DIALOG_ENTRANCE_MS, DialogMotion } from "./dialogMotion";

describe("Dialog entrances", () => {
  it("animates new views and preserves their elapsed time across renders", () => {
    const motion = new DialogMotion();
    expect(motion.update("角色收藏馆", 1000)).toBe(0);
    expect(motion.update("角色收藏馆", 1100)).toBe(100);
    expect(motion.update("角色收藏馆", 1000 + DIALOG_ENTRANCE_MS)).toBeNull();
    expect(motion.update("角色收藏馆", 3000)).toBeNull();
    expect(motion.update("『梅林』", 3100)).toBe(0);
  });

  it("animates again after closing or switching role cards", () => {
    const motion = new DialogMotion();
    expect(motion.update("『梅林』", 100)).toBe(0);
    expect(motion.update("『刺客』", 200)).toBe(0);
    expect(motion.update(null, 300)).toBeNull();
    expect(motion.update("『刺客』", 400)).toBe(0);
  });

  it("does not restart while controls change within the same view", () => {
    const motion = new DialogMotion();
    motion.update("单机对局", 100);
    expect(motion.update("单机对局", 150)).toBe(50);
    expect(motion.update("单机对局", 1200)).toBeNull();
  });
});
