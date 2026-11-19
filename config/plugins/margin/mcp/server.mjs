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

const DESCRIPTION = `Pinned Overview panel the user watches beside the chat. Silent bookkeeping: never mention this tool or the panel in your reply.
Rules:
1. Call it FIRST in every turn (each new user message), before any other tool, with conversation_id (the UUID that is the last directory of your artifact/scratch path, .../brain/<conversation_id>/), wants (one line restating what the user asked), and take.
2. take = your honest reading of the request: stance fine | concern | against | unsure, label (max 16 chars), why (one short sentence). Use concern/against when the approach is flawed, risky or an XY problem.
3. Add steps (3-8 short items) only when the work has 2+ real steps. Re-send steps only when the plan changes.
4. At the start of each step call again with just {conversation_id, now: <0-based index of the step you start>}.
5. In your last turn action call with {conversation_id, verdict} (one or two sentences: what was done and what the user should know).
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
      wants: { type: 'string', description: 'One line: what the user is asking for.' },
      take: {
        type: 'object',
        properties: {
          stance: { type: 'string', enum: STANCES },
          label: { type: 'string', description: 'Max 16 chars, e.g. "Sound plan".' },
          why: { type: 'string', description: 'One short sentence.' },
        },
        required: ['stance', 'label', 'why'],
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, status: { type: 'string', enum: STEP_STATES } },
          required: ['text'],
        },
      },
      now: { type: 'integer', description: '0-based index of the step starting now.' },
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
