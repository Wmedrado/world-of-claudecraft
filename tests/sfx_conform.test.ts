import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { describe, expect, it } from 'vitest';
// @ts-expect-error scripts use the repository's untyped Node ESM convention
import * as conformAudioModule from '../scripts/sfx/conform_audio.mjs';
import {
  channelProblem,
  classify,
  expectedChannelsForEntry,
  LOSSLESS_EXTENSIONS,
  MIN_SOURCE_BITRATE,
  NORM_TOLERANCE,
  TARGET_BITRATE,
  TARGET_LUFS,
  TARGET_MONO_CHANNELS,
  TARGET_PEAK_DBFS,
  TARGET_SAMPLE_RATE,
  TARGET_STEREO_CHANNELS,
} from '../scripts/sfx/sfx_conform_rules.mjs';
import { SFX } from '../scripts/sfx/sfx_prompts.mjs';

const { buildSfxConformArgs, conformSfxAudio, inspectSfxConformance, measureSfxTruePeakDb } =
  conformAudioModule;

// @ts-expect-error scripts use the repository's untyped Node ESM convention
import { UI_SFX_SPECS } from '../scripts/sfx/ui_sfx.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A file already at every spec dimension.
const AT_SPEC = { duration: 2.0, bitrate: TARGET_BITRATE, sampleRate: TARGET_SAMPLE_RATE };

describe('classify: source quality gate', () => {
  it('rejects a file one kbps below MIN_SOURCE_BITRATE', () => {
    expect(classify({ ...AT_SPEC, bitrate: MIN_SOURCE_BITRATE - 1 }).reject).toBe(true);
  });

  it('does not reject a file at exactly MIN_SOURCE_BITRATE', () => {
    expect(classify({ ...AT_SPEC, bitrate: MIN_SOURCE_BITRATE }).reject).toBe(false);
  });

  it('returns no problems and null normBranch when rejecting', () => {
    const { problems, normBranch } = classify({ ...AT_SPEC, bitrate: 64 });
    expect(problems).toHaveLength(0);
    expect(normBranch).toBeNull();
  });
});

describe('classify: bitrate and sample rate', () => {
  it('passes a file fully at spec', () => {
    const { reject, problems } = classify({ ...AT_SPEC, lufs: TARGET_LUFS });
    expect(reject).toBe(false);
    expect(problems).toHaveLength(0);
  });

  it('flags bitrate below target', () => {
    const { problems } = classify({ ...AT_SPEC, bitrate: 128 });
    expect(problems.some((p) => p.includes('128kbps'))).toBe(true);
  });

  it('flags bitrate significantly above target', () => {
    const { problems } = classify({ ...AT_SPEC, bitrate: 320 });
    expect(problems.some((p) => p.includes('320kbps'))).toBe(true);
  });

  it('does not flag bitrate within the ffprobe tolerance window', () => {
    const { problems } = classify({ ...AT_SPEC, bitrate: TARGET_BITRATE + 4 });
    expect(problems.filter((p) => p.includes('kbps'))).toHaveLength(0);
  });

  it('flags sample rate mismatch', () => {
    const { problems } = classify({ ...AT_SPEC, sampleRate: 48000 });
    expect(problems.some((p) => p.includes('48000Hz'))).toBe(true);
  });
});

describe('classify: normalization branch routing', () => {
  it('routes clips below DURATION_THRESHOLD to peak', () => {
    expect(classify({ ...AT_SPEC, duration: 0.5 }).normBranch).toBe('peak');
  });

  it('routes clips at exactly DURATION_THRESHOLD to lufs', () => {
    expect(classify({ ...AT_SPEC, duration: 1.0 }).normBranch).toBe('lufs');
  });

  it('routes clips above DURATION_THRESHOLD to lufs', () => {
    expect(classify({ ...AT_SPEC, duration: 3.0 }).normBranch).toBe('lufs');
  });
});

