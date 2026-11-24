#!/usr/bin/env node
// Detached background worker generating SESSION + TOPIC strictly from user prompts.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, runEphemeralAgyPrompt } from './agy-worker.mjs';
import { ID_RE, topicsPath, transcriptPath } from './paths.mjs';
import {
  applyTopicsReply,
  buildTopicsPrompt,
  isTopicsRunning,
  readAllUserPrompts,
  readTopicsState,
  writeTopicsState,
} from './topics.mjs';

/**
 * Spawn a detached worker to refresh `topics.json` from transcript user prompts.
 * Returns `true` if a new worker was launched, `false` if already fresh/running/disabled.
 */
export function spawnTopicsWorker(brain) {
  if (!brain || process.env.AGY_MARGIN_NO_TOPICS_WORKER === '1') return false;
  const tp = transcriptPath(brain);
  if (!existsSync(tp)) return false;

  const prompts = readAllUserPrompts(tp);
  if (!prompts.length) return false;

  const tFile = topicsPath(brain);
  const prev = readTopicsState(tFile);
  if (prev && prev.at >= prompts.length) return false;
  if (isTopicsRunning(prev) && (prev.targetAt ?? 0) >= prompts.length) return false;

  try {
    writeTopicsState(tFile, {
      at: prev?.at ?? 0,
      summary: prev?.summary ?? '',
      topics: prev?.topics ?? [],
      running: true,
      failed: false,
      targetAt: prompts.length,
      startedAtMs: Date.now(),
      updatedAt: new Date().toISOString(),
    });
  } catch {
    return false;
  }

  try {
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [selfPath, '--worker', '--brain', brain], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, AGY_HOOK_INTERNAL: '1' },
    });
    child.unref();
    return true;
  } catch {
    try {
      writeTopicsState(tFile, {
        at: prev?.at ?? 0,
        summary: prev?.summary ?? '',
        topics: prev?.topics ?? [],
        running: false,
        failed: true,
        targetAt: 0,
        startedAtMs: 0,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // ignore
    }
    return false;
  }
}

/** Run the topic summarizer synchronously for `brain` (used by `--worker` CLI). */
export function runTopicsWorker(brain, { preMarked = false } = {}) {
  if (!brain || process.env.AGY_MARGIN_NO_TOPICS_WORKER === '1') return { ok: false, skipped: true };
  const tp = transcriptPath(brain);
  const tFile = topicsPath(brain);
  if (!existsSync(tp)) return { ok: false, skipped: true };

  const prompts = readAllUserPrompts(tp);
  const prev = readTopicsState(tFile);
  if (!prompts.length) return { ok: false, skipped: true };
  if (prev && prev.at >= prompts.length) {
    if (prev.running) {
      writeTopicsState(tFile, { ...prev, running: false, startedAtMs: 0, targetAt: 0 });
    }
    return { ok: true, skipped: true };
  }
  if (!preMarked && isTopicsRunning(prev) && (prev.targetAt ?? 0) >= prompts.length) {
    return { ok: true, skipped: true };
  }

  const built = buildTopicsPrompt(prompts, prev);
  if (!built) return { ok: false, skipped: true };

  if (!preMarked) {
    writeTopicsState(tFile, {
      at: prev?.at ?? 0,
      summary: prev?.summary ?? '',
      topics: prev?.topics ?? [],
      running: true,
      failed: false,
      targetAt: prompts.length,
      startedAtMs: Date.now(),
      updatedAt: new Date().toISOString(),
    });
  }

  const res = runEphemeralAgyPrompt({
    prompt: built.prompt,
    guard: 'Do NOT call any tools, read files, or run commands. Reply only with the requested session "> " line and "- " topic lines.',
    model: process.env.AGY_MARGIN_TOPICS_MODEL || DEFAULT_MODEL,
    logPrefix: 'agy-margin-topics',
    timeoutSec: 45,
  });

  if (res.error === 'agy_not_found') {
    writeTopicsState(tFile, {
      at: prev?.at ?? 0,
      summary: prev?.summary ?? '',
      topics: prev?.topics ?? [],
      running: false,
      failed: true,
      targetAt: 0,
      startedAtMs: 0,
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, error: 'agy_not_found' };
  }

  const applied = applyTopicsReply(prev, res.rawText, prompts.length, built.mode);
  writeTopicsState(tFile, {
    ...applied.state,
    targetAt: 0,
    startedAtMs: 0,
  });
  return { ok: applied.ok };
}

function main() {
  const args = process.argv.slice(2);
  let brain = '';
  let preMarked = false;
  let spawnMode = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--brain' && args[i + 1]) brain = args[++i];
    else if (args[i] === '--worker') preMarked = true;
    else if (args[i] === '--spawn') spawnMode = true;
  }
  if (!brain) {
    process.stderr.write('usage: topics-worker.mjs --brain <dir> [--worker|--spawn]\n');
    process.exit(1);
  }
  const absBrain = resolve(brain);
  if (!ID_RE.test(basename(absBrain))) {
    // Allow custom test brain paths if transcript exists, just resolve cleanly.
  }
  if (spawnMode) {
    spawnTopicsWorker(absBrain);
    return;
  }
  runTopicsWorker(absBrain, { preMarked });
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}
