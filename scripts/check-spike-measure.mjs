// Does the harness's measurement logic actually report the right number?
//
// A measurement harness that returns a plausible wrong figure is worse than none —
// it is what a seven-week decision would rest on. So the two pure parts (the probe
// shape and the median) are driven against a fake decoder that behaves like
// AVFoundation, at 240 and at 30, before the device ever runs it.

const FAN_OUT = 8;
const PROBE_HALF = 8;

// --- verbatim from the harness -------------------------------------------
async function fanOut(jobs) {
  const out = [];
  for (let i = 0; i < jobs.length; i += FAN_OUT) {
    out.push(...(await Promise.all(jobs.slice(i, i + FAN_OUT).map((j) => j()))));
  }
  return out;
}

async function probeOnce(player, centre, frameDur) {
  const t0 = Date.now();
  const anchor = await player.oneFrame(centre);
  if (anchor === null) return { ms: Date.now() - t0, calls: 1, frames: [] };
  const times = [];
  for (let k = -PROBE_HALF; k <= PROBE_HALF; k += 1) {
    const t = anchor + (k + 0.5) * frameDur;
    if (t > 0) times.push(t);
  }
  const got = await fanOut(times.map((t) => () => player.oneFrame(t)));
  const frames = [...new Set([anchor, ...got.filter((x) => x !== null)])].sort((a, b) => a - b);
  return { ms: Date.now() - t0, calls: 1 + times.length, frames };
}

function medianGap(frames) {
  if (frames.length < 3) return null;
  const d = [];
  for (let i = 1; i < frames.length; i += 1) d.push(frames[i] - frames[i - 1]);
  d.sort((a, b) => a - b);
  const mid = Math.floor(d.length / 2);
  const m = d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
  return m > 0 ? m : null;
}
// --- end verbatim ---------------------------------------------------------

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${got}\n         want ${want}`}`);
};
const near = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${got}\n         want ${want} +/-${tol}`}`);
};

/** A decoder that clamps past-the-end requests to the last frame, as AVFoundation
 *  does, and optionally throttles partway through the clip. */
const fake = (fps, duration, throttleAt = null, throttledFps = null) => {
  const d = 1 / fps;
  return {
    calls: 0,
    async oneFrame(t) {
      this.calls += 1;
      if (!(t >= 0)) return null;
      if (throttleAt !== null && t >= throttleAt) {
        const d2 = 1 / throttledFps;
        const base = Math.floor(throttleAt / d) * d;
        const i = Math.floor((t - base) / d2 + 1e-9);
        return Math.min(duration - d2, base + i * d2);
      }
      const i = Math.min(Math.floor(duration / d) - 1, Math.floor(t / d + 1e-9));
      return i * d;
    },
  };
};

console.log('\n1. a 240fps file reports 240');
{
  const p = fake(240, 3.0);
  const r = await probeOnce(p, 1.0, 1 / 240);
  check('18 calls, the app shape', r.calls, 18);
  check('and 17 distinct frames come back', r.frames.length, 17);
  const fps = 1 / medianGap(r.frames);
  near('the measured rate is 240', fps, 240, 0.5);
}

console.log('\n2. and the same code reports 30 on a 30fps file');
{
  const p = fake(30, 3.0);
  const r = await probeOnce(p, 1.0, 1 / 30);
  check('still 18 calls — the cost does not depend on the rate', r.calls, 18);
  near('the measured rate is 30', 1 / medianGap(r.frames), 30, 0.1);
}

console.log('\n3. A NOMINAL RATE THAT LIES does not become the answer');
{
  // The spike reported nominal 239.467 on a file the camera intended as 240, and
  // nominalFrameRate is an average. Seeded with the wrong figure, the aligned
  // probes drift — but the MEASURED rate must still come off the frames.
  const p = fake(240, 3.0);
  const r = await probeOnce(p, 1.0, 1 / 239.467);
  const fps = 1 / medianGap(r.frames);
  near('measured from the frames, not from the seed', fps, 240, 1);
}

console.log('\n4. THROTTLING SHOWS UP as a lower rate late in the file');
{
  // The failure this exists to catch: the session says 240, the first second is
  // 240, and the phone drops to 120 as it heats.
  const p = fake(240, 60, 30, 120);
  const start = 1 / medianGap((await probeOnce(p, 1.0, 1 / 240)).frames);
  const end = 1 / medianGap((await probeOnce(p, 55.0, 1 / 240)).frames);
  near('the start still reads 240', start, 240, 1);
  near('the end reads 120', end, 120, 1);
  check('so the drop is visible', end < start * 0.9, true);
}

console.log('\n5. THE MEDIAN survives a dropped frame; a mean would not');
{
  const frames = [0, 1 / 240, 2 / 240, 4 / 240, 5 / 240, 6 / 240, 7 / 240];
  const med = 1 / medianGap(frames);
  const gaps = frames.slice(1).map((f, i) => f - frames[i]);
  const mean = 1 / (gaps.reduce((a, b) => a + b, 0) / gaps.length);
  near('median still says 240', med, 240, 0.5);
  check('the mean would have said something lower', mean < 220, true);
}

console.log('\n6. too few frames returns null rather than a made-up number');
{
  check('one frame', medianGap([1]), null);
  check('two frames', medianGap([1, 2]), null);
  check('a dead decoder yields no frames at all', (await probeOnce(fake(240, 3), -5, 1 / 240)).frames.length, 0);
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — the harness measures what it claims to.' : `RESULT: ${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