describe('shared conform command', () => {
  it('measures and conforms short clips by true peak', () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static is unavailable');
    const directory = mkdtempSync(join(tmpdir(), 'wocc-sfx-true-peak-'));
    const inputFile = join(directory, 'source.wav');
    const outputFile = join(directory, 'output.mp3');

    try {
      // The samples peak at -6 dBFS, but band-limited reconstruction peaks at
      // about -3.9 dBFS. This catches accidental sample-peak measurement.
      execFileSync(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'aevalsrc=0.5*sgn(sin(2*PI*1000*t)):s=44100:d=0.5',
          '-c:a',
          'pcm_f32le',
          inputFile,
        ],
        { stdio: 'ignore' },
      );

      const inputTruePeak = measureSfxTruePeakDb(inputFile, ffmpegPath);
      expect(inputTruePeak).toBeCloseTo(-3.9, 1);

      const result = conformSfxAudio({
        inputFile,
        outputFile,
        duration: 0.5,
        ffmpegPath,
      });
      expect(result.normBranch).toBe('peak');
      expect(result.inputLevel).toBe(inputTruePeak);
      expect(Math.abs(result.outputLevel - TARGET_PEAK_DBFS)).toBeLessThanOrEqual(NORM_TOLERANCE);

      const report = inspectSfxConformance(outputFile, {
        ffmpegPath,
        ffprobePath: ffprobeStatic.path,
      });
      expect(report.peakDb).toBe(result.outputLevel);
      expect(report.problems.filter((problem: string) => problem.includes('dBFS'))).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('builds the fixed peak branch for clips below one second', () => {
    const plan = buildSfxConformArgs({
      inputFile: '/tmp/source.wav',
      outputFile: '/tmp/output.mp3',
      duration: 0.999,
      gainDb: 6,
    });

    expect(plan.normBranch).toBe('peak');
    expect(plan.args[plan.args.indexOf('-af') + 1]).toBe(
      `volume=6dB,aformat=sample_rates=${TARGET_SAMPLE_RATE}`,
    );
    expect(plan.args[plan.args.indexOf('-b:a') + 1]).toBe(`${TARGET_BITRATE}k`);
    expect(plan.args[plan.args.indexOf('-ar') + 1]).toBe(String(TARGET_SAMPLE_RATE));
  });

  it('builds the fixed LUFS branch at exactly one second', () => {
    const plan = buildSfxConformArgs({
      inputFile: '/tmp/source.wav',
      outputFile: '/tmp/output.mp3',
      duration: 1,
      gainDb: 3,
    });

    expect(plan.normBranch).toBe('lufs');
    expect(plan.args[plan.args.indexOf('-af') + 1]).toContain('volume=3dB,alimiter=');
    expect(plan.args[plan.args.indexOf('-af') + 1]).toContain(
      `aformat=sample_rates=${TARGET_SAMPLE_RATE}`,
    );
  });

  it('ships every deterministic UI cue through the fixed conform contract', () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static is unavailable');
    for (const spec of UI_SFX_SPECS) {
      const report = inspectSfxConformance(join(ROOT, 'public/audio/sfx', `${spec.key}.mp3`), {
        ffmpegPath,
        ffprobePath: ffprobeStatic.path,
      });
      expect(report.reject, spec.key).toBe(false);
      expect(report.problems, spec.key).toEqual([]);
      expect(report.sampleRate, spec.key).toBe(TARGET_SAMPLE_RATE);
      expect(report.bitrate, spec.key).toBe(TARGET_BITRATE);
    }
  });
});

