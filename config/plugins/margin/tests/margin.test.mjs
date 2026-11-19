import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyNow, enrichTake, merge, TAKE_MARKS } from '../lib/intent.mjs';
import { buildOverview, computeStepProgress, hang, resolveOverview } from '../lib/overview.mjs';
import { brainDirOf, intentPath } from '../lib/paths.mjs';
import { bashPaths, computeContext, stripUserText, summarize } from '../lib/transcript.mjs';
import { appHtml, handleCall, handleOverview, newestConversation } from '../mcp/server.mjs';
import { checkpoint, CONV, generic, makeBrain, planner, user } from './fixtures.mjs';

const T0 = '2026-01-01T10:00:00Z';
const T1 = '2026-01-01T10:00:30Z';
const T2 = '2026-01-01T10:01:00Z';
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

test('only the latest turn counts, and margin_intent / call_mcp_tool(margin) calls are not work', () => {
  const rows = [
    user(0, 'old', T0), planner(1, [['run_command', {}]], T0), planner(2, [], T0),
    user(3, 'new', T1), planner(4, [
      ['margin_intent', {}],
      ['call_mcp_tool', { ServerName: '"margin_margin"', ToolName: '"margin_intent"', Arguments: '{}' }],
      ['search_web', { query: '"sqlite wal"' }],
    ], T1),
  ];
  const s = summarize(rows, at(T1) + 1000);
  assert.equal(s.ask, 'new');
  assert.deepEqual(s.used, { web: 1 });
  assert.equal(s.turnTools, 1);
  assert.equal(s.userStep, 3);
});

test('merge & TAKE marks: omitted fields persist, now advances, new turn resets, verdict completes', () => {
  assert.deepEqual(TAKE_MARKS, { fine: '✓', concern: '!', against: '✗', unsure: '?' });
  assert.equal(enrichTake({ stance: 'fine', label: 'clear', why: 'ok' }).mark, '✓');
  assert.equal(enrichTake({ stance: 'concern', label: 'risky', why: 'watch out' }).mark, '!');
  assert.equal(enrichTake({ stance: 'against', label: 'data loss', why: 'drops db' }).mark, '✗');
  assert.equal(enrichTake({ stance: 'unsure', label: 'needs repro', why: 'check logs' }).mark, '?');

  const a = merge(null, {
    wants: 'w',
    take: { stance: 'concern', label: 'x'.repeat(40), why: 'y' },
    steps: [{ text: 'a', agents: ['scout'] }, 'b', 'c'],
    now: 1,
  }, 5);
  assert.equal(a.take.label.length, 16);
  assert.equal(a.take.mark, '!');
  assert.deepEqual(a.steps[0].agents, ['scout']);
  assert.deepEqual(a.steps.map((s) => s.status), ['completed', 'in_progress', 'pending']);

  const b = merge(a, { now: 2 }, 5);
  assert.equal(b.wants, 'w');
  assert.deepEqual(b.steps.map((s) => s.status), ['completed', 'completed', 'in_progress']);
  assert.equal(merge(b, { take: { stance: 'bogus', label: '', why: '' } }, 5).take.stance, 'unsure');
  assert.equal(merge(b, { take: { stance: 'bogus', label: '', why: '' } }, 5).take.mark, '?');

  // Out-of-range `now` leaves steps untouched; 1-based `now === steps.length` on pending final step is tolerated
  const pendingLast = [{ text: 'x', status: 'in_progress' }, { text: 'y', status: 'pending' }];
  assert.deepEqual(applyNow(pendingLast, 2).map((s) => s.status), ['completed', 'in_progress']);
  assert.deepEqual(applyNow(pendingLast, 99).map((s) => s.status), ['in_progress', 'pending']);

  const c = merge(b, { verdict: 'shipped' }, 5);
  assert.ok(c.steps.every((s) => s.status === 'completed'));
  const d = merge(c, { wants: 'next' }, 9);
  assert.deepEqual([d.steps, d.verdict, d.take], [[], '', null]);
});

