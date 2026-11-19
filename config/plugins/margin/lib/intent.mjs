// The agent-reported half of the Overview: validated, merged, persisted per conversation.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STANCES = ['fine', 'concern', 'against', 'unsure'];
export const TAKE_MARKS = { fine: '✓', concern: '!', against: '✗', unsure: '?' };
export const STEP_STATES = ['pending', 'in_progress', 'completed'];
const MAX = { wants: 400, label: 16, why: 500, step: 200, verdict: 800, steps: 20, agents: 24 };

const str = (v, n) => (typeof v === 'string' ? v.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n) : '');

export function enrichTake(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stance = STANCES.includes(raw.stance) ? raw.stance : 'unsure';
  return {
    stance,
    mark: TAKE_MARKS[stance] || '?',
    label: str(raw.label, MAX.label) || stance,
    why: str(raw.why, MAX.why),
  };
}

export function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return null;
  return steps.slice(0, MAX.steps).map((s) => {
    const o = typeof s === 'string' ? { text: s } : (s ?? {});
    const text = str(o.text ?? o.title, MAX.step);
    const status = STEP_STATES.includes(o.status) ? o.status : 'pending';
    const agents = Array.isArray(o.agents)
      ? o.agents.slice(0, MAX.agents).map((a) => str(a, MAX.step)).filter(Boolean)
      : undefined;
    return agents?.length ? { text, status, agents } : { text, status };
  }).filter((s) => s.text);
}

/**
 * Apply a `now` ping (0-based index; also tolerates `now === steps.length` when the
 * final step is still pending): steps before idx done, step idx in progress, rest pending.
 */
export function applyNow(steps, now) {
  if (!Array.isArray(steps) || !steps.length || !Number.isInteger(now) || now < 0) return steps;
  const idx = now < steps.length
    ? now
    : (now === steps.length && steps[steps.length - 1].status === 'pending' ? steps.length - 1 : -1);
  if (idx < 0) return steps;
  return steps.map((s, i) => ({
    ...s,
    status: i < idx ? 'completed' : i === idx ? 'in_progress' : (s.status === 'completed' ? 'completed' : 'pending'),
  }));
}

/**
 * Merge a tool call into the stored intent for the same user turn. Omitted
 * fields keep their value; a new user turn (`userStep` changed) starts clean.
 */
export function merge(prev, args, userStep, nowIso = new Date().toISOString()) {
  const sameTurn = Boolean(prev && prev.userStep === userStep);
  const base = sameTurn ? prev : { userStep, wants: '', take: null, steps: [], verdict: '' };
  const next = {
    ...base,
    take: base.take ? enrichTake(base.take) : null,
    userStep,
    updatedAt: nowIso,
  };
  const wants = str(args?.wants, MAX.wants);
  if (wants) next.wants = wants;
  if (args?.take && typeof args.take === 'object') {
    next.take = enrichTake(args.take);
  }
  const steps = normalizeSteps(args?.steps);
  if (steps) next.steps = steps;
  if (Number.isInteger(args?.now)) next.steps = applyNow(next.steps, args.now);
  const verdict = str(args?.verdict, MAX.verdict);
  if (verdict) {
    next.verdict = verdict;
    next.steps = next.steps.map((s) => ({ ...s, status: 'completed' }));
  }
  return next;
}

export function readIntent(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (raw && typeof raw === 'object' && raw.take) raw.take = enrichTake(raw.take);
    return raw;
  } catch {
    return null;
  }
}

export function writeIntent(path, intent) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(intent, null, 2));
  renameSync(tmp, path);
}
