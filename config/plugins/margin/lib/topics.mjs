// Prompt-only SESSION + TOPIC summarization (1:1 with claudzilla Margin Overview).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readRows, stripUserText } from './transcript.mjs';

export const MAX_PROMPTS = 250;
export const OVERVIEW_CAP = 30;
export const MERGE_TO = 20;
export const RUNNING_STALE_MS = 90_000;

export const PROMPTS_ARE =
  'These are the prompts a user sent in one coding-assistant chat, oldest first.';
export const SESSION_LINE =
  'Reply with one line starting "> ": whole session goal as a telegraphic fragment of at most 8 words (drop articles a/an/the and filler), with no file names, code symbols, branches, PR numbers, or step details,';
export const ASK_LINE =
  'then one line starting "= ": what the newest prompt asks for in 3 to 8 telegraphic plain words (at most 60 chars, drop articles a/an/the and filler, no file names or code symbols unless user wrote them),';
export const PLAIN_STYLE =
  'Ultra-terse telegraphic plain words: drop articles (a/an/the) and filler; no code jargon, symbol names, file paths, or acronyms unless user used them.';
export const IN_LANGUAGE = 'Write them in the language the user writes in.';

export const OVERVIEW_ASK = [
  PROMPTS_ARE,
  'Group them into topics: pieces of work covered, oldest first, newest last.',
  SESSION_LINE,
  ASK_LINE,
  'then only topics, one per line, each starting "- ", at most 5 words.',
  PLAIN_STYLE,
  IN_LANGUAGE,
].join(' ');

export const LATEST_ASK = [
  PROMPTS_ARE,
  SESSION_LINE,
  ASK_LINE,
  'then the last topic: reworded to fit newest prompts, or kept word for word',
  'and followed by a new last topic when they start a different piece of work, so one or two lines each starting "- ", at most 5 words.',
  PLAIN_STYLE,
  IN_LANGUAGE,
].join(' ');

export const OVERVIEW_KEEP = [
  'Topics are pieces of work, not one-off questions or tool checks.',
  'Current topics, shown to the user, oldest first; all but the last stay as they are:',
].join(' ');

export const SESSION_KEEP =
  'Current session line, shown to the user: keep it word for word unless the newest prompts change what the whole session is about; then write a new one:';

export const overviewMerge = (count) =>
  [
    'Topics are pieces of work, not one-off questions or tool checks.',
    `There are ${count} current topics, shown to the user; the reply must have at most ${MERGE_TO} lines,`,
    'so combine the most closely related topics into fewer lines, keep the newest few lines word for word, in order,',
    'and reword the last to fit the newest prompts or add a new last topic when they start a different piece of work:',
  ].join(' ');

