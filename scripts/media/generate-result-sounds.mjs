import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sampleRate = 44_100;
const duration = 2.2;
const notes = {
  success: [[0, 523.25], [.22, 659.25], [.44, 783.99], [.68, 1046.5]],
  fail: [[0, 261.63], [.28, 207.65], [.58, 174.61]],
};

for (const [result, sequence] of Object.entries(notes)) {
  const frames = Math.floor(sampleRate * duration);
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const time = i / sampleRate;
    let sample = 0;
    for (const [start, frequency] of sequence) {
      for (const [echoDelay, gain] of [[0, 1], [.12, .22], [.24, .1]]) {
        const t = time - start - echoDelay;
        if (t < 0) continue;
        const envelope = Math.min(1, t / .015) * Math.exp(-t * 4.2);
        const tone = Math.sin(2 * Math.PI * frequency * t) + .24 * Math.sin(2 * Math.PI * frequency * 2 * t);
        sample += tone * envelope * gain * .16;
      }
    }
    const fadeOut = Math.min(1, (duration - time) / .18);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample * fadeOut)) * 32767), 44 + i * 2);
  }
  writeFileSync(fileURLToPath(new URL(`../../public/assets/mission-${result}.wav`, import.meta.url)), wav);
  console.log(`generated mission-${result}.wav`);
}