test('stepProgress tracks "2 done · on 3 of 5", "0/5 steps", and "5/5 steps"', () => {
  const none = computeStepProgress(['s1', 's2', 's3', 's4', 's5'].map((t) => ({ text: t, status: 'pending' })));
  assert.deepEqual(none, { done: 0, active: null, activeText: '', total: 5, label: '0/5 steps' });

  const mid = computeStepProgress([
    { text: 'one', status: 'completed' },
    { text: 'two', status: 'completed' },
    { text: 'three', status: 'in_progress' },
    { text: 'four', status: 'pending' },
    { text: 'five', status: 'pending' },
  ]);
  assert.deepEqual(mid, {
    done: 2,
    active: 3,
    activeText: 'three',
    total: 5,
    label: '2 done · on 3 of 5',
  });

  const allDone = computeStepProgress(['a', 'b', 'c', 'd', 'e'].map((t) => ({ text: t, status: 'completed' })));
  assert.deepEqual(allDone, { done: 5, active: null, activeText: '', total: 5, label: '5/5 steps' });
  assert.deepEqual(computeStepProgress([]), { done: 0, active: null, activeText: '', total: 0, label: '' });
});

test('brainDirOf rejects path-traversal ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { dirs } = makeBrain(home, [user(0, 'x', T0)]);
  assert.equal(brainDirOf('../../etc', dirs), null);
  assert.equal(brainDirOf('abc', dirs), null);
  assert.ok(brainDirOf(CONV, dirs));
});

test('MCP call writes intent, auto-completes on clean done, preserves incomplete on stopped, and exposes previous during planning', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  // Working turn: step 1 in_progress (0 done · on 1 of 2)
  const { brain, dirs } = makeBrain(home, [
    user(0, 'first', T0),
    planner(1, [['read_file', { Path: '"/repo/a.js"' }]], T0),
    generic(2, T0),
  ]);
  const r = handleCall({
    conversation_id: CONV,
    wants: 'first thing',
    take: { stance: 'fine', label: 'clear', why: 'straightforward' },
    steps: ['step one', 'step two'],
    now: 0,
  }, dirs);
  assert.equal(r.ok, true);

  const workingOv = buildOverview(brain, at(T0) + 1000);
  assert.equal(workingOv.status, 'working');
  assert.equal(workingOv.wants, 'first thing');
  assert.equal(workingOv.take.mark, '✓');
  assert.equal(workingOv.done, 0);
  assert.equal(workingOv.stepProgress.label, '0 done · on 1 of 2');
  assert.equal(workingOv.reported, true);
  assert.equal(workingOv.previous, null);

  // Stopped turn (>5m idle): keeps incomplete step 1 in_progress so user sees where it stopped
  const stoppedOv = buildOverview(brain, at(T0) + 6 * 60_000);
  assert.equal(stoppedOv.status, 'stopped');
  assert.equal(stoppedOv.done, 0);
  assert.equal(stoppedOv.steps[0].status, 'in_progress');
  assert.equal(stoppedOv.steps[1].status, 'pending');

  // Clean completion (`done`): auto-completes remaining steps (`isAnswered` rule)
  makeBrain(home, [
    user(0, 'first', T0),
    planner(1, [['read_file', { Path: '"/repo/a.js"' }]], T0),
    generic(2, T0),
    planner(3, [], T0),
  ]);
  const doneOv = buildOverview(brain, at(T0) + 2000);
  assert.equal(doneOv.status, 'done');
  assert.equal(doneOv.done, 2);
  assert.equal(doneOv.stepProgress.label, '2/2 steps');
  assert.ok(doneOv.steps.every((s) => s.status === 'completed'));

  // New user turn arrives (`planning`, not yet reported): `steps` is [], `previous` holds Turn 1's report
  makeBrain(home, [
    user(0, 'first', T0),
    planner(1, [['read_file', { Path: '"/repo/a.js"' }]], T0),
    generic(2, T0),
    planner(3, [], T0),
    user(4, 'second', T1),
  ]);
  const planningOv = buildOverview(brain, at(T1) + 1000);
  assert.equal(planningOv.status, 'planning');
  assert.equal(planningOv.reported, false);
  assert.equal(planningOv.ask, 'second');
  assert.deepEqual(planningOv.steps, []);
  assert.ok(planningOv.previous);
  assert.equal(planningOv.previous.wants, 'first thing');
  assert.equal(planningOv.previous.take.mark, '✓');
  assert.deepEqual(planningOv.previous.steps.map((s) => s.status), ['completed', 'completed']);
});