export function flat(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Extract chronological user prompt texts (`USER_INPUT` + `USER_EXPLICIT`) and the last explicit step_index. */
export function extractUserPromptsWithSteps(rows) {
  if (!Array.isArray(rows)) return { prompts: [], lastUserStep: -1 };
  const prompts = [];
  let lastUserStep = -1;
  for (const r of rows) {
    if (r?.type !== 'USER_INPUT' || r?.source !== 'USER_EXPLICIT') continue;
    if (Number.isInteger(r.step_index)) lastUserStep = r.step_index;
    const cleaned = flat(stripUserText(r.content ?? ''));
    if (cleaned) prompts.push(cleaned);
  }
  return { prompts, lastUserStep };
}

/** Extract chronological user prompt texts (`USER_INPUT` + `USER_EXPLICIT`) from transcript rows. */
export function extractUserPrompts(rows) {
  return extractUserPromptsWithSteps(rows).prompts;
}

export function readUserPromptsWithSteps(transcriptFile) {
  return extractUserPromptsWithSteps(readRows(transcriptFile));
}

export function readAllUserPrompts(transcriptFile) {
  return extractUserPrompts(readRows(transcriptFile));
}

export const parseTopics = (text) =>
  String(text ?? '')
    .split('\n')
    .flatMap((line) => {
      const m = /^\s*[-•*]\s+(.+)$/.exec(line);
      return m ? [m[1].trim()] : [];
    });

export const parseSummary = (text) =>
  /^[ \t]*>[ \t]+(\S.*)$/m.exec(String(text ?? ''))?.[1]?.trim() ?? '';

const MAX_ASK_CHARS = 160;
export function parseAsk(text) {
  const m = /^[ \t]*=[ \t]+(\S.*)$/m.exec(String(text ?? ''));
  if (!m) return '';
  const cleaned = flat(m[1]).replace(/^["']|["']$/g, '').trim();
  if (!cleaned) return '';
  return cleaned.length > MAX_ASK_CHARS ? `${cleaned.slice(0, MAX_ASK_CHARS - 1)}…` : cleaned;
}

export const keptTopics = (shown, topics) =>
  Array.isArray(topics) &&
  topics.length <= MERGE_TO &&
  (Array.isArray(shown) ? shown : []).slice(-4, -1).every((topic) => topics.includes(topic));

export function isTopicsRunning(state, nowMs = Date.now()) {
  if (!state?.running) return false;
  if (!state.startedAtMs || typeof state.startedAtMs !== 'number') return false;
  return nowMs - state.startedAtMs >= 0 && nowMs - state.startedAtMs < RUNNING_STALE_MS;
}

/**
 * Build the summarization/incremental/merge prompt matching claudzilla's Overview rules.
 * Returns `{ prompt, mode: { incremental, merge } }`, or `null` if no prompts exist.
 */
export function buildTopicsPrompt(prompts, prevState = null) {
  if (!Array.isArray(prompts) || !prompts.length) return null;
  const total = prompts.length;
  const prevAt = Number.isInteger(prevState?.at) ? prevState.at : 0;
  const prevTopics = Array.isArray(prevState?.topics) ? prevState.topics.filter(Boolean) : [];
  const prevSummary = typeof prevState?.summary === 'string' ? prevState.summary.trim() : '';

  const isIncremental = prevTopics.length > 0 && prevAt > 0 && prevAt < total;
  if (isIncremental) {
    const newPrompts = prompts.slice(prevAt).slice(-MAX_PROMPTS);
    const needMerge = prevTopics.length >= OVERVIEW_CAP;
    const parts = [
      LATEST_ASK,
      '',
      SESSION_KEEP,
      prevSummary ? `> ${prevSummary}` : '> (none yet)',
      '',
      needMerge ? overviewMerge(prevTopics.length) : OVERVIEW_KEEP,
      ...prevTopics.map((t) => `- ${t}`),
      '',
      'Newest prompts:',
      ...newPrompts.map((p, i) => `${prevAt + i + 1}. ${flat(p)}`),
    ];
    return {
      prompt: parts.join('\n'),
      mode: { incremental: true, merge: needMerge },
    };
  }

  const windowed = prompts.slice(-MAX_PROMPTS);
  const startIdx = total - windowed.length;
  const parts = [
    OVERVIEW_ASK,
    '',
    ...windowed.map((p, i) => `${startIdx + i + 1}. ${flat(p)}`),
  ];
  return {
    prompt: parts.join('\n'),
    mode: { incremental: false, merge: false },
  };
}

/**
 * Merge a model reply into persistent topics state.
 * Mirrors claudzilla's incremental tail replacement vs full/merged topic list.
 */
export function applyTopicsReply(
  prevState,
  rawText,
  promptCount,
  mode = {},
  nowIso = new Date().toISOString(),
  lastUserStep = undefined,
) {
  const prev = prevState && typeof prevState === 'object' ? prevState : {};
  const prevTopics = Array.isArray(prev.topics) ? prev.topics.filter(Boolean) : [];
  const resolvedUserStep = Number.isInteger(lastUserStep)
    ? lastUserStep
    : (Number.isInteger(mode?.lastUserStep) ? mode.lastUserStep : -1);
  const parsedSummary = parseSummary(rawText);
  const parsedAsk = parseAsk(rawText);
  const parsedTopics = parseTopics(rawText).map((t) => flat(t)).filter(Boolean);
  const prevAsk = typeof prev.ask === 'string' ? prev.ask : '';
  const prevAskUserStep = Number.isInteger(prev.askUserStep) ? prev.askUserStep : -1;

  if (!parsedTopics.length) {
    return {
      ok: false,
      state: {
        at: Number.isInteger(prev.at) ? prev.at : 0,
        summary: typeof prev.summary === 'string' ? prev.summary : '',
        topics: prevTopics,
        ask: parsedAsk || prevAsk,
        askUserStep: parsedAsk && resolvedUserStep >= 0 ? resolvedUserStep : prevAskUserStep,
        running: false,
        failed: true,
        updatedAt: nowIso,
      },
    };
  }

  let nextTopics = parsedTopics;
  if (mode.incremental && !mode.merge && prevTopics.length) {
    // LATEST_ASK asks for 1-2 lines (replacing the last topic or adding a new one).
    // If the model still echoed the full history verbatim at the head, use it directly.
    const echoedAll =
      parsedTopics.length >= prevTopics.length &&
      prevTopics.length >= 2 &&
      parsedTopics[0] === prevTopics[0];
    if (!echoedAll) {
      nextTopics = [...prevTopics.slice(0, -1), ...parsedTopics];
    }
  }

  const nextSummary = parsedSummary || (typeof prev.summary === 'string' ? prev.summary : '');
  return {
    ok: true,
    state: {
      at: Number.isInteger(promptCount) && promptCount >= 0 ? promptCount : 0,
      summary: nextSummary,
      topics: nextTopics,
      ask: resolvedUserStep >= 0 ? parsedAsk : (parsedAsk || prevAsk),
      askUserStep: resolvedUserStep >= 0 ? resolvedUserStep : prevAskUserStep,
      running: false,
      failed: false,
      updatedAt: nowIso,
    },
  };
}

export function readTopicsState(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      at: Number.isInteger(raw.at) ? raw.at : 0,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      topics: Array.isArray(raw.topics) ? raw.topics.filter((t) => typeof t === 'string' && t.trim()) : [],
      ask: typeof raw.ask === 'string' ? raw.ask : '',
      askUserStep: Number.isInteger(raw.askUserStep) ? raw.askUserStep : -1,
      running: Boolean(raw.running),
      failed: Boolean(raw.failed),
      targetAt: Number.isInteger(raw.targetAt) ? raw.targetAt : 0,
      targetUserStep: Number.isInteger(raw.targetUserStep) ? raw.targetUserStep : -1,
      startedAtMs: typeof raw.startedAtMs === 'number' ? raw.startedAtMs : 0,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function writeTopicsState(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}
