import { randomBytes } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { loadEnvFile } from "node:process";

const root = new URL("../../", import.meta.url);
const media = new URL(".media/", root);
const env = new URL("voice.env", media);
await mkdir(media, { recursive: true });
let exists = true;
try { await access(env); } catch { exists = false; }
if (exists) loadEnvFile(env);
const key = process.env.LIVEKIT_API_KEY ?? "avalon_local";
const secret = process.env.LIVEKIT_API_SECRET ?? randomBytes(32).toString("hex");
if (!/^[\w-]+$/.test(key) || !/^[\w-]{32,}$/.test(secret)) throw new Error("Local media credentials must use URL-safe characters.");
await writeFile(env, `LIVEKIT_URL=ws://127.0.0.1:7880\nLIVEKIT_API_URL=http://127.0.0.1:7880\nLIVEKIT_API_KEY=${key}\nLIVEKIT_API_SECRET=${secret}\n`, { mode: 0o600 });
await writeFile(new URL("livekit.yaml", media), `port: 7880\nbind_addresses: [127.0.0.1]\nrtc:\n  enable_loopback_candidate: true\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  ips:\n    includes: [127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16]\nkeys:\n  ${key}: ${secret}\nlogging:\n  level: warn\n`, { mode: 0o600 });
console.log("Local voice configuration created in ignored .media/. No microphone recording is enabled.");
console.log("Start your official LiveKit binary with: livekit-server --config .media/livekit.yaml");
console.log("Signalling is loopback-only. ICE uses private/loopback addresses on TCP 7881 / UDP 7882; do not forward these local test ports to the internet.");
