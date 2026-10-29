import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../../public/assets/narration/manifest.json";
import { NARRATION_CUES, NARRATION_VOICE } from "../shared/narration";
import { narrationAsset } from "./narrationAssets";

describe("Published offline narration pack", () => {
  it("includes exactly the approved 16 clips, with hash-addressed same-origin URLs", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.voice).toEqual(NARRATION_VOICE);
    expect(manifest.clips.map(clip => clip.id).sort()).toEqual(Object.keys(NARRATION_CUES).sort());
    expect(new Set(manifest.clips.map(clip => clip.sha256)).size).toBe(16);
    for (const id of Object.keys(NARRATION_CUES) as (keyof typeof NARRATION_CUES)[]) {
      const clip = manifest.clips.find(clip => clip.id === id)!;
      expect(clip.file).toBe(id + "." + clip.sha256.slice(0, 12) + ".mp3");
      expect(clip.file).toMatch(/^[a-z-]+\.[a-f0-9]{12}\.mp3$/);
      expect(clip.durationMs).toBeGreaterThan(0);
      expect(clip.durationMs).toBeLessThanOrEqual(NARRATION_CUES[id].maxDurationMs);
      const path = new URL("../../public/assets/narration/" + clip.file, import.meta.url);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      const bytes = readFileSync(path);
      expect(bytes.length).toBe(clip.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(clip.sha256);
      expect(narrationAsset(id)).toEqual({ src: "/assets/narration/" + clip.file, durationMs: clip.durationMs });
    }
  });
});
