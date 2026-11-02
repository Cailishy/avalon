import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sourceFiles(root, relative) {
  const directory = path.join(root, relative);
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) return sourceFiles(root, file);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

const rules = [
  {
    label: "server/domain",
    files: ["src/server/domain"],
    forbidden: [/from ["']node:/, /from ["']\.\.\/\.\.\/server/, /from ["']\.\.\/\.\.\/client/, /socket\.io|express|livekit/i],
  },
  {
    label: "server/application",
    files: ["src/server/application"],
    forbidden: [/socket\.io|express|livekit/i, /RoomManager/],
  },
  {
    label: "client/state",
    files: ["src/client/state"],
    forbidden: [/socket\.io|CommandRequests|VoiceChat|GameAudio/, /\bdocument\b|\bwindow\b|localStorage/],
  },
  {
    label: "client/views",
    files: ["src/client/views"],
    forbidden: [/socket\.io|CommandRequests|VoiceChat|GameAudio/, /localStorage|\bdocument\b/],
  },
  {
    label: "server/AI-and-voice",
    files: ["src/server/roomAI.ts", "src/server/voice.ts"],
    forbidden: [/RoomManager/, /Pick<\s*RoomManager/, /ReturnType<\s*RoomManager/],
  },
  {
    label: "server/infrastructure",
    files: ["src/server/infrastructure"],
    forbidden: [/socket\.io|express|livekit/i, /RoomManager/],
  },
];

export function inspectBoundaries(root) {
  const errors = [];
  for (const rule of rules) {
    const files = rule.files.flatMap(file => file.endsWith(".ts") ? [file] : sourceFiles(root, file));
    for (const relative of files) {
      const text = readFileSync(path.join(root, relative), "utf8");
      for (const pattern of rule.forbidden) {
        if (pattern.test(text)) errors.push(`${rule.label}: ${relative} matches ${pattern}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectBoundaries(fileURLToPath(new URL("../../", import.meta.url)));
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Architecture boundaries: OK");
  }
}
