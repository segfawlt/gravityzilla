// Deterministic + Flash-refined Outcome triage for finished turns.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { transcriptFullPath } from './paths.mjs';
import { readRows, toolCalls, unquote } from './transcript.mjs';

export const OUTCOME_KINDS = ['clear', 'needs_input', 'caveats', 'blocked'];
export const OUTCOME_MARKS = {
  clear: '✓',
  needs_input: '?',
  caveats: '!',
  blocked: '✗',
};
export const OUTCOME_DEFAULT_LABELS = {
  clear: 'clear',
  needs_input: 'needs input',
  caveats: 'caveats',
  blocked: 'blocked',
};
export const OUTCOME_RUNNING_STALE_MS = 60_000;

const EDIT_TOOL_RE = /^(write_file|edit_file|replace_file_content|multi_replace_file_content|write_to_file)$/;
const CHECK_CMD_RE = /\b(test|pytest|vitest|jest|mocha|unittest|check|typecheck|tsc|lint|eslint|ruff|mypy|cargo\s+(?:test|check|clippy|build)|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|typecheck|build)|typecheck|lint|build)|node\s+--test|make\s+test)\b/i;
const EXIT_NONZERO_RE = /Command exited with code (?!0\b)\d+/i;

function clamp(v, max) {
  const s = String(v ?? '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function stripMarkdown(s) {
  return String(s ?? '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCodeBlocks(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, '\n');
}

function rowPathArg(call) {
  const a = call?.args ?? {};
  const v = a.Path ?? a.AbsolutePath ?? a.TargetFile ?? a.file_path ?? a.path;
  const u = unquote(v);
  return typeof u === 'string' && u.trim() ? u.trim() : null;
}

function isResultError(row) {
  if (!row) return false;
  if (row.status === 'ERROR' || row.type === 'ERROR_MESSAGE') return true;
  if (row.type === 'GENERIC' && typeof row.content === 'string' && EXIT_NONZERO_RE.test(row.content)) {
    return true;
  }
  return false;
}

function readFullFinalReply(brain, lastReplyRow) {
  if (!lastReplyRow) return '';
  const truncated = Array.isArray(lastReplyRow.truncated_fields) && lastReplyRow.truncated_fields.includes('content');
  if (truncated && brain) {
    const fullPath = transcriptFullPath(brain);
    if (existsSync(fullPath)) {
      const fullRows = readRows(fullPath);
      const match = fullRows.find(
        (r) => r?.type === 'PLANNER_RESPONSE' && typeof r.step_index === 'number' && r.step_index === lastReplyRow.step_index,
      );
      if (match && typeof match.content === 'string' && match.content.trim()) {
        return match.content;
      }
    }
  }
  return String(lastReplyRow.content ?? '');
}

/** Extract hard execution facts and full final reply text from the current turn. */
export function extractTurnExecution(turnRows, { brain = null } = {}) {
  const rows = Array.isArray(turnRows) ? turnRows : [];
  const lastReplyRow = [...rows]
    .reverse()
    .find((r) => r?.type === 'PLANNER_RESPONSE' && r?.status === 'DONE' && toolCalls(r).length === 0) ?? null;

  const finalStep = lastReplyRow && typeof lastReplyRow.step_index === 'number' ? lastReplyRow.step_index : -1;
  const finalReply = readFullFinalReply(brain, lastReplyRow);

  const editedFiles = [];
  let lastEditIdx = -1;
  let shellRuns = 0;
  let shellErrors = 0;
  let askedQuestion = false;
  let failedCheck = false;
  let unresolvedErrors = false;
  let testCheckPassedAfterLastEdit = false;
  let shellRanAfterLastEdit = false;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.type === 'ERROR_MESSAGE') {
      unresolvedErrors = true;
      continue;
    }
    if (r.type !== 'PLANNER_RESPONSE') continue;

    const calls = toolCalls(r);
    let hasRunCmd = false;
    let hasCheckCmd = false;

    for (const c of calls) {
      const name = String(c?.name ?? '');
      if (EDIT_TOOL_RE.test(name)) {
        lastEditIdx = i;
        testCheckPassedAfterLastEdit = false;
        shellRanAfterLastEdit = false;
        const p = rowPathArg(c);
        if (p && !editedFiles.includes(p)) editedFiles.push(p);
      } else if (name === 'ask_question') {
        askedQuestion = true;
      } else if (name === 'run_command') {
        hasRunCmd = true;
        shellRuns += 1;
        const cmd = String(unquote(c?.args?.CommandLine ?? c?.args?.command ?? '') || '');
        if (CHECK_CMD_RE.test(cmd)) hasCheckCmd = true;
      }
    }

    let stepHasError = r.status === 'ERROR';
    for (let j = i + 1; j < rows.length; j++) {
      const nr = rows[j];
      if (!nr) continue;
      if (nr.type === 'PLANNER_RESPONSE' || (nr.type === 'USER_INPUT' && nr.source === 'USER_EXPLICIT')) break;
      if (isResultError(nr)) stepHasError = true;
    }

    if (hasRunCmd) {
      if (stepHasError) {
        shellErrors += 1;
        if (hasCheckCmd) failedCheck = true;
        unresolvedErrors = true;
      } else {
        if (hasCheckCmd) failedCheck = false;
        unresolvedErrors = false;
        if (lastEditIdx >= 0 && i > lastEditIdx) {
          shellRanAfterLastEdit = true;
          if (hasCheckCmd) testCheckPassedAfterLastEdit = true;
        }
      }
    } else if (stepHasError) {
      unresolvedErrors = true;
    }
  }

  let verifyState = 'none';
  if (failedCheck || (editedFiles.length > 0 && shellErrors > 0 && unresolvedErrors)) {
    verifyState = 'failed';
  } else if (editedFiles.length === 0) {
    verifyState = 'none';
  } else if (testCheckPassedAfterLastEdit) {
    verifyState = 'passed';
  } else if (shellRanAfterLastEdit) {
    verifyState = 'ran';
  } else {
    verifyState = 'unverified';
  }

  const editPart = editedFiles.length
    ? `${editedFiles.length} file${editedFiles.length === 1 ? '' : 's'} edited`
    : '';
  const verifyPart = verifyState === 'failed'
    ? 'check failed'
    : verifyState === 'passed'
      ? 'checks passed'
      : verifyState === 'ran'
        ? 'shell ran'
        : verifyState === 'unverified'
          ? 'no check run'
          : (unresolvedErrors ? 'tool error' : '');
  const evidence = [editPart, verifyPart].filter(Boolean).join(' · ');

  return {
    finalStep,
    finalReply,
    editedFiles,
    editedCount: editedFiles.length,
    shellRuns,
    shellErrors,
    askedQuestion,
    unresolvedErrors,
    verifyState,
    evidence,
  };
}