test('hang() nests planned, invoke_subagent, and swarm workers under matching or active in_progress steps', () => {
  // Direct unit check on hang()
  const direct = hang(
    [
      { text: 'Design', status: 'completed', agents: ['arch-scout'] },
      { text: 'Implement', status: 'in_progress', agents: ['backend', 'future-verifier: Check edge cases'] },
    ],
    [
      { id: '11111111-1111-1111-1111-111111111111', name: 'arch-scout', description: 'Check layout', status: 'completed', type: 'research', model: 'flash' },
      { id: '22222222-2222-2222-2222-222222222222', name: 'backend', description: 'Build overview', status: 'running', type: 'swarm', model: 'gemini-4-carbon-high' },
      { id: '33333333-3333-3333-3333-333333333333', name: 'ui', description: 'Polish sidebar', status: 'waiting', type: 'swarm', model: 'gemini-3.8-flash-high' },
    ],
  );
  assert.equal(direct[0].index, 1);
  assert.equal(direct[0].agents.length, 1);
  assert.equal(direct[0].agents[0].status, 'completed');
  assert.equal(direct[1].index, 2);
  assert.deepEqual(direct[1].agents.map((a) => [a.name, a.status]), [
    ['backend', 'running'],
    ['future-verifier', 'planned'],
    ['ui', 'waiting'],
  ]);

  // End-to-end buildOverview check with invoke_subagent + swarm members.json
  const home = mkdtempSync(join(tmpdir(), 'margin-agents-'));
  const subConv = 'aaaa1111-2222-4333-8444-555555555555';
  const swarmWorkConv = 'bbbb1111-2222-4333-8444-555555555555';
  const swarmWaitConv = 'cccc1111-2222-4333-8444-555555555555';
  const swarmKilledConv = 'dddd1111-2222-4333-8444-555555555555';

  // Subagent finished cleanly (`completed`) and read a file
  makeBrain(home, [
    { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: T0, content: 'brief' },
    planner(1, [['read_file', { Path: '"/repo/sub.ts"' }]], T0),
    generic(2, T0),
    planner(3, [], T0),
  ], subConv);

  // Active swarm worker (`running`) reading a skill
  makeBrain(home, [
    { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: T0, content: 'brief' },
    planner(1, [['read_file', { Path: '"/home/u/.gemini/config/skills/audit/SKILL.md"' }]], T0),
    generic(2, T0),
  ], swarmWorkConv);

  // Waiting swarm worker (`waiting`)
  makeBrain(home, [
    { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: T0, content: 'brief' },
  ], swarmWaitConv);

  // Main coordinator transcript: launched subagent + swarm, then paused waiting for workers (`planner(4, [], T0)`)
  const { brain, dirs } = makeBrain(home, [
    user(0, 'run swarm', T0),
    planner(1, [
      ['invoke_subagent', { Role: '"Code Scout"', TypeName: '"research"', Prompt: '"Inspect sub.ts"' }],
      ['swarm', { action: '"add"', name: '"worker-a"', brief: '"Goal: Build backend API"' }],
    ], T0),
    generic(2, T0, 'DONE', `Created the following subagent:\n{\n  "conversationId": "${subConv}"\n}`),
    generic(3, T0, 'DONE', 'spawned worker-a'),
    planner(4, [], T0),
  ]);

  const swarmDir = join(brain, '.system_generated', 'swarm');
  mkdirSync(swarmDir, { recursive: true });
  writeFileSync(join(swarmDir, 'members.json'), JSON.stringify({
    title: 'Test Swarm',
    members: {
      coordinator: { conversation_id: CONV, role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', killed: false, applied_model: 'gemini-flash-worker-agy' },
      'worker-a': { conversation_id: swarmWorkConv, role: 'worker', phase: 'RUNNING', wake_mode: 'working', killed: false, applied_model: 'gemini-4-carbon-high' },
      verifier: { conversation_id: swarmWaitConv, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false, applied_model: 'gemini-4-carbon-high' },
      oldworker: { conversation_id: swarmKilledConv, role: 'worker', phase: 'KILLED', wake_mode: 'working', killed: true, applied_model: 'gemini-3.8-flash-high' },
      monitor: { conversation_id: 'eeee1111-2222-4333-8444-555555555555', role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false, applied_model: 'gemini-flash-worker-agy' },
    },
  }));

  handleCall({
    conversation_id: CONV,
    wants: 'Coordinate swarm upgrade',
    take: { stance: 'fine', label: 'clear', why: 'parallel slices' },
    steps: [
      { text: 'Scout codebase', status: 'completed', agents: ['Code Scout'] },
      { text: 'Execute parallel workers', status: 'in_progress' },
      { text: 'Verify & ship', status: 'pending' },
    ],
  }, dirs);

  const ov = buildOverview(brain, at(T0) + 5000);
  // Coordinator ended message while worker-a (running) + verifier (waiting) are active -> waiting_agents (2, excluding idle monitor)
  assert.equal(ov.status, 'waiting_agents');
  assert.equal(ov.waitingAgents, 2);
  // Steps NOT prematurely auto-completed while waiting_agents!
  assert.equal(ov.stepProgress.label, '1 done · on 2 of 3');
  assert.equal(ov.steps[0].agents[0].name, 'Code Scout');
  assert.equal(ov.steps[0].agents[0].status, 'completed');
  const step2Statuses = Object.fromEntries(ov.steps[1].agents.map((a) => [a.name, a.status]));
  assert.deepEqual(step2Statuses, {
    'worker-a': 'running',
    verifier: 'waiting',
    oldworker: 'killed',
    monitor: 'waiting',
  });
  assert.equal(ov.steps[1].agents.find((a) => a.name === 'worker-a').description, 'Build backend API');
  // Subagent attribution in usedDetails (+1 file from Code Scout, +1 skill from worker-a)
  assert.equal(ov.usedDetails.files.agents, 1);
  assert.equal(ov.usedDetails.skills.agents, 1);
  assert.equal(ov.usedDetails.skills.items[0].short, 'audit');
  assert.equal(ov.usedDetails.skills.items[0].reader, 'worker-a');
});

test('context window: reported tokens, >32KB trailing tool output, CHECKPOINT compaction reset, and char/4 fallback', () => {
  const bigToolOutput = 'x'.repeat(60_000); // > 32 KB trailing tool output
  const modelTag = '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon). No need to comment on this change if the user doesn\'t ask about it.\n</USER_SETTINGS_CHANGE>';
  const rows = [
    user(0, 'hello', T0, modelTag),
    planner(1, [['run_command', { CommandLine: '"ls"' }]], T0, 'DONE', {
      input_tokens: 40_000,
      cache_read_tokens: 130_000,
      output_tokens: 1_200,
    }),
    generic(2, T0, 'DONE', bigToolOutput),
    // Trailing error PLANNER_RESPONSE lacking token counts should not zero out context
    planner(3, [], T0, 'ERROR'),
  ];
  const reported = computeContext(rows);
  assert.equal(reported.source, 'reported');
  assert.equal(reported.tokens, 171_200);
  assert.equal(reported.inputTokens, 40_000);
  assert.equal(reported.cacheReadTokens, 130_000);
  assert.equal(reported.outputTokens, 1_200);
  assert.equal(reported.model, 'Orchestrator (Carbon)');
  assert.equal(reported.maxTokens, 1_000_000);
  assert.equal(reported.pct, 17);

  // Right after CHECKPOINT compaction before next PLANNER_RESPONSE: resets pre-checkpoint 171.2k bloat!
  const compacted = [
    ...rows,
    checkpoint(4, T1, { input_tokens: 175_000, output_tokens: 4_500 }),
    user(5, 'continue after compact', T1),
  ];
  const afterCpEst = computeContext(compacted);
  assert.equal(afterCpEst.source, 'estimated');
  assert.ok(afterCpEst.tokens >= 4_500 && afterCpEst.tokens < 6_000);

  // First PLANNER_RESPONSE after CHECKPOINT reports fresh post-compaction context
  const afterCpRep = computeContext([
    ...compacted,
    planner(6, [], T1, 'DONE', { model: 'claude-sonnet-5-5-medium', input_tokens: 18_000, cache_read_tokens: 2_000, output_tokens: 500 }),
  ]);
  assert.equal(afterCpRep.source, 'reported');
  assert.equal(afterCpRep.tokens, 20_500);
  assert.equal(afterCpRep.model, 'claude-sonnet-5-5-medium');
  assert.equal(afterCpRep.maxTokens, 200_000);
  assert.equal(afterCpRep.pct, 10);

  // Provider omits token counts completely -> Math.ceil(chars / 4) fallback
  const noTokens = computeContext([
    user(0, 'abcd'.repeat(100), T0),
    planner(1, [], T0, 'DONE', { content: 'efgh'.repeat(50) }),
  ]);
  assert.equal(noTokens.source, 'estimated');
  assert.ok(noTokens.tokens > 150);
});

test('watchdog: transcript fallback in Desktop sessions and ~/.agents/watchdog session alerts + state.json off', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-wd-'));
  const { brain } = makeBrain(home, [
    user(0, 'build feature', T0),
    planner(1, [['read_file', { Path: '"/a.js"' }], ['edit_file', { Path: '"/a.js"' }]], T0),
    generic(2, T1),
  ]);

  // 1. No watchdog session file -> live transcript fallback (1 step, 2 tools, live elapsedMs)
  const fallbackOv = buildOverview(brain, at(T0) + 45_000);
  assert.equal(fallbackOv.watchdog.enabled, true);
  assert.equal(fallbackOv.watchdog.status, 'ok');
  assert.equal(fallbackOv.watchdog.turnSteps, 1);
  assert.equal(fallbackOv.watchdog.turnTools, 2);
  assert.equal(fallbackOv.watchdog.elapsedMs, 45_000);
  assert.equal(fallbackOv.watchdog.alert, null);

  // 2. Fresh watchdog session file with active stall alert
  const wdDir = join(home, '.agents', 'watchdog');
  mkdirSync(join(wdDir, 'sessions'), { recursive: true });
  writeFileSync(join(wdDir, 'state.json'), JSON.stringify({ enabled: true }));
  writeFileSync(join(wdDir, 'sessions', `${CONV}.json`), JSON.stringify({
    cid: CONV,
    model: 'claude-opus-5-5-high',
    turn_started_epoch: at(T0) / 1000,
    turn_step_count: 6,
    turn_tool_count: 8,
    last_step: { ts: at(T1) / 1000 },
    last_alert: { kind: 'stall', detail: 'run_command hung >60s', ts: (at(T0) + 40_000) / 1000 },
  }));

  const alertOv = buildOverview(brain, at(T0) + 50_000);
  assert.equal(alertOv.watchdog.status, 'stall');
  assert.equal(alertOv.watchdog.turnSteps, 6);
  assert.equal(alertOv.watchdog.turnTools, 8);
  assert.equal(alertOv.watchdog.alert.kind, 'stall');
  assert.equal(alertOv.watchdog.alert.ageMs, 10_000);
  assert.equal(alertOv.context.model, 'claude-opus-5-5-high');
  assert.equal(alertOv.context.maxTokens, 200_000);

  // 3. Watchdog disabled via state.json -> status: 'off', no alert
  writeFileSync(join(wdDir, 'state.json'), JSON.stringify({ enabled: false }));
  const offOv = buildOverview(brain, at(T0) + 50_000);
  assert.equal(offOv.watchdog.enabled, false);
  assert.equal(offOv.watchdog.status, 'off');
  assert.equal(offOv.watchdog.alert, null);

  // 4. Stale session file from an earlier turn is ignored on a new turn
  writeFileSync(join(wdDir, 'state.json'), JSON.stringify({ enabled: true }));
  makeBrain(home, [
    user(0, 'build feature', T0),
    planner(1, [], T1),
    user(2, 'brand new turn', T2),
    planner(3, [['search_web', { query: '"mdn"' }]], T2),
    generic(4, T2),
  ]);
  const newTurnOv = buildOverview(brain, at(T2) + 5_000);
  assert.equal(newTurnOv.watchdog.status, 'ok');
  assert.equal(newTurnOv.watchdog.turnSteps, 1);
  assert.equal(newTurnOv.watchdog.turnTools, 1);
  assert.equal(newTurnOv.watchdog.alert, null);
});

