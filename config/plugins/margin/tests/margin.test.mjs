import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { merge } from '../lib/intent.mjs';
import { buildOverview, resolveOverview } from '../lib/overview.mjs';
import { brainDirOf, intentPath } from '../lib/paths.mjs';
import { stripUserText, summarize } from '../lib/transcript.mjs';
import { appHtml, handleCall, handleOverview, newestConversation } from '../mcp/server.mjs';
import { CONV, generic, makeBrain, planner, user } from './fixtures.mjs';

const T0 = '2026-01-01T10:00:00Z';
const T1 = '2026-01-01T10:00:30Z';
const at = (iso) => Date.parse(iso);

test('stripUserText keeps only the request body', () => {
  assert.equal(stripUserText('<USER_REQUEST>\nhello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'), 'hello');
});

test('status: planning, working, done, stopped', () => {
  const u = user(0, 'do it', T0);
  assert.equal(summarize([u], at(T0) + 1000).status, 'planning');
  const working = [u, planner(1, [['read_file', { Path: '"/a/b.txt"' }]], T0), generic(2, T0)];
  const s = summarize(working, at(T0) + 5000);
  assert.equal(s.status, 'working');
  assert.deepEqual(s.used, { files: 1 });
  assert.deepEqual(s.files, ['/a/b.txt']);
  assert.equal(summarize([...working, planner(3, [], T1)], at(T1) + 1000).status, 'done');
  assert.equal(summarize(working, at(T0) + 6 * 60_000).status, 'stopped');
  assert.equal(summarize([u, planner(1, [['run_command', {}]], T0), generic(2, T0, 'ERROR')], at(T0) + 90_000).status, 'stopped');
});

test('only the latest turn counts, and margin_intent calls are not work', () => {
  const rows = [
    user(0, 'old', T0), planner(1, [['run_command', {}]], T0), planner(2, [], T0),
    user(3, 'new', T1), planner(4, [['margin_intent', {}], ['search_web', {}]], T1),
  ];
  const s = summarize(rows, at(T1) + 1000);
  assert.equal(s.ask, 'new');
  assert.deepEqual(s.used, { web: 1 });
  assert.equal(s.userStep, 3);
});

test('merge: omitted fields persist, now advances, new turn resets, verdict completes', () => {
  const a = merge(null, { wants: 'w', take: { stance: 'concern', label: 'x'.repeat(40), why: 'y' }, steps: ['a', 'b', 'c'], now: 1 }, 5);
  assert.equal(a.take.label.length, 16);
  assert.deepEqual(a.steps.map((s) => s.status), ['completed', 'in_progress', 'pending']);
  const b = merge(a, { now: 2 }, 5);
  assert.equal(b.wants, 'w');
  assert.deepEqual(b.steps.map((s) => s.status), ['completed', 'completed', 'in_progress']);
  assert.equal(merge(b, { take: { stance: 'bogus', label: '', why: '' } }, 5).take.stance, 'unsure');
  const c = merge(b, { verdict: 'shipped' }, 5);
  assert.ok(c.steps.every((s) => s.status === 'completed'));
  const d = merge(c, { wants: 'next' }, 9);
  assert.deepEqual([d.steps, d.verdict, d.take], [[], '', null]);
});

test('brainDirOf rejects path-traversal ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { dirs } = makeBrain(home, [user(0, 'x', T0)]);
  assert.equal(brainDirOf('../../etc', dirs), null);
  assert.equal(brainDirOf('abc', dirs), null);
  assert.ok(brainDirOf(CONV, dirs));
});

test('MCP call writes intent for the right turn; stale intent is hidden after a new user message', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { brain, dirs } = makeBrain(home, [user(0, 'first', T0), planner(1, [], T0)]);
  const r = handleCall({ conversation_id: CONV, wants: 'first thing', steps: ['a', 'b'], now: 0 }, dirs);
  assert.equal(r.ok, true);
  const ov = buildOverview(brain, at(T0) + 1000);
  assert.equal(ov.wants, 'first thing');
  assert.equal(ov.done, 0);
  assert.equal(ov.reported, true);
  makeBrain(home, [user(0, 'first', T0), planner(1, [], T0), user(2, 'second', T1)]);
  const stale = buildOverview(brain, at(T1) + 1000);
  assert.equal(stale.reported, false);
  assert.equal(stale.ask, 'second');
  assert.deepEqual(stale.steps, []);
});

