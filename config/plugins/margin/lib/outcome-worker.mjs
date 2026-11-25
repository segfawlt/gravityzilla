#!/usr/bin/env node
// Detached background worker classifying finished-turn Outcomes via Flash.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, runEphemeralAgyPrompt } from './agy-worker.mjs';
import { readIntent } from './intent.mjs';
import {
  buildOutcomePrompt,
  extractTurnExecution,
  isOutcomeRunning,
  parseOutcomeReply,
  readOutcomeState,
  writeOutcomeState,
} from './outcome.mjs';
import { intentPath, outcomePath, transcriptPath } from './paths.mjs';
import { readRows, resolveTurnSteps, summarize } from './transcript.mjs';

/**
 * Spawn a detached worker to refine `outcome.json` for a completed turn.
 * Returns `true` if a worker was launched, `false` if skipped/already done/running/disabled.
 */
export function spawnOutcomeWorker(brain, now = Date.now()) {
  if (!brain || process.env.AGY_MARGIN_NO_OUTCOME_WORKER === '1') return false;
  const tp = transcriptPath(brain);
  if (!existsSync(tp)) return false;

  const facts = summarize(readRows(tp), now);
  if (facts.status !== 'done') return false;

  const exec = extractTurnExecution(facts.turnRows, { brain });
  if (exec.finalStep < 0 || !exec.finalReply.trim()) return false;

  const oFile = outcomePath(brain);
  const prev = readOutcomeState(oFile);
  if (prev && prev.userStep === facts.userStep && prev.finalStep === exec.finalStep && !isOutcomeRunning(prev, now)) {
    return false;
  }
  if (
    isOutcomeRunning(prev, now) &&
    prev.targetUserStep === facts.userStep &&
    prev.targetFinalStep === exec.finalStep
  ) {
    return false;
  }

  try {
    writeOutcomeState(oFile, {
      ...(prev || {}),
      running: true,
      failed: false,
      targetUserStep: facts.userStep,
      targetFinalStep: exec.finalStep,
      startedAtMs: now,
      updatedAt: new Date(now).toISOString(),
    });
  } catch {
    return false;
  }

  try {
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [selfPath, '--worker', '--brain', brain], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AGY_HOOK_INTERNAL: '1' },
    });
    child.unref();
    return true;
  } catch {
    try {
      writeOutcomeState(oFile, {
        userStep: facts.userStep,
        finalStep: exec.finalStep,
        kind: '',
        label: '',
        summary: '',
        items: [],
        running: false,
        failed: true,
        targetUserStep: facts.userStep,
        targetFinalStep: exec.finalStep,
        startedAtMs: 0,
        updatedAt: new Date(now).toISOString(),
      });
    } catch {
      // ignore
    }
    return false;
  }
}

/** Run the outcome classifier synchronously for `brain` (used by `--worker` CLI). */
export function runOutcomeWorker(brain, { preMarked = false } = {}) {
  if (!brain || process.env.AGY_MARGIN_NO_OUTCOME_WORKER === '1') return { ok: false, skipped: true };
  const tp = transcriptPath(brain);
  const oFile = outcomePath(brain);
  if (!existsSync(tp)) return { ok: false, skipped: true };

  const now = Date.now();
  const facts = summarize(readRows(tp), now);
  if (facts.status !== 'done') return { ok: false, skipped: true };

  const exec = extractTurnExecution(facts.turnRows, { brain });
  if (exec.finalStep < 0 || !exec.finalReply.trim()) return { ok: false, skipped: true };

  const prev = readOutcomeState(oFile);
  if (prev && prev.userStep === facts.userStep && prev.finalStep === exec.finalStep && !isOutcomeRunning(prev, now)) {
    return { ok: true, skipped: true };
  }
  if (
    !preMarked &&
    isOutcomeRunning(prev, now) &&
    prev.targetUserStep === facts.userStep &&
    prev.targetFinalStep === exec.finalStep
  ) {
    return { ok: true, skipped: true };
  }

  if (!preMarked) {
    writeOutcomeState(oFile, {
      ...(prev || {}),
      running: true,
      failed: false,
      targetUserStep: facts.userStep,
      targetFinalStep: exec.finalStep,
      startedAtMs: now,
      updatedAt: new Date(now).toISOString(),
    });
  }

  const storedIntent = readIntent(intentPath(brain));
  const freshIntent = storedIntent && storedIntent.userStep === facts.userStep ? storedIntent : null;
  const prompt = buildOutcomePrompt({
    ask: facts.ask,
    wants: freshIntent?.wants || '',
    steps: resolveTurnSteps(facts.turnRows, freshIntent),
    exec,
  });

  const res = runEphemeralAgyPrompt({
    prompt,
    guard: 'Do NOT call any tools, read files, or run commands. Reply ONLY with STATUS, LABEL, SUMMARY, and optional "- " lines.',
    model: process.env.AGY_MARGIN_OUTCOME_MODEL || DEFAULT_MODEL,
    logPrefix: 'agy-margin-outcome',
    timeoutSec: 40,
  });

  const parsed = res.ok ? parseOutcomeReply(res.rawText) : { ok: false };
  const doneIso = new Date().toISOString();
  writeOutcomeState(oFile, {
    userStep: facts.userStep,
    finalStep: exec.finalStep,
    kind: parsed.ok ? parsed.kind : '',
    label: parsed.ok ? parsed.label : '',
    summary: parsed.ok ? parsed.summary : '',
    items: parsed.ok ? parsed.items : [],
    running: false,
    failed: !parsed.ok,
    targetUserStep: facts.userStep,
    targetFinalStep: exec.finalStep,
    startedAtMs: 0,
    updatedAt: doneIso,
  });

  return { ok: parsed.ok, error: res.error || '' };
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
    process.stderr.write('usage: outcome-worker.mjs --brain <dir> [--worker|--spawn]\n');
    process.exit(1);
  }
  const absBrain = resolve(brain);
  if (spawnMode) {
    spawnOutcomeWorker(absBrain);
    return;
  }
  runOutcomeWorker(absBrain, { preMarked });
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