test('used & usedDetails classify files, skills, memory, read-only bash paths, and web hosts/searches', () => {
  assert.deepEqual(
    bashPaths('cd /repo && cat src/index.ts && head -n 20 ~/docs/learnings/gotcha.md && rg -n "TODO" lib/util.js > /dev/null', '/home/u'),
    ['/repo/src/index.ts', '/home/u/docs/learnings/gotcha.md', '/repo/lib/util.js'],
  );

  const home = mkdtempSync(join(tmpdir(), 'margin-used-'));
  const { brain } = makeBrain(home, [
    user(0, 'audit repo', T0),
    planner(1, [
      ['read_file', { Path: '"/repo/src/app.mjs"' }],
      ['edit_file', { Path: '"/repo/src/app.mjs"' }],
      ['read_file', { Path: '"/home/u/.gemini/config/skills/taste-skill/SKILL.md"' }],
      ['read_file', { Path: '"/home/u/.agents/memories/architecture.md"' }],
      ['run_command', { CommandLine: '"cat /repo/docs/learnings/auth-flow.md && head -n 10 /repo/README.md"', toolSummary: '"Read docs"' }],
      ['search_web', { query: '"google material 3 tokens"' }],
      ['read_url_content', { Url: '"https://m3.material.io/styles/color/overview"' }],
    ], T0),
    generic(2, T0),
  ]);

  const ov = buildOverview(brain, at(T0) + 2000);
  assert.equal(ov.used.files, 3); // app.mjs x2 + README.md via bash
  assert.equal(ov.used.skills, 1);
  assert.equal(ov.used.memory, 2); // architecture.md + docs/learnings/auth-flow.md via bash
  assert.equal(ov.used.shell, 1);
  assert.equal(ov.used.web, 2);

  const appItem = ov.usedDetails.files.items.find((i) => i.name === '/repo/src/app.mjs');
  assert.equal(appItem.count, 2);
  assert.equal(appItem.short, 'app.mjs');
  assert.equal(appItem.reader, 'main');

  const bashFile = ov.usedDetails.files.items.find((i) => i.name === '/repo/README.md');
  assert.equal(bashFile.source, 'bash');

  assert.equal(ov.usedDetails.skills.items[0].short, 'taste-skill');
  assert.deepEqual(ov.usedDetails.memory.items.map((i) => i.short), ['auth-flow', 'architecture']);
  assert.equal(ov.usedDetails.web.items.find((i) => i.source === 'search').name, 'google material 3 tokens');
  assert.equal(ov.usedDetails.web.items.find((i) => i.source === 'read_url_content').short, 'm3.material.io');
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

test('stdio protocol: initialize, tools (crisp TAKE rules + steps.agents schema), app resource', async () => {
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
  assert.ok(intent.description.includes('breaks rule') && intent.description.includes('check labels'));
  assert.equal(intent.inputSchema.properties.steps.items.properties.agents.type, 'array');
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
