import manifest from "../../public/assets/narration/manifest.json";
import type { NarrationCueId } from "../shared/narration";

export function narrationAsset(id: NarrationCueId): { src: string; durationMs: number } {
  const clip = manifest.clips.find(clip => clip.id === id);
  if (!clip) throw new Error(`Missing narration asset: ${id}`);
  return { src: `/assets/narration/${clip.file}`, durationMs: clip.durationMs };
}