describe('classify: loudness gate', () => {
  it('pins sustained masters to -14 LUFS', () => {
    expect(TARGET_LUFS).toBe(-14);
    expect(classify({ ...AT_SPEC, duration: 2, lufs: -14 })).toMatchObject({
      reject: false,
      normBranch: 'lufs',
      problems: [],
    });
  });

  it('flags peak loudness out of spec for short clips', () => {
    const { problems } = classify({ ...AT_SPEC, duration: 0.5, peakDb: TARGET_PEAK_DBFS - 6 });
    expect(problems.some((p) => p.includes('dBFS'))).toBe(true);
  });

  it('does not flag peak loudness within the tolerance window', () => {
    const inSpec = TARGET_PEAK_DBFS + (NORM_TOLERANCE - 0.1);
    const { problems } = classify({ ...AT_SPEC, duration: 0.5, peakDb: inSpec });
    expect(problems.filter((p) => p.includes('dBFS'))).toHaveLength(0);
  });

  it('flags LUFS out of spec for long clips', () => {
    const { problems } = classify({ ...AT_SPEC, lufs: -20.0 });
    expect(problems.some((p) => p.includes('LUFS'))).toBe(true);
  });

  it('does not flag LUFS within the tolerance window', () => {
    const inSpec = TARGET_LUFS + (NORM_TOLERANCE - 0.1);
    const { problems } = classify({ ...AT_SPEC, lufs: inSpec });
    expect(problems.filter((p) => p.includes('LUFS'))).toHaveLength(0);
  });

  it('ignores peakDb for long clips (uses lufs branch)', () => {
    // A bad peak value on a long clip must not surface as a peak problem.
    const { problems } = classify({ ...AT_SPEC, duration: 2.0, peakDb: 0, lufs: TARGET_LUFS });
    expect(problems.filter((p) => p.includes('dBFS'))).toHaveLength(0);
  });

  it('ignores lufs for short clips (uses peak branch)', () => {
    const { problems } = classify({
      ...AT_SPEC,
      duration: 0.5,
      peakDb: TARGET_PEAK_DBFS,
      lufs: -40,
    });
    expect(problems.filter((p) => p.includes('LUFS'))).toHaveLength(0);
  });

  it('does not check loudness when loudness is not provided', () => {
    // If caller passes neither peakDb nor lufs, no loudness problem is reported.
    const { problems } = classify({ ...AT_SPEC });
    expect(problems.filter((p) => p.includes('dBFS') || p.includes('LUFS'))).toHaveLength(0);
  });
});

