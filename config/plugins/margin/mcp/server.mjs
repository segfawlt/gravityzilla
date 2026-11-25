#!/usr/bin/env node
// Minimal dependency-free MCP stdio server exposing one tool: margin_intent.
// The rules live in the tool description, so no always-on prompt rule is needed.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { appDataDirs, brainDirOf, ID_RE, intentPath, transcriptPath } from '../lib/paths.mjs';
import { merge, readIntent, writeIntent, STANCES, STEP_STATES } from '../lib/intent.mjs';
import { readRows, summarize } from '../lib/transcript.mjs';
import { newestConversation } from '../lib/overview.mjs';

export { newestConversation };

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const CONTENT_FIELDS = ['wants', 'take', 'steps', 'now'];

// Non-blocking webfont load for the sidecar host only; the MCP document stays offline/CSP clean.
const GOOGLE_FONTS_LINK = '<link rel="stylesheet" media="print" onload="this.media=\'all\'" href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:ROND,opsz,slnt,wdth,wght@0..100,6..144,-10..0,92..100,100..1000&family=Google+Sans+Code:wght@400..600&display=swap">';

/** One self-contained HTML document (the host CSP blocks external scripts/styles). Read per request so edits are live. */
export function appHtml({ sidecar = false } = {}) {
  const read = (f) => readFileSync(join(APP_DIR, f), 'utf-8');
  let html = read('index.html');
  if (sidecar) {
    html = html.replace('<style>', `${GOOGLE_FONTS_LINK}\n  <script src="/preload.js"></script>\n  <style>`);
  }
  return html
    .replace('/*APP_CSS*/', () => `${read('fonts.css')}\n${read('app.css')}`)
    .replace('/*APP_JS*/', () => read('app.js'));
}

const DESCRIPTION = `Pinned Overview panel beside chat. Silent bookkeeping: never mention this tool or panel in replies; write wants and take in user's language.
Clean-caveman style: write wants and take.why as ultra-terse telegraphic plain words — drop articles (a/an/the), copulas (is/are), and filler while keeping negations exact and words readable (never mangled caveman like "me fix"). Avoid code symbols, internal filenames, camelCase names, hashes, acronyms, and backticks unless asked.
Rules:
1. Call FIRST on every new user message (including Plan Mode and short/queued follow-ups), before or alongside your first read/search batch (never skip a follow-up or wait until after scouting), with conversation_id (from .../brain/<conversation_id>/), wants (3-8w telegraphic core goal, <=60ch, everyday words, no file lists/symbols/sub-details unless asked), and take.
2. take = reaction BEFORE work; never the answer. On work asks: stance on doing as asked. On questions with no work: certainty + source to check or premise doubted; never expected answer, even when in context — name source only (Bad: "plausible: wording invites mini-answer". Good: "check rule: read take rule").
   - stance: fine = do as asked; concern = real risk or better way; against = ask user first (irreversible, skips safeguard/review/CI/backup/confirm, or breaks rule — pick against over concern whenever true); unsure = cannot judge yet.
   - label: required, 1-2 words, <=14 chars (max 16). Question asks (no work): verb + target ("check labels", "read session", "count names"). Examples — fine: "clear", "small fix"; concern: "risky", "overkill", "check first"; against: "breaks rule", "data loss"; unsure: "needs repro", "unclear goal". Bad: "naming q", "design q", "answer", "question". No mood words.
   - why: optional 2-5w telegraphic fragment, <=40ch (good: "needs app patch", "check margin + memory code"; bad: "requires dist/preload.js hook in app.asar"; omit on fine when label suffices). With unsure, name source to check (file, command, session), never a finding.
3. Margin reads Plan steps automatically from Antigravity's native update_steps tool — do not duplicate steps or send per-step pings (optional steps/now remain only as fallback for non-update_steps harnesses). Always send a fresh take on every new user message; within the same turn, only re-call if wants or take changes, and never call alone at turn end.`;

const TOOL = {
  name: 'margin_intent',
  title: 'Overview',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Conversation UUID from your brain/<id> artifact path.' },
      wants: { type: 'string', description: 'Telegraphic core goal in 3-8 plain everyday words (<=60ch, user language); drop articles/filler, no file lists, symbols, or sub-details unless asked.' },
      take: {
        type: 'object',
        properties: {
          stance: { type: 'string', enum: STANCES },
          label: { type: 'string', description: '1-2 words, <=14 chars, max 16 (e.g. "clear", "check first", "breaks rule", "needs repro").' },
          why: { type: 'string', description: 'Optional 2-5w telegraphic fragment (<=40ch; plain words, no jargon; omit on fine when label suffices; with unsure, name source to check).' },
        },
        required: ['stance', 'label'],
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Terse 2-5w verb+noun fragment (<=40ch, plain everyday words; no raw file paths or symbol names).' },
            status: { type: 'string', enum: STEP_STATES },
            agents: {
              type: 'array',
              items: { type: 'string' },
              description: 'Subagent roles/names or descriptions spawned for this step.',
            },
          },
          required: ['text'],
        },
      },
      now: { type: 'integer', minimum: 1, description: '1-based index of the step starting now (1 for step 1, 2 for step 2, ...).' },
    },
    required: ['conversation_id'],
  },
};

function resolveConv(raw, dirs) {
  const id = String(raw ?? '');
  return ID_RE.test(id) && brainDirOf(id, dirs) ? id : newestConversation(dirs);
}

/**
 * Handle margin_intent. Writes only when the call carries content (an empty
 * call `{}` is a no-op that does not write `intent.json`).
 */
export function handleCall(args, dirs = appDataDirs()) {
  const a = args && typeof args === 'object' ? args : {};
  const conv = resolveConv(a.conversation_id, dirs);
  const brain = brainDirOf(conv, dirs);
  if (!brain) return { ok: false, text: 'margin: conversation not found; nothing recorded.' };
  if (CONTENT_FIELDS.some((k) => a[k] !== undefined)) {
    const facts = summarize(readRows(transcriptPath(brain)));
    const prevAnswered = Boolean(
      facts.turnRows?.some(
        (r) =>
          r?.type === 'PLANNER_RESPONSE' &&
          r?.status === 'DONE' &&
          (!Array.isArray(r.tool_calls) || r.tool_calls.length === 0),
      ),
    );
    writeIntent(intentPath(brain), merge(readIntent(intentPath(brain)), a, facts.userStep, { prevAnswered }));
  }
  return { ok: true, text: 'ok' };
}

const toResult = (r) => ({
  content: [{ type: 'text', text: r.text }],
  isError: !r.ok,
});

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

export function dispatch(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'margin', version: '0.1.0' },
      });
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools: [TOOL] });
    case 'tools/call': {
      if (params?.name !== TOOL.name) return fail(id, -32602, `unknown tool ${params?.name}`);
      try {
        return reply(id, toResult(handleCall(params.arguments)));
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `margin error: ${e.message}` }], isError: true });
      }
    }
    default: return fail(id, -32601, `method not found: ${method}`);
  }
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
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
    dispatch(msg);
  });
}