test('MCP call with a bad id falls back to the newest conversation, and a missing one records nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { brain, dirs } = makeBrain(home, [user(0, 'x', T0)]);
  assert.equal(newestConversation(dirs), CONV);
  assert.equal(handleCall({ conversation_id: '../../x', wants: 'hi' }, dirs).ok, true);
  assert.ok(existsSync(intentPath(brain)));
  const empty = mkdtempSync(join(tmpdir(), 'margin-empty-'));
  assert.equal(handleCall({ conversation_id: CONV, wants: 'hi' }, [join(empty, 'x')]).ok, false);
  assert.deepEqual(readdirSync(empty), []);
});

test('an empty call (pane "+" launch) reads without writing', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { brain, dirs } = makeBrain(home, [user(0, 'x', T0)]);
  const r = handleCall({}, dirs);
  assert.equal(r.ok, true);
  assert.equal(r.structured.conversationId, CONV);
  assert.equal(existsSync(intentPath(brain)), false);
});

test('margin_overview is read-only and returns the overview', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { brain, dirs } = makeBrain(home, [user(0, 'x', T0)]);
  const r = handleOverview({ conversation_id: CONV }, dirs);
  assert.equal(r.structured.overview.ask, 'x');
  assert.equal(existsSync(intentPath(brain)), false);
});

test('stdio protocol: initialize, tools (model-visible vs app-only), app resource', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn('node', [new URL('../mcp/server.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  send(1, 'initialize', { protocolVersion: '2025-06-18' });
  send(2, 'tools/list');
  send(3, 'resources/read', { uri: 'ui://margin/overview.html' });
  send(4, 'resources/read', { uri: 'ui://elsewhere' });
  send(5, 'nope');
  for (let i = 0; i < 50 && lines.length < 5; i++) await new Promise((r) => setTimeout(r, 40));
  child.kill();
  const by = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.deepEqual(Object.keys(by[1].result.capabilities).sort(), ['resources', 'tools']);
  const [intent, overview] = by[2].result.tools;
  assert.equal(intent._meta.ui.resourceUri, 'ui://margin/overview.html');
  assert.equal(intent._meta['com.google.antigravity/ui'].entrypoints[0].type, 'auxPane');
  assert.deepEqual(overview._meta.ui.visibility, ['app']);
  const c = by[3].result.contents[0];
  assert.equal(c.mimeType, 'text/html;profile=mcp-app');
  assert.ok(c.text.includes('ui/initialize') && !c.text.includes('/*APP_JS*/') && !c.text.includes('/*APP_CSS*/'));
  assert.ok(by[4].error && by[5].error);
});

test('resolveOverview supports ETag caching and conversation fallback, and appHtml injects preload.js for sidecars', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { dirs } = makeBrain(home, [user(0, 'first ask', T0), planner(1, [], T0)]);
  const first = resolveOverview({ conversationId: 'invalid-id' }, dirs);
  assert.equal(first.conversationId, CONV);
  assert.equal(first.overview.ask, 'first ask');
  assert.ok(first.etag);

  const cached = resolveOverview({ conversationId: CONV, etag: first.etag }, dirs);
  assert.equal(cached.unchanged, true);
  assert.equal(cached.overview, undefined);

  makeBrain(home, [user(0, 'first ask', T0), planner(1, [], T0), user(2, 'second ask', T1)]);
  const updated = resolveOverview({ conversationId: CONV, etag: first.etag }, dirs);
  assert.equal(updated.unchanged, undefined);
  assert.equal(updated.overview.ask, 'second ask');

  const mcpDoc = appHtml();
  const sidecarDoc = appHtml({ sidecar: true });
  assert.equal(mcpDoc.includes('/preload.js'), false);
  assert.equal(sidecarDoc.includes('<script src="/preload.js"></script>'), true);
});
