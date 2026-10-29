import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { NARRATION_CUES, NARRATION_VOICE } from "../../src/shared/narration";
import type { NarrationAssetManifest, NarrationCueId } from "../../src/shared/narration";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runFile = promisify(execFile);
const maxFileBytes = 10 * 1024 * 1024;
export const cueEntries = Object.entries(NARRATION_CUES);

export function productionScript(): string {
  return [
    "# 阿瓦隆固定旁白制作清单",
    "",
    `音色：${NARRATION_VOICE.name}`,
    `语言：${NARRATION_VOICE.language}；语速：${NARRATION_VOICE.speed}；音调：${NARRATION_VOICE.pitch}。`,
    NARRATION_VOICE.direction,
    "",
    "以下文件尚待生成。生成时只朗读台词，不朗读文件名、编号或时长。",
    "每句单独导出 MP3，使用对应文件名。先试听，确认后再批量制作。",
    "时长上限包含开头和结尾留白，不能通过拖慢游戏阶段适配超长音频。",
    "",
    "| 文件名 | 固定台词 | 最长时长 |",
    "| --- | --- | --- |",
    ...cueEntries.map(([id, cue]) => `| ${id}.mp3 | ${cue.text} | ${cue.maxDurationMs / 1000} 秒 |`),
    "",
    "免费额度、下载和再分发权限由所用 MiniMax 产品及账号实际条款决定；本工具不调用 API、不登录、不购买额度。",
    "",
  ].join("\n");
}

export async function exportScript(): Promise<string> {
  const directory = join(root, ".media", "narration-production");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "script.md"), productionScript(), "utf8");
  await writeFile(join(directory, "script.json"), JSON.stringify({
    status: "awaiting-generation",
    voice: NARRATION_VOICE,
    cues: cueEntries.map(([id, cue]) => ({ id, file: `${id}.mp3`, ...cue })),
  }, null, 2) + "\n", "utf8");
  await writeFile(join(directory, "lines.txt"), cueEntries.map(([, cue]) => cue.text).join("\n\n") + "\n", "utf8");
  return directory;
}

export function probeDuration(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object") throw new Error("ffprobe returned invalid metadata.");
  const { format, streams } = metadata as { format?: { duration?: unknown }; streams?: unknown };
  if (!Array.isArray(streams) || streams.length !== 1 || streams[0]?.codec_type !== "audio" || streams[0]?.codec_name !== "mp3") {
    throw new Error("Expected one MP3 audio stream and no video or other tracks.");
  }
  const raw = format?.duration;
  const seconds = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Audio duration must be finite and positive.");
  return Math.ceil(seconds * 1000);
}

async function inspectAudio(path: string): Promise<unknown> {
  try {
    const { stdout } = await runFile(process.env.FFPROBE_BIN || "ffprobe", [
      "-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type", "-of", "json", path,
    ], { timeout: 15_000, maxBuffer: 32 * 1024, windowsHide: true });
    return JSON.parse(stdout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("ffprobe is required. Install FFmpeg or set FFPROBE_BIN to its local executable path.", { cause: error });
    }
    throw new Error("Unable to inspect audio. Check the file and ffprobe installation.", { cause: error });
  }
}

export async function verifyNarrationFiles(directory: string, inspect = inspectAudio): Promise<{
  id: string; file: string; bytes: number; durationMs: number; sha256: string;
}[]> {
  const source = resolve(directory);
  const files = [];
  for (const [id, cue] of cueEntries) {
    const path = join(source, `${id}.mp3`);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`Missing narration file: ${id}.mp3`);
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${id}.mp3`);
    if (info.size < 1 || info.size > maxFileBytes) throw new Error(`Invalid audio size: ${id}.mp3`);
    files.push({ id, cue, path, bytes: info.size });
  }
  const verified = [];
  for (const { id, cue, path, bytes } of files) {
    const durationMs = probeDuration(await inspect(path));
    if (durationMs > cue.maxDurationMs) {
      throw new Error(`${id}.mp3 is ${durationMs} ms; maximum is ${cue.maxDurationMs} ms. Shorten the clip, not the game timer.`);
    }
    const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
    verified.push({ id, file: `${id}.mp3`, bytes, durationMs, sha256 });
  }
  return verified;
}

export async function publishNarrationFiles(
  directory: string,
  output = join(root, "public", "assets", "narration"),
  inspect = inspectAudio,
): Promise<NarrationAssetManifest> {
  const verified = await verifyNarrationFiles(directory, inspect);
  const target = resolve(output);
  await mkdir(target, { recursive: true });
  const targetInfo = await lstat(target);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error("Expected a regular narration output directory.");
  const manifest: NarrationAssetManifest = {
    schemaVersion: 1,
    version: createHash("sha256").update(JSON.stringify(verified)).digest("hex").slice(0, 16),
    voice: NARRATION_VOICE,
    clips: verified.map(clip => ({ ...clip, id: clip.id as NarrationCueId, file: `${clip.id}.${clip.sha256.slice(0, 12)}.mp3` })),
  };
  for (const clip of manifest.clips) {
    const contents = await readFile(join(resolve(directory), `${clip.id}.mp3`));
    if (createHash("sha256").update(contents).digest("hex") !== clip.sha256) throw new Error(`Source changed during publication: ${clip.id}.mp3`);
    const path = join(target, clip.file);
    try {
      await writeFile(path, contents, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || createHash("sha256").update(await readFile(path)).digest("hex") !== clip.sha256) {
        throw new Error(`Refusing to overwrite a different published file: ${clip.file}`, { cause: error });
      }
    }
  }
  // Publish the manifest last so a failed copy never selects an incomplete pack.
  const temporary = join(target, `.manifest-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, join(target, "manifest.json"));
  return manifest;
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--export") {
    console.log(`Exported ${cueEntries.length} fixed scripts to ${await exportScript()}`);
    console.log("No audio was generated, no network requests were made, and game playback was not changed.");
  } else if (args.length === 2 && args[0] === "--verify") {
    const results = await verifyNarrationFiles(args[1]);
    console.table(results.map(({ id, durationMs, bytes }) => ({ id, durationMs, bytes })));
    console.log("All files passed format/size/duration checks. Listen to every clip and confirm rights before integrating them.");
  } else if (args.length === 2 && args[0] === "--publish") {
    const manifest = await publishNarrationFiles(args[1]);
    console.log(`Published ${manifest.clips.length} verified local clips, pack ${manifest.version}, to public/assets/narration.`);
    console.log("No TTS service or credentials are used. Audio rights and spoken content still require maintainer review.");
  } else {
    throw new Error("Usage: npm run narration:script | npm run narration:verify -- <directory> | npm run narration:publish -- <directory>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : "Narration preparation failed.");
    process.exitCode = 1;
  });
}
