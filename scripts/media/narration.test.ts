import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cueEntries, probeDuration, productionScript, publishNarrationFiles, verifyNarrationFiles } from "./narration";

const folders: string[] = [];
const metadata = (duration: unknown = "1.25") => ({ format: { duration }, streams: [{ codec_type: "audio", codec_name: "mp3" }] });

async function fixtures(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "awalong-narration-test-"));
  folders.push(folder);
  for (const [id] of cueEntries) await writeFile(join(folder, `${id}.mp3`), `fixture-${id}`);
  return folder;
}

afterEach(async () => {
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith("awalong-narration-test-")) {
      throw new Error("Refusing to remove an unexpected test directory.");
    }
    await rm(folder, { recursive: true, force: true });
  }
});

describe("Offline narration preparation", () => {
  it("exports only the approved fixed script, with no credentials or runtime requests", () => {
    const text = productionScript();
    expect(text).toContain("Serene Narrator");
    expect(text).toContain("0.9");
    expect(text).toContain("尚待生成");
    expect(text).toContain("不调用 API");
    for (const [id, cue] of cueEntries) {
      expect(text).toContain(`${id}.mp3`);
      expect(text).toContain(cue.text);
    }
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("API_KEY");
  });

  it("uses measured, rounded-up audio duration", () => {
    expect(probeDuration(metadata("1.2501"))).toBe(1_251);
    expect(probeDuration(metadata(1.5))).toBe(1_500);
  });

  it.each(["", "N/A", "Infinity", "NaN", "0", "-1", null, undefined])("rejects invalid duration %s", duration => {
    expect(() => probeDuration({ ...metadata(), format: { duration } })).toThrow("finite and positive");
  });

  it("rejects empty metadata, non-MP3 audio and hidden extra streams", () => {
    expect(() => probeDuration(null)).toThrow("invalid metadata");
    expect(() => probeDuration({})).toThrow("one MP3");
    expect(() => probeDuration({ ...metadata(), streams: [{ codec_type: "audio", codec_name: "aac" }] })).toThrow("one MP3");
    expect(() => probeDuration({ ...metadata(), streams: [...metadata().streams, { codec_type: "video", codec_name: "h264" }] })).toThrow("one MP3");
  });

  it("requires every expected file before probing and never publishes a partial pack", async () => {
    const folder = await fixtures();
    await rm(join(folder, "victory-good.mp3"));
    const inspect = vi.fn();
    await expect(verifyNarrationFiles(folder, inspect)).rejects.toThrow("Missing narration file: victory-good.mp3");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("checks every clip and hashes its content without changing the source files", async () => {
    const folder = await fixtures();
    const inspect = vi.fn(async () => metadata());
    const results = await verifyNarrationFiles(folder, inspect);
    expect(results).toHaveLength(cueEntries.length);
    expect(inspect).toHaveBeenCalledTimes(cueEntries.length);
    for (const entry of results) {
      expect(entry.durationMs).toBe(1_250);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(join(folder, entry.file), "utf8")).toBe(`fixture-${entry.id}`);
    }
  });

  it("rejects a too-long rejection announcement instead of extending the game timer", async () => {
    const folder = await fixtures();
    await expect(verifyNarrationFiles(folder, async path => metadata(path.endsWith("proposal-rejected.mp3") ? "4.501" : "1")))
      .rejects.toThrow("maximum is 4500 ms");
  });

  it("rejects empty files before invoking external programs", async () => {
    const folder = await fixtures();
    await writeFile(join(folder, "game-reveal.mp3"), "");
    const inspect = vi.fn();
    await expect(verifyNarrationFiles(folder, inspect)).rejects.toThrow("Invalid audio size: game-reveal.mp3");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("publishes a complete content-addressed pack and can reproduce it without changing originals", async () => {
    const source = await fixtures();
    const output = join(source, "published");
    const first = await publishNarrationFiles(source, output, async () => metadata());
    expect(first.clips).toHaveLength(16);
    expect(first.version).toMatch(/^[a-f0-9]{16}$/);
    for (const clip of first.clips) {
      expect(clip.file).toBe(`${clip.id}.${clip.sha256.slice(0, 12)}.mp3`);
      expect(await readFile(join(output, clip.file), "utf8")).toBe(`fixture-${clip.id}`);
    }
    expect(JSON.parse(await readFile(join(output, "manifest.json"), "utf8"))).toEqual(first);
    expect(await publishNarrationFiles(source, output, async () => metadata())).toEqual(first);
    expect(await readdir(output)).toHaveLength(17);
  });

  it("does not replace the last manifest when input is incomplete or an existing asset was modified", async () => {
    const source = await fixtures();
    const output = join(source, "published");
    const first = await publishNarrationFiles(source, output, async () => metadata());
    const manifest = await readFile(join(output, "manifest.json"), "utf8");
    await writeFile(join(output, first.clips[0].file), "do-not-overwrite");
    await expect(publishNarrationFiles(source, output, async () => metadata())).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(join(output, first.clips[0].file), "utf8")).toBe("do-not-overwrite");
    expect(await readFile(join(output, "manifest.json"), "utf8")).toBe(manifest);
    await rm(join(source, "victory-good.mp3"));
    await expect(publishNarrationFiles(source, output, async () => metadata())).rejects.toThrow("Missing narration file");
    expect(await readFile(join(output, "manifest.json"), "utf8")).toBe(manifest);
  });
});
