/**
 * Calibration utility — measures the mic's ambient noise floor and recommends
 * a silence threshold percentage for the SoX silence effect.
 *
 * Usage (run once before starting Axon to pick the right threshold):
 *   npx ts-node src/utils/calibrate.ts
 *
 * The recommended threshold is written to stdout and can be passed to Axon via:
 *   AXON_SILENCE_THRESHOLD=<value> npm start
 */

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const SOX_PATH = process.env.SOX_PATH ?? 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe';

const RECORD_SECS = 3;

// ── Record a brief silence sample ─────────────────────────────────────────────

function recordSilence(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(
      `[Calibrate] Recording ${RECORD_SECS} s of ambient silence — stay quiet...`,
    );

    const proc = spawn(
      SOX_PATH,
      [
        '-t', 'waveaudio', 'default',
        '-r', '16000', '-c', '1', '-b', '16',
        outPath,
        'trim', '0', String(RECORD_SECS),
      ],
      { shell: false },
    );

    const watchdog = setTimeout(() => {
      proc.kill();
      reject(new Error('SoX timed out during calibration recording'));
    }, (RECORD_SECS + 5) * 1000);

    proc.on('close', (code) => {
      clearTimeout(watchdog);
      if (code !== 0 && code !== null) {
        reject(new Error(`SoX exited with code ${code}`));
      } else {
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
  });
}

// ── Run "sox stat" and parse RMS amplitude ────────────────────────────────────

/**
 * Runs `sox <file> -n stat` and returns the RMS amplitude as a linear ratio
 * in [0, 1].  sox stat writes its report to stderr.
 */
function measureRms(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // "-n" means no output file; "stat" prints audio statistics
    const proc = spawn(SOX_PATH, [filePath, '-n', 'stat'], { shell: false });

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('close', () => {
      const output = Buffer.concat(stderrChunks).toString();

      // Example line: "RMS amplitude:       0.003421"
      const match = output.match(/RMS\s+amplitude[:\s]+([\d.e+-]+)/i);
      if (!match) {
        reject(new Error('Could not parse sox stat output:\n' + output));
        return;
      }

      resolve(parseFloat(match[1]));
    });

    proc.on('error', reject);
  });
}

// ── Main calibration logic ────────────────────────────────────────────────────

/**
 * Records ambient silence, measures the RMS noise floor, and returns a
 * recommended silence threshold string suitable for the SoX silence effect
 * (e.g. "2%").
 *
 * The threshold is set to 3× the noise floor amplitude, clamped to [1%, 10%].
 * This gives comfortable headroom above ambient noise while remaining
 * sensitive enough to detect quiet speech.
 */
export async function calibrate(): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `axon_cal_${Date.now()}.wav`);

  try {
    await recordSilence(tmpFile);
    const rmsAmplitude = await measureRms(tmpFile);

    // Convert linear amplitude to dBFS for display only
    const rmsDb =
      rmsAmplitude > 0 ? 20 * Math.log10(rmsAmplitude) : -Infinity;

    // 3× the noise floor as a percentage, clamped to a sensible range
    const raw = rmsAmplitude * 3 * 100;
    const pct = Math.min(10, Math.max(1, Math.ceil(raw)));
    const threshold = `${pct}%`;

    console.log('[Calibrate] ─────────────────────────────────────────');
    console.log(`[Calibrate] Noise floor RMS      : ${rmsDb.toFixed(1)} dBFS`);
    console.log(
      `[Calibrate] RMS amplitude        : ${(rmsAmplitude * 100).toFixed(3)} %`,
    );
    console.log(`[Calibrate] Recommended threshold: ${threshold}`);
    console.log('[Calibrate] ─────────────────────────────────────────');
    console.log(
      `[Calibrate] Set AXON_SILENCE_THRESHOLD=${threshold} before starting Axon.`,
    );

    return threshold;
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// Allow running directly: npx ts-node src/utils/calibrate.ts
if (require.main === module) {
  calibrate().catch((err) => {
    console.error('[Calibrate] Fatal:', err);
    process.exit(1);
  });
}
