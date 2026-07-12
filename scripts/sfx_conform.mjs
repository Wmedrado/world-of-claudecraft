// Inspect and optionally conform public/audio/sfx to the project standard:
//   MP3, 192 kbps, 44.1 kHz
//   duration < 1 s:  -6 dBFS true peak
//   duration >= 1 s: -14 LUFS
//   channels: mono, except catalog entries flagged stereo (ambience loops)
//   filename: a catalog key, a numbered variant, or a mob subfamily file
//
// Lossless sources always transcode and skip the lossy bitrate floor. Lossy
// sources below 112 kbps are rejected because re-encoding cannot restore them.
//
// The channel and naming rules are advisory by default (they print but do not
// change the exit code) so the shipped library, whose world clips are still
// stereo, does not fail the gate before the one-time re-process. Pass --strict to
// make them fail, and --fix to conform loudness AND downmix in one pass. The full
// standard lives in docs/design/sound_effects.md.
//
// Usage:
//   node scripts/sfx_conform.mjs
//   node scripts/sfx_conform.mjs --strict
//   node scripts/sfx_conform.mjs --fix

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import {
  conformSfxAudio,
  inspectSfxConformance,
  SFX_AUDIO_EXTENSIONS,
} from './sfx/conform_audio.mjs';
import {
  channelProblem,
  expectedChannelsForEntry,
  LOSSLESS_EXTENSIONS,
  MIN_SOURCE_BITRATE,
  TARGET_LUFS,
  TARGET_PEAK_DBFS,
} from './sfx/sfx_conform_rules.mjs';
import { discoverSfxTracks } from './sfx/sfx_manifest_builder.mjs';
import { SFX } from './sfx/sfx_prompts.mjs';

const fix = process.argv.includes('--fix');
const strict = process.argv.includes('--strict');
const sfxDirectory = path.join(process.cwd(), 'public/audio/sfx');
const ffprobePath = ffprobeStatic.path;

const allFiles = existsSync(sfxDirectory)
  ? readdirSync(sfxDirectory)
      .filter((filename) => SFX_AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase()))
      .sort()
  : [];

// Resolve the naming scheme and per-key channel policy from the catalog. Track
// discovery is the same routine the manifest build uses, so a filename the
// runtime would load is exactly a filename recognized here.
const { entries: discoveredEntries, errors: discoveryErrors } = discoverSfxTracks(
  SFX,
  sfxDirectory,
);
const catalogByKey = new Map(SFX.map((entry) => [entry.key, entry]));
const expectedChannelsByFilename = new Map();
const recognizedFilenames = new Set();
for (const entry of Object.values(discoveredEntries)) {
  // A non-catalog entry is a mob subfamily extension: a positional voice, so mono.
  const expected = expectedChannelsForEntry(catalogByKey.get(entry.key));
  for (const track of entry.tracks) {
    recognizedFilenames.add(track.filename);
    expectedChannelsByFilename.set(track.filename, expected);
  }
}

const namingViolations = [];
for (const filename of allFiles) {
  if (!recognizedFilenames.has(filename)) {
    namingViolations.push(
      `${filename}: not a catalog key, numbered variant, or mob subfamily file`,
    );
  }
}
for (const error of discoveryErrors) namingViolations.push(error);

// Select one source per stem. Lossless beats lossy; equally ranked duplicates
// are ambiguous and must be resolved by the author.
const byStem = new Map();
const conflicts = [];
for (const filename of allFiles) {
  const extension = path.extname(filename).toLowerCase();
  const stem = path.basename(filename, extension);
  const existing = byStem.get(stem);
  if (!existing) {
    byStem.set(stem, filename);
    continue;
  }
  const existingExtension = path.extname(existing).toLowerCase();
  const incomingLossless = LOSSLESS_EXTENSIONS.has(extension);
  const existingLossless = LOSSLESS_EXTENSIONS.has(existingExtension);
  if (incomingLossless && !existingLossless) {
    console.log(`  WARN ${stem}: ${filename} (lossless) takes priority over ${existing}`);
    byStem.set(stem, filename);
  } else if (!incomingLossless && existingLossless) {
    console.log(`  WARN ${stem}: ${existing} (lossless) takes priority over ${filename}`);
  } else {
    console.log(`  ERROR ${stem}: ambiguous duplicate (${existing} vs ${filename})`);
    byStem.delete(stem);
    conflicts.push(stem);
  }
}

