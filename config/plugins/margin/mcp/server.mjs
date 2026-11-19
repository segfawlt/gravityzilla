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
import { buildOverview, newestConversation } from '../lib/overview.mjs';

export { newestConversation };

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const APP_URI = 'ui://margin/overview.html';
const APP_MIME = 'text/html;profile=mcp-app';
const CONTENT_FIELDS = ['wants', 'take', 'steps', 'now', 'verdict'];

/** One self-contained HTML document (the host CSP blocks external scripts/styles). Read per request so edits are live. */
export function appHtml({ sidecar = false } = {}) {
  const read = (f) => readFileSync(join(APP_DIR, f), 'utf-8');
  let html = read('index.html');
  if (sidecar) {
    html = html.replace('<style>', '<script src="/preload.js"></script>\n  <style>');
  }
  return html
    .replace('/*APP_CSS*/', () => read('app.css'))
    .replace('/*APP_JS*/', () => read('app.js'));
}

const DESCRIPTION = `Pinned Overview panel the user watches beside the chat. Silent bookkeeping: never mention this tool or the panel in your reply, and write wants, take, steps, and verdict in the user's language.
Rules:
1. Call FIRST in every turn (each new user message), before any other tool, with conversation_id (the UUID in your .../brain/<conversation_id>/ path), wants (1-2 lines restating what the user asked), take, and steps (when 2+ real steps).
2. take = your reaction to the ask BEFORE any work (never the answer itself):
   - stance: fine = do as asked; concern = doable but has a real risk, XY problem, or better way; against = ask user to reconsider first (irreversible, data loss, bypasses review/CI/safeguard, or breaks a stated rule — pick against over concern whenever one holds); unsure = cannot judge yet without checking a source.
   - label: required, 1-3 words, max 16 chars, no mood words. Examples — fine: "clear", "small fix"; concern: "risky", "overkill", "check first"; against: "breaks rule", "data loss"; unsure: "needs repro", "unclear goal"; question asks (no edits): verb + target like "check labels", "read session" (never "question" or "answer").
   - why: one short clause (~60 chars) stating the reason or the input you will check.
3. Add steps (2-8 short items) when the turn has 2+ real steps, with now: 0 to mark step 1 active. When a step spawns subagents or swarm workers, list their role/worker names or descriptions in that step's agents array. Re-send wants/take/steps only when the plan changes.
4. At the start of each next step, ping {conversation_id, now: <0-based step index>} (e.g. now: 1 when starting step 2, now: 2 when starting step 3) so the live progress badge updates immediately.
5. At the end of the turn, call {conversation_id, verdict} (1-2 sentences: what changed and what was verified); a clean final answer also closes remaining steps automatically.
Omitted fields keep their previous value within the same user message.`;

const TOOL = {
  name: 'margin_intent',
  title: 'Overview',
  description: DESCRIPTION,
  _meta: {
    ui: { resourceUri: APP_URI },
    'com.google.antigravity/ui': { entrypoints: [{ type: 'auxPane', title: 'Overview' }] },
  },
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Conversation UUID from your brain/<id> artifact path.' },
      wants: { type: 'string', description: '1-2 lines restating what the user is asking for.' },
      take: {
        type: 'object',
        properties: {
          stance: { type: 'string', enum: STANCES },
          label: { type: 'string', description: '1-3 words, max 16 chars (e.g. "clear", "check first", "breaks rule", "needs repro").' },
          why: { type: 'string', description: 'One short clause (~60 chars): the reason or source to check.' },
        },
        required: ['stance', 'label'],
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
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
      now: { type: 'integer', minimum: 0, description: '0-based index of the step starting now (0 for step 1, 1 for step 2, ...).' },
      verdict: { type: 'string', description: 'Final outcome, set once at the end of the turn.' },
    },
    required: ['conversation_id'],
  },
};

// App-only: the pane polls this for live status; the model never sees it.
const OVERVIEW_TOOL = {
  name: 'margin_overview',
  title: 'Overview data',
  description: 'Read-only overview data for the Margin pane.',
  inputSchema: { type: 'object', properties: { conversation_id: { type: 'string' } } },
  _meta: { ui: { resourceUri: APP_URI, visibility: ['app'] } },
};

function resolveConv(raw, dirs) {
  const id = String(raw ?? '');
  return ID_RE.test(id) && brainDirOf(id, dirs) ? id : newestConversation(dirs);
}

/**
 * Handle margin_intent. Writes only when the call carries content (the pane's
 * "+" launch calls it with {}), and always returns the current overview.
 */
export function handleCall(args, dirs = appDataDirs()) {
  const a = args && typeof args === 'object' ? args : {};
  const conv = resolveConv(a.conversation_id, dirs);
  const brain = brainDirOf(conv, dirs);
  if (!brain) return { ok: false, text: 'margin: conversation not found; nothing recorded.' };
  if (CONTENT_FIELDS.some((k) => a[k] !== undefined)) {
    const facts = summarize(readRows(transcriptPath(brain)));
    writeIntent(intentPath(brain), merge(readIntent(intentPath(brain)), a, facts.userStep));
  }
  return { ok: true, text: 'ok', structured: { conversationId: conv, overview: buildOverview(brain) } };
}

/** Handle margin_overview (read-only). */
export function handleOverview(args, dirs = appDataDirs()) {
  const conv = resolveConv(args?.conversation_id, dirs);
  const brain = brainDirOf(conv, dirs);
  if (!brain) return { ok: false, text: 'margin: conversation not found.' };
  return { ok: true, text: 'ok', structured: { conversationId: conv, overview: buildOverview(brain) } };
}

const toResult = (r) => ({
  content: [{ type: 'text', text: r.text }],
  ...(r.structured ? { structuredContent: r.structured } : {}),
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
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'margin', version: '0.1.0' },
      });
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools: [TOOL, OVERVIEW_TOOL] });
    case 'resources/list':
      return reply(id, { resources: [{ uri: APP_URI, name: 'Margin overview', mimeType: APP_MIME }] });
    case 'resources/read':
      if (params?.uri !== APP_URI) return fail(id, -32602, `unknown resource ${params?.uri}`);
      return reply(id, { contents: [{ uri: APP_URI, mimeType: APP_MIME, text: appHtml(), _meta: { ui: { prefersBorder: false } } }] });
    case 'tools/call': {
      const handler = { [TOOL.name]: handleCall, [OVERVIEW_TOOL.name]: handleOverview }[params?.name];
      if (!handler) return fail(id, -32602, `unknown tool ${params?.name}`);
      try {
        return reply(id, toResult(handler(params.arguments)));
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