function extractTldr(prose) {
  const m = /^\s*(?:\*\*TL;DR\*\*|TL;DR)\s*(?:[—–:-]+\s*)?(.*)$/im.exec(prose);
  if (m && m[1]?.trim()) {
    return clamp(stripMarkdown(m[1]), 95);
  }
  for (const rawLine of prose.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line) || /^\|/.test(line)) continue;
    const cleaned = stripMarkdown(line.replace(/^[-•*]\s+/, ''));
    if (!cleaned) continue;
    const firstSentence = cleaned.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? cleaned;
    return clamp(firstSentence, 95);
  }
  return '';
}

function extractNextLine(prose) {
  const m = /^\s*\*\*Next:\*\*\s*(.+)$/im.exec(prose);
  if (!m?.[1]) return '';
  return clamp(stripMarkdown(m[1]), 75);
}

function extractNotCovered(prose) {
  const lines = prose.split('\n');
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\*\*Not covered:\*\*\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    if (m[1]?.trim()) {
      const cleaned = clamp(stripMarkdown(m[1]), 75);
      if (cleaned) items.push(cleaned);
    }
    for (let j = i + 1; j < lines.length && items.length < 3; j++) {
      const sub = lines[j].trim();
      if (!sub) break;
      const bm = /^[-•*]\s+(.+)$/.exec(sub);
      if (!bm) break;
      const cleaned = clamp(stripMarkdown(bm[1]), 75);
      if (cleaned) items.push(cleaned);
    }
    break;
  }
  return items.slice(0, 3);
}

function lastProseLineEndsWithQuestion(prose) {
  const lines = prose
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*_]{3,}$/.test(l));
  if (!lines.length) return false;
  const last = stripMarkdown(lines[lines.length - 1]);
  return /\?["'”’)]*$/.test(last);
}

