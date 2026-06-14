// Generates the three start-sequence cues as 16-bit PCM WAV files.
// Run: node scripts/gen-sounds.mjs  -> assets/sounds/{marks,set,go}.wav
// Distinct ascending tones: marks (D5) < set (G5) < go (C6, sharper/louder).
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SR = 44100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');

function tone(freq, ms, gain = 0.6) {
  const n = Math.round((SR * ms) / 1000);
  const buf = Buffer.alloc(44 + n * 2);
  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  const atk = SR * 0.005; // 5ms attack/release to avoid clicks
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / atk, (n - i) / atk);
    const s = Math.sin((2 * Math.PI * freq * i) / SR) * gain * env;
    buf.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, 44 + i * 2);
  }
  return buf;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'marks.wav'), tone(587, 220, 0.5)); // D5
writeFileSync(join(OUT, 'set.wav'), tone(784, 220, 0.55)); // G5
writeFileSync(join(OUT, 'go.wav'), tone(1047, 160, 0.7)); // C6, sharper
console.log('Wrote marks.wav, set.wav, go.wav to', OUT);