describe('classify: lossless sources', () => {
  // WAV/FLAC probe at high bitrates that are meaningless for the quality gate.
  const LOSSLESS = {
    duration: 2.0,
    bitrate: 1411,
    sampleRate: TARGET_SAMPLE_RATE,
    isLossless: true,
  };

  it('does not reject lossless sources regardless of bitrate', () => {
    expect(classify(LOSSLESS).reject).toBe(false);
  });

  it('always marks lossless sources for processing (lossless source in problems)', () => {
    const { problems } = classify({ ...LOSSLESS, lufs: TARGET_LUFS });
    expect(problems.some((p) => p.includes('lossless'))).toBe(true);
  });

  it('does not flag lossless bitrate as a kbps problem', () => {
    const { problems } = classify({ ...LOSSLESS, lufs: TARGET_LUFS });
    expect(problems.filter((p) => p.includes('kbps'))).toHaveLength(0);
  });

  it('still checks sample rate for lossless sources', () => {
    const { problems } = classify({ ...LOSSLESS, sampleRate: 48000, lufs: TARGET_LUFS });
    expect(problems.some((p) => p.includes('48000Hz'))).toBe(true);
  });

  it('still checks loudness for lossless sources', () => {
    const { problems } = classify({ ...LOSSLESS, lufs: -20.0 });
    expect(problems.some((p) => p.includes('LUFS'))).toBe(true);
  });

  it('LOSSLESS_EXTENSIONS contains wav, flac, aiff, aif', () => {
    for (const ext of ['.wav', '.flac', '.aiff', '.aif']) {
      expect(LOSSLESS_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it('LOSSLESS_EXTENSIONS does not contain lossy formats', () => {
    for (const ext of ['.mp3', '.ogg', '.opus', '.m4a']) {
      expect(LOSSLESS_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});

describe('channel policy: pure rules', () => {
  it('keeps stereo only for entries flagged stereo', () => {
    expect(expectedChannelsForEntry({ stereo: true })).toBe(TARGET_STEREO_CHANNELS);
    expect(expectedChannelsForEntry({ key: 'foot_grass' })).toBe(TARGET_MONO_CHANNELS);
    expect(expectedChannelsForEntry({ stereo: false })).toBe(TARGET_MONO_CHANNELS);
    expect(expectedChannelsForEntry(undefined)).toBe(TARGET_MONO_CHANNELS);
    expect(expectedChannelsForEntry(null)).toBe(TARGET_MONO_CHANNELS);
  });

  it('names a stereo-where-mono violation', () => {
    expect(channelProblem(TARGET_STEREO_CHANNELS, TARGET_MONO_CHANNELS)).toBe('2ch (want mono)');
  });

  it('names a mono-where-stereo violation', () => {
    expect(channelProblem(TARGET_MONO_CHANNELS, TARGET_STEREO_CHANNELS)).toBe('mono (want stereo)');
  });

  it('reports no problem when channels match policy', () => {
    expect(channelProblem(TARGET_MONO_CHANNELS, TARGET_MONO_CHANNELS)).toBeNull();
    expect(channelProblem(TARGET_STEREO_CHANNELS, TARGET_STEREO_CHANNELS)).toBeNull();
  });

  it('invents no violation from missing channel metadata', () => {
    expect(channelProblem(0, TARGET_MONO_CHANNELS)).toBeNull();
    expect(channelProblem(TARGET_STEREO_CHANNELS, 0)).toBeNull();
  });
});

describe('channel policy: catalog data', () => {
  it('flags exactly the ambience loops as stereo', () => {
    const stereoKeys = SFX.filter((entry) => entry.stereo).map((entry) => entry.key);
    const ambienceLoops = SFX.filter((entry) => entry.loop && entry.key.startsWith('amb_')).map(
      (entry) => entry.key,
    );
    expect(stereoKeys.sort()).toEqual(ambienceLoops.sort());
    expect(stereoKeys.length).toBeGreaterThan(0);
  });

  it('keeps every positional, one-shot, cast, voice, and UI cue mono', () => {
    for (const entry of SFX) {
      if (entry.key.startsWith('amb_')) continue;
      expect(expectedChannelsForEntry(entry), entry.key).toBe(TARGET_MONO_CHANNELS);
    }
  });
});

describe('shared conform command: channel downmix', () => {
  it('adds -ac only when a channel target is given', () => {
    const withChannels = buildSfxConformArgs({
      inputFile: '/tmp/source.wav',
      outputFile: '/tmp/output.mp3',
      duration: 0.5,
      gainDb: 0,
      channels: TARGET_MONO_CHANNELS,
    });
    expect(withChannels.args[withChannels.args.indexOf('-ac') + 1]).toBe(
      String(TARGET_MONO_CHANNELS),
    );
    // -ac is an output remap, placed after -ar and before the encoder.
    expect(withChannels.args.indexOf('-ac')).toBeGreaterThan(withChannels.args.indexOf('-ar'));
    expect(withChannels.args.indexOf('-ac')).toBeLessThan(withChannels.args.indexOf('-codec:a'));

    const withoutChannels = buildSfxConformArgs({
      inputFile: '/tmp/source.wav',
      outputFile: '/tmp/output.mp3',
      duration: 0.5,
      gainDb: 0,
    });
    expect(withoutChannels.args).not.toContain('-ac');
  });

  it('rejects a channel target that is neither mono nor stereo', () => {
    expect(() =>
      buildSfxConformArgs({
        inputFile: '/tmp/source.wav',
        outputFile: '/tmp/output.mp3',
        duration: 0.5,
        gainDb: 0,
        channels: 3,
      }),
    ).toThrow(/channel target/);
  });

  it('downmixes a stereo source to a mono master', () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static is unavailable');
    const directory = mkdtempSync(join(tmpdir(), 'wocc-sfx-downmix-'));
    const inputFile = join(directory, 'stereo.wav');
    const outputFile = join(directory, 'mono.mp3');

    try {
      // Distinct tones per channel guarantee a genuine two-channel source.
      execFileSync(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=44100:duration=0.5',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=660:sample_rate=44100:duration=0.5',
          '-filter_complex',
          '[0:a][1:a]join=inputs=2:channel_layout=stereo[a]',
          '-map',
          '[a]',
          '-c:a',
          'pcm_s16le',
          inputFile,
        ],
        { stdio: 'ignore' },
      );

      const source = inspectSfxConformance(inputFile, {
        ffmpegPath,
        ffprobePath: ffprobeStatic.path,
      });
      expect(source.channels).toBe(TARGET_STEREO_CHANNELS);

      conformSfxAudio({
        inputFile,
        outputFile,
        duration: 0.5,
        ffmpegPath,
        channels: TARGET_MONO_CHANNELS,
      });

      const conformed = inspectSfxConformance(outputFile, {
        ffmpegPath,
        ffprobePath: ffprobeStatic.path,
      });
      expect(conformed.channels).toBe(TARGET_MONO_CHANNELS);
      expect(channelProblem(conformed.channels, TARGET_MONO_CHANNELS)).toBeNull();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