/** Deterministic instant Outcome classification from turn execution + final reply markers. */
export function buildHeuristicOutcome(exec, { take = null } = {}) {
  const prose = stripCodeBlocks(exec?.finalReply || '');
  const tldr = extractTldr(prose);
  const nextLine = extractNextLine(prose);
  const notCovered = extractNotCovered(prose);

  const hasDecision =
    /(?:^|\n)#{1,4}\s*Decision\b/i.test(prose) ||
    /(?:^|\n)\*\*Decision\b/i.test(prose) ||
    /\|\s*\*\*#\*\*\s*\|\s*\*\*option\*\*\s*\|/i.test(prose);
  const endsWithQuestion = lastProseLineEndsWithQuestion(prose);
  const hasUnverifiedMention = /\bunverified\b/i.test(prose);
  const hasBlockerMention = /\b(blocked|cannot proceed|missing credentials?|permission denied|could not complete)\b/i.test(prose);

  let kind = 'clear';
  if (exec.verifyState === 'failed' || (exec.unresolvedErrors && hasBlockerMention)) {
    kind = 'blocked';
  } else if (Boolean(nextLine) || hasDecision || exec.askedQuestion || endsWithQuestion) {
    kind = 'needs_input';
  } else if (
    notCovered.length > 0 ||
    exec.verifyState === 'unverified' ||
    hasUnverifiedMention ||
    exec.unresolvedErrors
  ) {
    kind = 'caveats';
  } else if (take?.stance === 'against' && exec.editedCount === 0 && !tldr) {
    kind = 'needs_input';
  }

  const items = [];
  if (nextLine) items.push(nextLine);
  for (const nc of notCovered) {
    if (!items.includes(nc)) items.push(nc);
  }
  const boundedItems = items.slice(0, 3);

  let label = OUTCOME_DEFAULT_LABELS[kind];
  if (kind === 'blocked' && exec.verifyState === 'failed') label = 'check failed';
  else if (kind === 'caveats' && exec.verifyState === 'unverified' && !notCovered.length) label = 'unverified';

  const summary = tldr || (exec.finalReply.trim() ? '' : (exec.evidence || ''));

  return {
    kind,
    mark: OUTCOME_MARKS[kind],
    label,
    summary,
    items: boundedItems,
    evidence: exec.evidence || '',
    verifyState: exec.verifyState || 'none',
    source: 'heuristic',
  };
}

/** Build a compact turn bundle (~1-3k tokens) for the detached Flash classifier. */
export function buildOutcomePrompt({ ask = '', wants = '', steps = [], exec }) {
  const reqText = clamp(wants || ask, 300) || '(none)';
  const stepLines = Array.isArray(steps) && steps.length
    ? steps.slice(0, 8).map((s, i) => `${i + 1}. [${s.status || 'pending'}] ${clamp(s.text, 120)}`).join('\n')
    : '(none)';

  const editedNames = (exec?.editedFiles || []).slice(0, 5).map((p) => basename(p) || p);
  const editedDesc = exec?.editedCount
    ? `${exec.editedCount} (${editedNames.join(', ')}${exec.editedCount > 5 ? ', …' : ''})`
    : '0';

  const rawReply = String(exec?.finalReply || '').trim();
  const replyText = rawReply.length > 7000
    ? `${rawReply.slice(0, 4500)}\n[...]\n${rawReply.slice(-2500)}`
    : rawReply;

  return [
    'Classify finished turn so user knows immediately whether to archive or act.',
    '',
    'Reply ONLY in this exact format (no extra commentary):',
    'STATUS: clear | needs_input | caveats | blocked',
    'LABEL: 1-2 words, max 16 chars (e.g. "clear", "needs input", "caveats", "check failed")',
    'SUMMARY: telegraphic fragment, max 65 chars (~5-9 words), drop articles (a/an/the) and filler',
    '- optional short bullet (0 to 3 lines, max 55 chars each, terse fragment) ONLY for pending decisions, out-of-scope findings, unverified gaps, or blockers',
    '',
    'Rules:',
    '- Pick needs_input if agent asks a question, offers options, or waits for approval.',
    '- Pick caveats if task finished with out-of-scope findings, skipped/unrun checks, or caveats.',
    '- Pick blocked if work failed, check failed, or unresolved blocker stopped completion.',
    '- Pick clear ONLY if work finished cleanly with nothing left for user.',
    '- Ultra-terse telegraphic plain words: drop articles and filler, keep negations exact; avoid code jargon, symbol names, file paths, and acronyms unless user used them.',
    '- Write in the language the user writes in.',
    '',
    `Request: ${reqText}`,
    'Planned steps:',
    stepLines,
    'Execution facts:',
    `- edited_files: ${editedDesc}`,
    `- shell_runs: ${exec?.shellRuns ?? 0}, shell_errors: ${exec?.shellErrors ?? 0}, verify_state: ${exec?.verifyState || 'none'}, asked_question: ${Boolean(exec?.askedQuestion)}`,
    '',
    'Final reply:',
    replyText,
  ].join('\n');
}

