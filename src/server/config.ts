import path from "node:path";

export interface VoiceConfig {
  url: string;
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface ServerConfig {
  publicMode: boolean;
  origin?: string;
  host: string;
  port: number;
  trustProxy: string[];
  passcode: string;
  voice?: VoiceConfig;
  voiceRequired: boolean;
  roomStorePath: string;
}

export function readConfig(env: NodeJS.ProcessEnv, dev = false): ServerConfig {
  if (env.APP_MODE && !["lan", "public"].includes(env.APP_MODE)) throw new Error("APP_MODE must be lan or public.");
  const publicMode = env.APP_MODE === "public";
  if (env.VOICE_REQUIRED && !["true", "false"].includes(env.VOICE_REQUIRED)) throw new Error("VOICE_REQUIRED must be true or false.");
  const voiceRequired = env.VOICE_REQUIRED === "true";
  const passcode = env.GAME_ACCESS_CODE ?? "";
  if (!passcode.trim() || passcode.length > 128) throw new Error("Set GAME_ACCESS_CODE (1-128 characters).");
  const origin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : undefined;
  if (origin && (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password)) throw new Error("PUBLIC_ORIGIN must be an origin without a path or credentials.");
  if (publicMode && (dev || origin?.protocol !== "https:" || passcode.length < 16 || /^(.)\1+$/.test(passcode) || passcode.includes("replace-with"))) {
    throw new Error("Public mode requires HTTPS PUBLIC_ORIGIN, a private passcode of at least 16 characters, and a production build.");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const roomStorePath = path.resolve(env.ROOM_STORE_PATH ?? "data/rooms.sqlite");
  for (const directory of ["dist", "public"]) {
    const relative = path.relative(path.resolve(directory), roomStorePath);
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("ROOM_STORE_PATH must be outside public assets and dist.");
  }
  const trustProxy = (env.TRUST_PROXY_CIDRS ?? "loopback").split(",").map(value => value.trim()).filter(Boolean);
  if (trustProxy.some(value => ["true", "*", "0.0.0.0/0", "::/0"].includes(value))) throw new Error("TRUST_PROXY_CIDRS must list only the actual reverse proxies.");
  const voiceValues = [env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET];
  if (voiceValues.some(Boolean) && !voiceValues.every(Boolean)) throw new Error("Configure all LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET values.");
  let voice: VoiceConfig | undefined;
  if (voiceValues.every(Boolean)) {
    const url = new URL(env.LIVEKIT_URL!);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("LIVEKIT_URL must be a ws/wss origin.");
    if (publicMode && (url.protocol !== "wss:" || env.LIVEKIT_API_SECRET!.length < 32 || env.LIVEKIT_API_SECRET!.includes("replace-with") || env.LIVEKIT_API_KEY!.includes("replace-with"))) throw new Error("Public voice requires WSS and private LiveKit credentials, with a secret of at least 32 characters.");
    const apiUrl = new URL(env.LIVEKIT_API_URL ?? url.origin.replace(/^ws/, "http"));
    if (!["http:", "https:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) throw new Error("Invalid LIVEKIT_API_URL.");
    voice = { url: url.origin, apiUrl: apiUrl.origin, apiKey: env.LIVEKIT_API_KEY!, apiSecret: env.LIVEKIT_API_SECRET! };
  }
  if (voiceRequired && !voice) throw new Error("Configure LiveKit when VOICE_REQUIRED=true.");
  return { publicMode, origin: origin?.origin, host: env.HOST ?? (publicMode ? "127.0.0.1" : "0.0.0.0"), port, trustProxy, passcode, voice, voiceRequired, roomStorePath };
}
