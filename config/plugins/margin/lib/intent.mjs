// The agent-reported half of the Overview: validated, merged, persisted per conversation.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STANCES = ['fine', 'concern', 'against', 'unsure'];
export const STEP_STATES = ['pending', 'in_progress', 'completed'];
const MAX = { wants: 400, label: 16, why: 500, step: 200, verdict: 800, steps: 20 };

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return null;
  return steps.slice(0, MAX.steps).map((s) => {
    const o = typeof s === 'string' ? { text: s } : (s ?? {});
    return { text: str(o.text, MAX.step), status: STEP_STATES.includes(o.status) ? o.status : 'pending' };
  }).filter((s) => s.text);
}

/** Apply a `now` ping: steps before n done, step n in progress, rest pending (when not completed). */
export function applyNow(steps, now) {
  if (!Number.isInteger(now) || now < 0) return steps;
  return steps.map((s, i) => ({ ...s, status: i < now ? 'completed' : i === now ? 'in_progress' : (s.status === 'completed' ? 'completed' : 'pending') }));
}

/**
 * Merge a tool call into the stored intent for the same user turn. Omitted
 * fields keep their value; a new user turn (`userStep` changed) starts clean.
 */
export function merge(prev, args, userStep, nowIso = new Date().toISOString()) {
  const base = prev && prev.userStep === userStep ? prev : { userStep, wants: '', take: null, steps: [], verdict: '' };
  const next = { ...base, userStep, updatedAt: nowIso };
  const wants = str(args.wants, MAX.wants);
  if (wants) next.wants = wants;
  if (args.take && typeof args.take === 'object') {
    const stance = STANCES.includes(args.take.stance) ? args.take.stance : 'unsure';
    next.take = { stance, label: str(args.take.label, MAX.label) || stance, why: str(args.take.why, MAX.why) };
  }
  const steps = normalizeSteps(args.steps);
  if (steps) next.steps = steps;
  if (Number.isInteger(args.now)) next.steps = applyNow(next.steps, args.now);
  const verdict = str(args.verdict, MAX.verdict);
  if (verdict) {
    next.verdict = verdict;
    next.steps = next.steps.map((s) => ({ ...s, status: 'completed' }));
  }
  return next;
}

export function readIntent(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

export function writeIntent(path, intent) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(intent, null, 2));
  renameSync(tmp, path);
}