/** Parse Flash classifier reply into `{ ok, kind, label, summary, items }`. */
export function parseOutcomeReply(rawText) {
  const lines = String(rawText ?? '').split('\n');
  let kind = '';
  let label = '';
  let summary = '';
  const items = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sm = /^(?:[-*]\s*)?STATUS:\s*(.+)$/i.exec(trimmed);
    if (sm) {
      kind = sm[1].trim().toLowerCase().replace(/[\s-]+/g, '_');
      continue;
    }
    const lm = /^(?:[-*]\s*)?LABEL:\s*(.+)$/i.exec(trimmed);
    if (lm) {
      label = clamp(stripMarkdown(lm[1]), 18);
      continue;
    }
    const sumM = /^(?:[-*]\s*)?SUMMARY:\s*(.+)$/i.exec(trimmed);
    if (sumM) {
      summary = clamp(stripMarkdown(sumM[1]), 100);
      continue;
    }
    const bm = /^[-•*]\s+(.+)$/.exec(trimmed);
    if (bm && items.length < 3) {
      const item = clamp(stripMarkdown(bm[1]), 85);
      if (item) items.push(item);
    }
  }

  if (!OUTCOME_KINDS.includes(kind) || !summary) {
    return { ok: false };
  }

  return {
    ok: true,
    kind,
    label: label || OUTCOME_DEFAULT_LABELS[kind],
    summary,
    items,
  };
}

export function isOutcomeRunning(state, nowMs = Date.now()) {
  if (!state?.running) return false;
  if (!state.startedAtMs || typeof state.startedAtMs !== 'number') return false;
  return nowMs - state.startedAtMs >= 0 && nowMs - state.startedAtMs < OUTCOME_RUNNING_STALE_MS;
}

export function readOutcomeState(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      userStep: Number.isInteger(raw.userStep) ? raw.userStep : -1,
      finalStep: Number.isInteger(raw.finalStep) ? raw.finalStep : -1,
      kind: typeof raw.kind === 'string' && OUTCOME_KINDS.includes(raw.kind) ? raw.kind : '',
      label: typeof raw.label === 'string' ? clamp(raw.label, 18) : '',
      summary: typeof raw.summary === 'string' ? clamp(raw.summary, 100) : '',
      items: Array.isArray(raw.items) ? raw.items.map((x) => clamp(x, 85)).filter(Boolean).slice(0, 3) : [],
      running: Boolean(raw.running),
      failed: Boolean(raw.failed),
      targetUserStep: Number.isInteger(raw.targetUserStep) ? raw.targetUserStep : -1,
      targetFinalStep: Number.isInteger(raw.targetFinalStep) ? raw.targetFinalStep : -1,
      startedAtMs: typeof raw.startedAtMs === 'number' ? raw.startedAtMs : 0,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function writeOutcomeState(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

/** Merge Flash outcome over instant heuristic, enforcing hard execution evidence guardrails. */
export function mergeOutcome({ heuristic, stored, userStep, finalStep, exec, now = Date.now() }) {
  const sameResult = Boolean(
    stored &&
    stored.userStep === userStep &&
    stored.finalStep === finalStep &&
    stored.kind &&
    OUTCOME_KINDS.includes(stored.kind),
  );
  const running = Boolean(
    stored &&
    stored.targetUserStep === userStep &&
    stored.targetFinalStep === finalStep &&
    isOutcomeRunning(stored, now),
  );
  const failed = Boolean(
    stored &&
    stored.targetUserStep === userStep &&
    stored.targetFinalStep === finalStep &&
    stored.failed &&
    !running &&
    !sameResult,
  );

  let kind = sameResult ? stored.kind : heuristic.kind;
  let label = sameResult ? (stored.label || OUTCOME_DEFAULT_LABELS[kind]) : heuristic.label;
  const summary = sameResult ? (stored.summary || heuristic.summary || '') : (heuristic.summary || '');
  const items = sameResult ? (Array.isArray(stored.items) ? stored.items : []) : (heuristic.items || []);
  const source = sameResult ? 'worker' : 'heuristic';

  // Hard evidence guardrails: never allow a false-green `clear` over failed/unverified checks or asked questions.
  if (exec.verifyState === 'failed' && (kind === 'clear' || kind === 'caveats')) {
    kind = 'blocked';
    label = 'check failed';
  } else if (exec.verifyState === 'unverified' && kind === 'clear') {
    kind = 'caveats';
    label = 'unverified';
  } else if (exec.askedQuestion && kind === 'clear') {
    kind = 'needs_input';
    label = 'needs input';
  }

  const mark = OUTCOME_MARKS[kind];
  const archiveSafe = Boolean(
    kind === 'clear' &&
    exec.verifyState !== 'failed' &&
    exec.verifyState !== 'unverified' &&
    !exec.unresolvedErrors,
  );

  return {
    kind,
    mark,
    label,
    summary,
    items,
    evidence: exec.evidence || '',
    verifyState: exec.verifyState || 'none',
    source,
    running,
    failed,
    archiveSafe,
  };
}