const files = [...byStem.values()].sort();
let loudnessIssues = 0; // files with a loudness/bitrate/sample-rate problem (always fatal in check mode)
let toConform = 0; // files that need a conform pass (loudness or channel), for the fix summary
let fixed = 0;
let failures = 0;
let rejected = 0;
const channelViolations = []; // advisory unless --strict; reported once, in the summary

for (const filename of files) {
  const file = path.join(sfxDirectory, filename);
  const extension = path.extname(filename).toLowerCase();
  const stem = path.basename(filename, extension);
  const outputFile = path.join(sfxDirectory, `${stem}.mp3`);
  const report = inspectSfxConformance(file, { ffmpegPath, ffprobePath });

  if (report.reject) {
    console.log(
      `  REJECT ${filename}  [${report.bitrate}kbps source, minimum ${MIN_SOURCE_BITRATE}kbps; re-export at 128kbps or higher]`,
    );
    rejected++;
    continue;
  }

  const expectedChannels = expectedChannelsByFilename.get(filename);
  const chProblem = expectedChannels ? channelProblem(report.channels, expectedChannels) : null;
  if (chProblem) channelViolations.push(`${filename}  [${chProblem}]`);

  const loudnessProblems = report.problems;
  if (loudnessProblems.length === 0 && !chProblem) {
    console.log(`  ok   ${filename}`);
    continue;
  }
  if (loudnessProblems.length > 0) loudnessIssues++;
  toConform++;

  const displayProblems = [...loudnessProblems, ...(chProblem ? [chProblem] : [])];
  const normLabel =
    report.normBranch === 'peak' ? `true peak ${TARGET_PEAK_DBFS}dBFS` : `${TARGET_LUFS} LUFS`;

  if (!fix) {
    // Loudness problems fail the check inline; a channel-only mismatch is
    // advisory and is listed once in the summary channel block below.
    if (loudnessProblems.length > 0) {
      console.log(
        `  FAIL ${filename}  [${loudnessProblems.join(', ')}]  (would apply ${normLabel})`,
      );
    }
    continue;
  }

  process.stdout.write(`  fix  ${filename}  [${displayProblems.join(', ')}]  (${normLabel})... `);
  try {
    conformSfxAudio({
      inputFile: file,
      outputFile,
      duration: report.duration,
      peakDb: report.peakDb,
      ffmpegPath,
      channels: expectedChannels ?? null,
    });
    if (file !== outputFile) unlinkSync(file);
    console.log('done');
    fixed++;
  } catch (error) {
    console.log('FAILED');
    console.error(`       ${error.message ?? error}`);
    failures++;
  }
}

console.log('');
if (conflicts.length > 0) {
  console.log(
    `${conflicts.length} key(s) skipped due to ambiguous duplicates: ${conflicts.join(', ')}. Remove one file per key and rerun.`,
  );
}
if (rejected > 0) {
  console.log(
    `${rejected} file(s) rejected: source bitrate below ${MIN_SOURCE_BITRATE}kbps. Re-export from the original source and resubmit.`,
  );
}
if (fix) {
  console.log(
    `${fixed}/${toConform} files conformed. ${files.length - toConform - rejected} already at spec.`,
  );
} else if (loudnessIssues > 0) {
  console.log(
    `${loudnessIssues} file(s) out of loudness/format spec. Run with --fix to conform them.`,
  );
}

if (channelViolations.length > 0 && !fix) {
  const hint = strict ? '' : ' (advisory; pass --strict to fail, or --fix to downmix)';
  console.log('');
  console.log(`Channel policy: ${channelViolations.length} file(s) off standard${hint}:`);
  for (const violation of channelViolations) {
    console.log(`  ${strict ? 'FAIL' : 'WARN'} ${violation}`);
  }
}

if (namingViolations.length > 0) {
  const hint = strict ? '' : ' (advisory; pass --strict to fail)';
  console.log('');
  console.log(`Naming: ${namingViolations.length} file(s) off standard${hint}:`);
  for (const violation of namingViolations) {
    console.log(`  ${strict ? 'FAIL' : 'WARN'} ${violation}`);
  }
}

const strictFailures = strict ? channelViolations.length + namingViolations.length : 0;
if (
  failures > 0 ||
  conflicts.length > 0 ||
  rejected > 0 ||
  (!fix && loudnessIssues > 0) ||
  strictFailures > 0
) {
  process.exitCode = 1;
}
