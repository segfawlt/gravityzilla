// The agent-reported half of the Overview: validated, merged, persisted per conversation.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STANCES = ['fine', 'concern', 'against', 'unsure'];
export const TAKE_MARKS = { fine: '✓', concern: '!', against: '✗', unsure: '?' };
export const STEP_STATES = ['pending', 'in_progress', 'completed'];
const MAX = { wants: 160, label: 16, why: 60, step: 100, steps: 20, agents: 24 };

function str(v, max) {
  if (typeof v !== 'string') return '';
  const trimmed = v.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Validate and normalize `take` strictly (`null` if `stance` or `label` missing/invalid). */
export function readTake(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stance = typeof raw.stance === 'string' && STANCES.includes(raw.stance) ? raw.stance : null;
  const label = str(raw.label, MAX.label);
  if (!stance || !label) return null;
  const why = str(raw.why, MAX.why);
  return { stance, label, why, mark: TAKE_MARKS[stance] };
}

export const enrichTake = readTake;

export function normalizeSteps(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX.steps) break;
    if (typeof item === 'string') {
      const text = str(item, MAX.step);
      if (text) out.push({ text, status: 'pending', agents: [] });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const text = str(item.text, MAX.step);
    if (!text) continue;
    const status = typeof item.status === 'string' && STEP_STATES.includes(item.status) ? item.status : 'pending';
    const agents = Array.isArray(item.agents)
      ? item.agents.map((a) => str(a, MAX.step)).filter(Boolean).slice(0, MAX.agents)
      : [];
    out.push({ text, status, agents });
  }
  return out.length ? out : null;
}

/**
 * Mark 1-based step `now` as `in_progress`, all prior steps `completed`, and
 * uncompleted subsequent steps `pending`.
 */
export function applyNow(steps, now) {
  if (!Array.isArray(steps) || !steps.length || !Number.isInteger(now) || now < 1) return steps;
  const idx = now - 1;
  if (idx >= steps.length) return steps;
  return steps.map((s, i) => ({
    ...s,
    status: i < idx ? 'completed' : i === idx ? 'in_progress' : (s.status === 'completed' ? 'completed' : 'pending'),
  }));
}

export function merge(prev, args, userStep, opts = {}) {
  const options = typeof opts === 'string' ? { nowIso: opts } : (opts || {});
  const nowIso = options.nowIso || new Date().toISOString();
  const prevAnswered = Boolean(options.prevAnswered);

  const sameTurn = Boolean(prev && prev.userStep === userStep);
  const resetForNewReport = Boolean(
    prevAnswered && (str(args?.wants, MAX.wants) || args?.take !== undefined || Array.isArray(args?.steps)),
  );
  const base = sameTurn && !resetForNewReport ? prev : { userStep, wants: '', take: null, steps: [] };

  const next = {
    userStep,
    wants: base.wants || '',
    take: readTake(base.take),
    steps: normalizeSteps(base.steps) || [],
    updatedAt: nowIso,
  };

  const wants = str(args?.wants, MAX.wants);
  if (wants) next.wants = wants;

  const nextTake = readTake(args?.take);
  if (nextTake) next.take = nextTake;

  const steps = normalizeSteps(args?.steps);
  if (steps) next.steps = steps;

  // Tolerate 0-based `now: 0` when sent alongside a fresh `steps` list.
  const effectiveNow = args?.now === 0 && steps ? 1 : args?.now;
  if (Number.isInteger(effectiveNow)) {
    next.steps = applyNow(next.steps, effectiveNow);
  }

  return next;
}

export function readIntent(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeIntent(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}
