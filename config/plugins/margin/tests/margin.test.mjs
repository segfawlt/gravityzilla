import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyNow, enrichTake, merge, readTake, TAKE_MARKS } from '../lib/intent.mjs';
import {
  collectSessionSavedMemories,
  isAllowedMemoryPath,
  parseMemoryShellCommand,
  readMarkdownExcerpt,
  readMemoryDocument,
  renderMemoryViewHtml,
} from '../lib/memory.mjs';
import { buildOverview, computeStepProgress, hang, resolveOverview } from '../lib/overview.mjs';
import {
  buildHeuristicOutcome,
  buildOutcomePrompt,
  extractTurnExecution,
  isOutcomeRunning,
  mergeOutcome,
  parseOutcomeReply,
  writeOutcomeState,
} from '../lib/outcome.mjs';
import { brainDirOf, intentPath, outcomePath, topicsPath, transcriptFullPath } from '../lib/paths.mjs';
import {
  applyTopicsReply,
  buildTopicsPrompt,
  extractUserPrompts,
  isTopicsRunning,
  keptTopics,
  MERGE_TO,
  OVERVIEW_CAP,
  parseSummary,
  parseTopics,
  writeTopicsState,
} from '../lib/topics.mjs';
import { bashPaths, computeContext, stripUserText, summarize } from '../lib/transcript.mjs';
import { appHtml, handleCall, newestConversation } from '../mcp/server.mjs';
import { checkpoint, CONV, generic, makeBrain, planner, user } from './fixtures.mjs';

process.env.AGY_MARGIN_NO_TOPICS_WORKER = '1';
process.env.AGY_MARGIN_NO_OUTCOME_WORKER = '1';

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

test('merge & TAKE marks: strict readTake, optional why, 1-based now, prevAnswered, and new turn reset', () => {
  assert.deepEqual(TAKE_MARKS, { fine: '✓', concern: '!', against: '✗', unsure: '?' });
  assert.deepEqual(readTake({ stance: 'fine', label: 'small fix' }), {
    stance: 'fine',
    label: 'small fix',
    why: '',
    mark: '✓',
  });
  assert.equal(enrichTake({ stance: 'fine', label: 'clear', why: 'ok' }).mark, '✓');
  assert.equal(enrichTake({ stance: 'concern', label: 'risky', why: 'watch out' }).mark, '!');
  assert.equal(enrichTake({ stance: 'against', label: 'data loss', why: 'drops db' }).mark, '✗');
  assert.equal(enrichTake({ stance: 'unsure', label: 'needs repro', why: 'check logs' }).mark, '?');
  assert.equal(readTake({ stance: 'bogus', label: 'clear' }), null);
  assert.equal(readTake({ stance: 'fine', label: '   ' }), null);
  assert.equal(readTake(null), null);

  // 1-based now: now=1 activates step 1, now=2 activates step 2, now=3 activates step 3
  const a = merge(null, {
    wants: 'w',
    take: { stance: 'concern', label: 'x'.repeat(40), why: 'y'.repeat(120) },
    steps: [{ text: 'a', agents: ['scout'] }, 'b', 'c'],
    now: 1,
  }, 5);
  assert.equal(a.take.label.length, 16);
  assert.equal(a.take.why.length, 60);
  assert.equal(a.take.mark, '!');
  assert.deepEqual(a.steps[0].agents, ['scout']);
  assert.deepEqual(a.steps.map((s) => s.status), ['in_progress', 'pending', 'pending']);

  const b = merge(a, { now: 2 }, 5);
  assert.equal(b.wants, 'w');
  assert.deepEqual(b.steps.map((s) => s.status), ['completed', 'in_progress', 'pending']);

  const c = merge(b, { now: 3 }, 5);
  assert.deepEqual(c.steps.map((s) => s.status), ['completed', 'completed', 'in_progress']);

  // Invalid take preserves previous valid take from the same turn rather than synthesizing "? unsure"
  const kept = merge(c, { take: { stance: 'bogus', label: '', why: '' } }, 5);
  assert.equal(kept.take.stance, 'concern');
  assert.equal(kept.take.mark, '!');

  // 0-based now=0 is tolerated alongside fresh steps; standalone applyNow requires 1..steps.length
  const compat = merge(null, { wants: 'compat', steps: ['one', 'two'], now: 0 }, 5);
  assert.deepEqual(compat.steps.map((s) => s.status), ['in_progress', 'pending']);

  const pendingLast = [{ text: 'x', status: 'in_progress' }, { text: 'y', status: 'pending' }];
  assert.deepEqual(applyNow(pendingLast, 2).map((s) => s.status), ['completed', 'in_progress']);
  assert.deepEqual(applyNow(pendingLast, 0).map((s) => s.status), ['in_progress', 'pending']);
  assert.deepEqual(applyNow(pendingLast, 99).map((s) => s.status), ['in_progress', 'pending']);

  // prevAnswered preserves steps for bare { now } ping, but resets prior take when starting a new report
  const pingAfterAnswer = merge(b, { now: 3 }, 5, { prevAnswered: true });
  assert.equal(pingAfterAnswer.take.stance, 'concern');
  assert.deepEqual(pingAfterAnswer.steps.map((s) => s.status), ['completed', 'completed', 'in_progress']);
  const newReportAfterAnswer = merge(b, { wants: 'sub-task', steps: ['s1'] }, 5, { prevAnswered: true });
  assert.equal(newReportAfterAnswer.take, null);

  // New userStep resets cleanly and omits verdict
  const d = merge(c, { wants: 'next' }, 9);
  assert.deepEqual([d.steps, d.take, d.verdict], [[], null, undefined]);

  // Flattens multiline/extra-whitespace wants and keeps normal 160-char sentences untruncated
  const longWants = 'Refactor session auth validation cleanly without changing external routes or breaking any current callers. '.padEnd(160, 'x');
  const flatWants = merge(null, { wants: 'line one\n  line\t two\r\n  three' }, 10);
  assert.equal(flatWants.wants, 'line one line two three');
  assert.equal(merge(null, { wants: longWants }, 11).wants, longWants);
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
    now: 1,
  }, dirs);
  assert.equal(r.ok, true);

  const workingOv = buildOverview(brain, at(T0) + 1000);
  assert.equal(workingOv.status, 'working');
  assert.equal(workingOv.wants, 'first thing');
  assert.equal(workingOv.take.mark, '✓');
  assert.equal(workingOv.verdict, undefined);
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
  assert.equal(ov.used.memory, 1); // architecture.md only
  assert.equal(ov.used.learnings, 1); // docs/learnings/auth-flow.md via bash
  assert.equal(ov.used.shell, 1);
  assert.equal(ov.used.web, 2);

  const appItem = ov.usedDetails.files.items.find((i) => i.name === '/repo/src/app.mjs');
  assert.equal(appItem.count, 2);
  assert.equal(appItem.short, 'app.mjs');
  assert.equal(appItem.reader, 'main');

  const bashFile = ov.usedDetails.files.items.find((i) => i.name === '/repo/README.md');
  assert.equal(bashFile.source, 'bash');

  assert.equal(ov.usedDetails.skills.items[0].short, 'taste-skill');
  assert.deepEqual(ov.usedDetails.memory.items.map((i) => i.short), ['architecture']);
  assert.deepEqual(ov.usedDetails.learnings.items.map((i) => i.short), ['auth-flow']);
  assert.equal(ov.usedDetails.learnings.items[0].group, 'read');
  assert.equal(ov.usedDetails.learnings.items[0].action, 'read');
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

test('an empty call is a no-op without writing intent', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { brain, dirs } = makeBrain(home, [user(0, 'x', T0)]);
  const r = handleCall({}, dirs);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'ok');
  assert.equal(r.structured, undefined);
  assert.equal(existsSync(intentPath(brain)), false);
});

test('stdio protocol: initialize, data-only margin_intent tool (no inline MCP App UI), and rejected resources', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn('node', [new URL('../mcp/server.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  send(1, 'initialize', { protocolVersion: '2025-06-18' });
  send(2, 'tools/list');
  send(3, 'resources/list');
  send(4, 'resources/read', { uri: 'ui://margin/overview.html' });
  send(5, 'nope');
  for (let i = 0; i < 50 && lines.length < 5; i++) await new Promise((r) => setTimeout(r, 40));
  child.kill();
  const by = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.deepEqual(Object.keys(by[1].result.capabilities), ['tools']);
  assert.equal(by[2].result.tools.length, 1);
  const [intent] = by[2].result.tools;
  assert.equal(intent.name, 'margin_intent');
  assert.equal(intent._meta, undefined);
  assert.ok(intent.description.includes('breaks rule') && intent.description.includes('check labels'));
  assert.ok(intent.description.includes('everyday words'));
  assert.equal(intent.description.includes('verdict'), false);
  assert.equal(intent.inputSchema.properties.now.minimum, 1);
  assert.equal(intent.inputSchema.properties.verdict, undefined);
  assert.equal(intent.inputSchema.properties.steps.items.properties.agents.type, 'array');
  assert.match(intent.inputSchema.properties.wants.description, /core goal/i);
  assert.ok(intent.inputSchema.properties.wants.description.includes('60ch'));
  assert.match(intent.inputSchema.properties.wants.description, /everyday words/i);
  assert.match(intent.inputSchema.properties.take.properties.why.description, /40ch/);
  assert.match(intent.inputSchema.properties.steps.items.properties.text.description, /40ch/);
  assert.ok(by[3].error && by[4].error && by[5].error);
  const html = appHtml();
  assert.ok(!html.includes('/*APP_JS*/') && !html.includes('/*APP_CSS*/'));
  assert.equal(html.includes('sec-verdict'), false);
  assert.ok(html.includes('sec-session') && html.includes('sec-topic'));
});

test('resolveOverview supports ETag caching and conversation fallback, and appHtml injects preload.js for sidecars', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-'));
  const { dirs } = makeBrain(home, [user(0, 'first ask', T0), planner(1, [], T0)]);
  const first = resolveOverview({ conversationId: 'invalid-id' }, dirs);
  assert.equal(first.conversationId, CONV);
  assert.equal(first.overview.ask, 'first ask');
  assert.match(first.etag, /^[0-9a-f]{16}$/);

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
  assert.equal(mcpDoc.includes('fonts.googleapis.com'), false);
  assert.equal(sidecarDoc.includes('<script src="/preload.js"></script>'), true);
  assert.equal(sidecarDoc.includes('fonts.googleapis.com'), true);

  // Embedded Google Sans Flex & Google Sans Code slices keep unicode-range descriptors and unified HUD footer
  assert.ok(mcpDoc.includes("font-family: 'Google Sans Flex'") && mcpDoc.includes("font-family: 'Google Sans Code'"));
  assert.ok(mcpDoc.includes('unicode-range:') && mcpDoc.includes('class="hud-footer"'));
  assert.equal(mcpDoc.includes('id="status-bar"'), false);

  // Ask renders always-expanded wants only (no clamp, toggle, or raw-prompt fallback)
  assert.ok(mcpDoc.includes('id="ask" class="ask-text"'));
  assert.equal(mcpDoc.includes('ask-toggle-btn'), false);
  assert.equal(mcpDoc.includes('Show more'), false);
  assert.equal(mcpDoc.includes('ask-text clamp'), false);
  assert.equal(mcpDoc.includes('askExpanded'), false);
  assert.equal(mcpDoc.includes('target.wants || target.ask'), false);
});

test('app.css isolates muted/faint text tokens from host shadcn --muted inline overrides', () => {
  const sidecarDoc = appHtml({ sidecar: true });
  const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8');

  // Theme blocks must scope onto body so inline host tokens on :root cannot clobber Margin tokens.
  assert.match(sidecarDoc, /:root,\s*body,\s*:root\[data-theme="light"\],\s*:root\[data-theme="light"\]\s*body\s*\{[^}]*--fg-muted:/s);
  assert.match(sidecarDoc, /:root\[data-theme="dark"\],\s*:root\[data-theme="dark"\]\s*body\s*\{[^}]*--fg-muted:/s);
  assert.match(sidecarDoc, /--fg-faint:/);

  // Never consume shadcn/host --muted or --faint variables directly in app.css.
  assert.equal(/var\(--muted\)/.test(css), false);
  assert.equal(/var\(--faint\)/.test(css), false);
  assert.equal(/color:\s*var\(--muted\)/.test(css), false);
});

test('topics: prompt-only SESSION & TOPIC lifecycle, merge cap, and ov.about stale running', () => {
  const rows = [
    user(0, 'Fix expiry boundary in isValid', T0),
    planner(1, [['read_file', { Path: '"/a.js"' }]], T0),
    { step_index: 2, source: 'SYSTEM', type: 'USER_INPUT', status: 'DONE', created_at: T1, content: 'injected system msg' },
    user(3, 'Run tests and show git diff', T1),
  ];
  const prompts = extractUserPrompts(rows);
  assert.deepEqual(prompts, ['Fix expiry boundary in isValid', 'Run tests and show git diff']);

  // Initial full ask (OVERVIEW_ASK)
  const initBuilt = buildTopicsPrompt(prompts, null);
  assert.equal(initBuilt.mode.incremental, false);
  assert.equal(initBuilt.mode.merge, false);
  assert.ok(initBuilt.prompt.includes('Group them into topics'));
  assert.ok(initBuilt.prompt.includes('telegraphic plain words'));
  assert.ok(initBuilt.prompt.includes('at most 5 words'));

  const reply1 = '> Fixing an expiry boundary check in validation logic.\n- Fix expiry boundary check';
  assert.equal(parseSummary(reply1), 'Fixing an expiry boundary check in validation logic.');
  assert.deepEqual(parseTopics(reply1), ['Fix expiry boundary check']);

  const st1 = applyTopicsReply(null, reply1, prompts.length, initBuilt.mode, T1);
  assert.equal(st1.ok, true);
  assert.equal(st1.state.at, 2);
  assert.deepEqual(st1.state.topics, ['Fix expiry boundary check']);

  // Incremental tail update (LATEST_ASK) replaces/appends only the tail
  const prompts3 = [...prompts, 'Now add auth test coverage'];
  const incBuilt = buildTopicsPrompt(prompts3, st1.state);
  assert.equal(incBuilt.mode.incremental, true);
  assert.equal(incBuilt.mode.merge, false);
  assert.ok(incBuilt.prompt.includes('Current session line'));
  assert.ok(incBuilt.prompt.includes('telegraphic plain words'));

  const reply2 = '> Fixing an expiry boundary check in validation logic.\n- Fix expiry boundary check\n- Add auth test coverage';
  const st2 = applyTopicsReply(st1.state, reply2, prompts3.length, incBuilt.mode, T2);
  assert.equal(st2.ok, true);
  assert.deepEqual(st2.state.topics, ['Fix expiry boundary check', 'Add auth test coverage']);

  // Cap merge (>= OVERVIEW_CAP) + keptTopics validation
  const manyTopics = Array.from({ length: OVERVIEW_CAP }, (_, i) => `Topic ${i + 1}`);
  const capBuilt = buildTopicsPrompt(prompts3, { at: 2, summary: 'Session summary.', topics: manyTopics });
  assert.equal(capBuilt.mode.incremental, true);
  assert.equal(capBuilt.mode.merge, true);
  assert.ok(capBuilt.prompt.includes(`at most ${MERGE_TO} lines`));
  assert.equal(keptTopics(manyTopics, [...manyTopics.slice(0, 10), 'Topic 27', 'Topic 28', 'Topic 29', 'Updated 30']), true);
  assert.equal(keptTopics(manyTopics, ['Missing recent ones']), false);

  // buildOverview exposes ov.about and expires stale running state
  const home = mkdtempSync(join(tmpdir(), 'margin-topics-'));
  const { brain } = makeBrain(home, [user(0, 'check topics', T0)]);
  writeTopicsState(topicsPath(brain), {
    at: 1,
    summary: 'Updating validation logic.',
    topics: ['Topic one', 'Topic two'],
    running: true,
    failed: false,
    startedAtMs: at(T0) + 1000,
    updatedAt: T0,
  });
  const activeOv = buildOverview(brain, at(T0) + 5000);
  assert.equal(activeOv.about.summary, 'Updating validation logic.');
  assert.deepEqual(activeOv.about.topics, ['Topic one', 'Topic two']);
  assert.equal(activeOv.about.running, true);
  assert.equal(isTopicsRunning({ running: true, startedAtMs: at(T0) + 1000 }, at(T0) + 120_000), false);
  const staleOv = buildOverview(brain, at(T0) + 120_000);
  assert.equal(staleOv.about.running, false);
});

test('outcome: extractTurnExecution + buildHeuristicOutcome classify clear, unverified, failed, needs_input, caveats, and truncated full replies', () => {
  // 1. Clean Q&A -> clear, verifyState none
  const qaExec = extractTurnExecution([
    planner(1, [['read_file', { Path: '"/repo/a.js"' }]], T0),
    generic(2, T0),
    planner(3, [], T0, 'DONE', { content: '**TL;DR** — Auth validates JWT expiry strictly.\n\nDetails in `auth.js`.' }),
  ]);
  assert.equal(qaExec.verifyState, 'none');
  assert.equal(qaExec.evidence, '');
  const qaHeur = buildHeuristicOutcome(qaExec);
  assert.equal(qaHeur.kind, 'clear');
  assert.equal(qaHeur.mark, '✓');
  assert.match(qaHeur.summary, /Auth validates JWT expiry strictly/);

  // 2. Edit + passing node --test -> clear, 1 file edited · checks passed
  const passExec = extractTurnExecution([
    planner(1, [['edit_file', { Path: '"/repo/a.js"' }]], T0),
    generic(2, T0),
    planner(3, [['run_command', { CommandLine: '"node --test tests/margin.test.mjs"' }]], T0),
    generic(4, T0, 'DONE', 'Command exited with code 0.\npass 18'),
    planner(5, [], T0, 'DONE', { content: '**TL;DR** — Fixed validation guard and verified tests.' }),
  ]);
  assert.equal(passExec.verifyState, 'passed');
  assert.equal(passExec.evidence, '1 file edited · checks passed');
  assert.equal(buildHeuristicOutcome(passExec).kind, 'clear');

  // 3. Edit + no check run -> caveats (unverified)
  const unvExec = extractTurnExecution([
    planner(1, [['write_file', { TargetFile: '"/repo/b.js"' }]], T0),
    generic(2, T0),
    planner(3, [], T0, 'DONE', { content: '**TL;DR** — Wrote new helper.' }),
  ]);
  assert.equal(unvExec.verifyState, 'unverified');
  assert.equal(unvExec.evidence, '1 file edited · no check run');
  const unvHeur = buildHeuristicOutcome(unvExec);
  assert.equal(unvHeur.kind, 'caveats');
  assert.equal(unvHeur.label, 'unverified');

  // 4. Edit + failing test command -> blocked (check failed)
  const failExec = extractTurnExecution([
    planner(1, [['edit_file', { Path: '"/repo/a.js"' }]], T0),
    generic(2, T0),
    planner(3, [['run_command', { CommandLine: '"pytest tests/"' }]], T0),
    generic(4, T0, 'DONE', 'Command exited with code 1.\n1 failed'),
    planner(5, [], T0, 'DONE', { content: '**TL;DR** — Updated parser, one test still fails.' }),
  ]);
  assert.equal(failExec.verifyState, 'failed');
  assert.equal(failExec.evidence, '1 file edited · check failed');
  const failHeur = buildHeuristicOutcome(failExec);
  assert.equal(failHeur.kind, 'blocked');
  assert.equal(failHeur.label, 'check failed');

  // 5. **Next:**, Decision, and trailing ? -> needs_input (ignoring '?' inside fenced code blocks)
  const nextHeur = buildHeuristicOutcome(extractTurnExecution([
    planner(1, [], T0, 'DONE', { content: '**TL;DR** — Ready to switch.\n\n**Next:** say "go" and I\'ll apply the migration.' }),
  ]));
  assert.equal(nextHeur.kind, 'needs_input');
  assert.match(nextHeur.items[0], /say "go"/);

  const decHeur = buildHeuristicOutcome(extractTurnExecution([
    planner(1, [], T0, 'DONE', { content: '### Decision — Choose cache backend\n\n| **#** | **option** | **tradeoff** |\n| **A** | SQLite | simple |' }),
  ]));
  assert.equal(decHeur.kind, 'needs_input');

  const qHeur = buildHeuristicOutcome(extractTurnExecution([
    planner(1, [], T0, 'DONE', { content: 'Should I also remove the old config file?' }),
  ]));
  assert.equal(qHeur.kind, 'needs_input');

  const codeFenceNotQuestion = buildHeuristicOutcome(extractTurnExecution([
    planner(1, [], T0, 'DONE', { content: '**TL;DR** — Added ternary helper.\n\n```js\nconst ok = a ? b : c;\n```' }),
  ]));
  assert.equal(codeFenceNotQuestion.kind, 'clear');

  // 6. Truncated transcript.jsonl falls back to transcript_full.jsonl to recover **Not covered:**
  const home = mkdtempSync(join(tmpdir(), 'margin-full-'));
  const compactRow = planner(3, [], T0, 'DONE', {
    content: '**TL;DR** — Finished core fix.\n<truncated>',
    truncated_fields: ['content'],
  });
  const fullRow = planner(3, [], T0, 'DONE', {
    content: '**TL;DR** — Finished core fix.\n\n**Not covered:**\n- Legacy v1 endpoint still returns 500 on empty body\n- Cron cleanup skipped',
  });
  const { brain } = makeBrain(home, [user(0, 'fix bug', T0), planner(1, [['read_file', { Path: '"/repo/a.js"' }]], T0), generic(2, T0), compactRow]);
  writeFileSync(transcriptFullPath(brain), [
    user(0, 'fix bug', T0),
    planner(1, [['read_file', { Path: '"/repo/a.js"' }]], T0),
    generic(2, T0),
    fullRow,
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const fullExec = extractTurnExecution([compactRow], { brain });
  const fullHeur = buildHeuristicOutcome(fullExec);
  assert.equal(fullHeur.kind, 'caveats');
  assert.deepEqual(fullHeur.items, [
    'Legacy v1 endpoint still returns 500 on empty body',
    'Cron cleanup skipped',
  ]);
});

test('outcome: parseOutcomeReply, mergeOutcome guardrails, prompt builder, and stale running expiry', () => {
  const valid = parseOutcomeReply([
    'STATUS: caveats',
    'LABEL: out-of-scope note',
    'SUMMARY: Core patch landed cleanly, with one unrelated flaw noted.',
    '- Pre-existing timeout bug in legacy worker',
  ].join('\n'));
  assert.equal(valid.ok, true);
  assert.equal(valid.kind, 'caveats');
  assert.equal(valid.label, 'out-of-scope note');
  assert.deepEqual(valid.items, ['Pre-existing timeout bug in legacy worker']);

  assert.equal(parseOutcomeReply('garbage reply').ok, false);

  const workerClear = {
    userStep: 0,
    finalStep: 3,
    kind: 'clear',
    label: 'all clear',
    summary: 'Everything looks good.',
    items: [],
  };
  const baseHeur = { kind: 'clear', mark: '✓', label: 'all clear', summary: 'Done.', items: [], evidence: '', verifyState: 'none', source: 'heuristic' };

  // Hard guardrail: unverified edits cannot stay `clear` even if Flash said `clear`
  const guardUnv = mergeOutcome({
    heuristic: { ...baseHeur, kind: 'caveats', label: 'unverified' },
    stored: workerClear,
    userStep: 0,
    finalStep: 3,
    exec: { verifyState: 'unverified', evidence: '1 file edited · no check run', askedQuestion: false, unresolvedErrors: false },
  });
  assert.equal(guardUnv.kind, 'caveats');
  assert.equal(guardUnv.label, 'unverified');
  assert.equal(guardUnv.archiveSafe, false);

  // Hard guardrail: failed checks cannot stay `clear` or `caveats`
  const guardFail = mergeOutcome({
    heuristic: { ...baseHeur, kind: 'blocked', label: 'check failed' },
    stored: { ...workerClear, kind: 'caveats', label: 'minor issue' },
    userStep: 0,
    finalStep: 3,
    exec: { verifyState: 'failed', evidence: '1 file edited · check failed', askedQuestion: false, unresolvedErrors: true },
  });
  assert.equal(guardFail.kind, 'blocked');
  assert.equal(guardFail.label, 'check failed');
  assert.equal(guardFail.archiveSafe, false);

  // Hard guardrail: ask_question cannot stay `clear`
  const guardAsk = mergeOutcome({
    heuristic: { ...baseHeur, kind: 'needs_input', label: 'needs input' },
    stored: workerClear,
    userStep: 0,
    finalStep: 3,
    exec: { verifyState: 'none', evidence: '', askedQuestion: true, unresolvedErrors: false },
  });
  assert.equal(guardAsk.kind, 'needs_input');
  assert.equal(guardAsk.archiveSafe, false);

  // Valid clean worker merge -> archiveSafe true
  const cleanMerged = mergeOutcome({
    heuristic: baseHeur,
    stored: workerClear,
    userStep: 0,
    finalStep: 3,
    exec: { verifyState: 'passed', evidence: '1 file edited · checks passed', askedQuestion: false, unresolvedErrors: false },
  });
  assert.equal(cleanMerged.kind, 'clear');
  assert.equal(cleanMerged.source, 'worker');
  assert.equal(cleanMerged.archiveSafe, true);

  // Running state expires after 60s
  assert.equal(isOutcomeRunning({ running: true, startedAtMs: at(T0) }, at(T0) + 10_000), true);
  assert.equal(isOutcomeRunning({ running: true, startedAtMs: at(T0) }, at(T0) + 70_000), false);

  // Prompt builder keeps head + tail when finalReply > 7000 chars
  const bigReply = `**TL;DR** — Head summary.\n${'x'.repeat(8000)}\n**Next:** say "go" to deploy.`;
  const prompt = buildOutcomePrompt({
    ask: 'deploy it',
    wants: 'Deploy worker safely',
    steps: [{ text: 'Check config', status: 'completed' }],
    exec: { editedFiles: ['/a/b.js'], editedCount: 1, shellRuns: 1, shellErrors: 0, verifyState: 'passed', askedQuestion: false, finalReply: bigReply },
  });
  assert.ok(prompt.includes('Head summary') && prompt.includes('say "go" to deploy') && prompt.includes('[...]'));
});

test('outcome: buildOverview prevents false-green Plan auto-complete, preserves previous.outcome, updates ETag, and renders Result in HTML', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-ov-out-'));
  const { brain, dirs } = makeBrain(home, [
    user(0, 'refactor auth', T0),
    planner(1, [['read_file', { Path: '"/repo/auth.js"' }]], T0),
    generic(2, T0),
    planner(3, [], T0, 'DONE', { content: '### Decision — Token lifetime\n\n**Next:** Pick A or B.' }),
  ]);
  handleCall({
    conversation_id: CONV,
    wants: 'Refactor auth checks',
    take: { stance: 'fine', label: 'clear' },
    steps: ['Inspect auth', 'Apply change', 'Run tests'],
    now: 2,
  }, dirs);

  // needs_input does NOT auto-complete remaining pending/in_progress Plan steps!
  const askOv = buildOverview(brain, at(T0) + 1000);
  assert.equal(askOv.status, 'done');
  assert.equal(askOv.outcome.kind, 'needs_input');
  assert.deepEqual(askOv.steps.map((s) => s.status), ['completed', 'in_progress', 'pending']);

  const r1 = resolveOverview({ conversationId: CONV }, dirs);
  assert.match(r1.etag, /^[0-9a-f]{16}$/);

  // Writing outcome.json for this turn updates ETag and merges worker result
  writeOutcomeState(outcomePath(brain), {
    userStep: 0,
    finalStep: 3,
    kind: 'needs_input',
    label: 'choose option',
    summary: 'Waiting on your choice between A and B.',
    items: ['Pick A or B before step 2 runs'],
    running: false,
    failed: false,
    targetUserStep: 0,
    targetFinalStep: 3,
    startedAtMs: 0,
    updatedAt: T0,
  });
  const r2 = resolveOverview({ conversationId: CONV, etag: r1.etag }, dirs);
  assert.equal(r2.unchanged, undefined);
  assert.equal(r2.overview.outcome.source, 'worker');
  assert.equal(r2.overview.outcome.label, 'choose option');

  // New user turn starts planning: previous.outcome is preserved and previous.steps stay incomplete for needs_input
  makeBrain(home, [
    user(0, 'refactor auth', T0),
    planner(1, [['read_file', { Path: '"/repo/auth.js"' }]], T0),
    generic(2, T0),
    planner(3, [], T0, 'DONE', { content: '### Decision — Token lifetime\n\n**Next:** Pick A or B.' }),
    user(4, 'go with A', T1),
  ]);
  const planOv = buildOverview(brain, at(T1) + 1000);
  assert.equal(planOv.status, 'planning');
  assert.equal(planOv.outcome, null);
  assert.ok(planOv.previous?.outcome);
  assert.equal(planOv.previous.outcome.kind, 'needs_input');
  assert.deepEqual(planOv.previous.steps.map((s) => s.status), ['completed', 'in_progress', 'pending']);

  // UI bundle includes Result (#sec-outcome) and keeps sec-verdict absent
  const doc = appHtml();
  assert.ok(doc.includes('id="sec-outcome"') && doc.includes('>Result<'));
  assert.equal(doc.includes('sec-verdict'), false);
});

test('memory & learnings: hermetic isolation, compound captures, agent-memory extraction, CLI commands, and deduplication', () => {
  // 1. Bare hermetic brain never leaks real ~/.agents/memories or ~/.agents/compound
  const emptyHome = mkdtempSync(join(tmpdir(), 'margin-mem-empty-'));
  const { brain: emptyBrain } = makeBrain(emptyHome, [user(0, 'hello', T0), planner(1, [], T0)]);
  const emptyOv = buildOverview(emptyBrain, at(T0) + 1000);
  assert.equal(emptyOv.used.memory, 0);
  assert.deepEqual(emptyOv.usedDetails.memory.items, []);
  assert.equal(emptyOv.used.learnings, 0);
  assert.deepEqual(emptyOv.usedDetails.learnings.items, []);

  // 2. Populated hermetic repo + memoriesDir + compoundDir
  const home = mkdtempSync(join(tmpdir(), 'margin-mem-'));
  const repo = join(home, 'Projects', 'demo');
  const learningDir = join(repo, 'docs', 'learnings', 'logic-errors');
  mkdirSync(learningDir, { recursive: true });
  const cacheDoc = join(learningDir, 'cache-race.md');
  const readmeDoc = join(repo, 'docs', 'learnings', 'README.md');
  writeFileSync(cacheDoc, [
    '---',
    'title: "WAL reader cache race"',
    'category: logic-errors',
    '---',
    '# WAL Reader Cache Race',
    '',
    'Cache key must include WAL mtime so sidecar polling sees fresh rows immediately.',
  ].join('\n'));
  writeFileSync(readmeDoc, '# Learnings Index\n');

  const slug = '--' + repo.replace(/^\/+/, '').replace(/\//g, '-') + '--';
  const memRoot = join(home, '.agents', 'memories');
  const wsMemDir = join(memRoot, slug);
  const rolloutDir = join(wsMemDir, 'rollout_summaries');
  mkdirSync(rolloutDir, { recursive: true });
  const memMdPath = join(wsMemDir, 'MEMORY.md');
  writeFileSync(memMdPath, '# Demo Memory\n\n- Always verify WAL mtime in cache key.\n');

  const cidShort = CONV.slice(0, 8);
  const rolloutMain = join(rolloutDir, `2026-01-01_${cidShort}_wal-cache-architecture.md`);
  const rolloutSib = join(rolloutDir, `2026-01-01_${cidShort}_sidecar-polling.md`);
  writeFileSync(rolloutMain, `# wal-cache-architecture (agy:${CONV})\n\nUse read-only SQLite with WAL mtime cache key.\n`);
  writeFileSync(rolloutSib, `# sidecar-polling (agy:${CONV})\n\nSidecar caches overview by 16-char ETag.\n`);

  const db = new DatabaseSync(join(memRoot, 'memory.db'));
  db.exec(`
    CREATE TABLE processed_threads (thread_id TEXT PRIMARY KEY, harness TEXT, workspace_slug TEXT, mtime REAL, stage1_status TEXT, consolidated INTEGER, rollout_file TEXT, updated_at TEXT);
    CREATE TABLE session_workspaces (conversation_id TEXT PRIMARY KEY, workspace_path TEXT, workspace_slug TEXT, updated_at REAL);
    CREATE TABLE memory_injections (cid TEXT PRIMARY KEY, workspace_slug TEXT, cwd TEXT, injected_at INTEGER, payload_chars INTEGER, mem_lines INTEGER, rollout_count INTEGER, skills_list TEXT);
  `);
  db.prepare('INSERT INTO processed_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `agy:${CONV}`, 'agy', slug, 1000, 'extracted', 1, rolloutMain, T1,
  );
  db.prepare('INSERT INTO session_workspaces VALUES (?, ?, ?, ?)').run(CONV, repo, slug, 1000);
  db.close();

  const compDir = join(home, '.agents', 'compound');
  mkdirSync(compDir, { recursive: true });
  writeFileSync(join(compDir, 'audit.jsonl'), [
    JSON.stringify({
      ts: T0,
      cid: CONV,
      cwd: repo,
      turn_key: '0:abc',
      outcome: 'CAPTURED',
      files: ['docs/learnings/logic-errors/cache-race.md', 'docs/learnings/README.md'],
      summary: 'Fallback summary',
    }),
  ].join('\n') + '\n');

  // Turn 0 captured cache-race.md; Turn 2 (current) writes cache-race.md again + remembers a note + searches memory
  const { brain } = makeBrain(home, [
    user(0, 'fix cache race', T0),
    planner(1, [['write_file', { Path: JSON.stringify(cacheDoc) }], ['write_file', { Path: JSON.stringify(readmeDoc) }]], T0),
    generic(2, T0),
    planner(3, [], T0),
    user(4, 'verify and remember', T1),
    planner(5, [
      ['edit_file', { Path: JSON.stringify(cacheDoc) }],
      ['run_command', { CommandLine: JSON.stringify(`cd ${repo} && ~/.local/bin/agy-compound record --files docs/learnings/logic-errors/cache-race.md --summary "Dedup cd + relative"`) }],
      ['run_command', { CommandLine: JSON.stringify(`~/.local/bin/agent-memory remember --cwd ${repo} "Check WAL mtime before cache hit"`) }],
      ['run_command', { CommandLine: JSON.stringify('agent-memory search "wal cache" && agent-memory drift') }],
    ], T1),
    generic(6, T1),
  ]);

  const ov = buildOverview(brain, at(T1) + 2000);
  const memItems = ov.usedDetails.memory.items;
  const memSaved = memItems.filter((it) => it.group === 'saved');
  const memReads = memItems.filter((it) => it.group !== 'saved');

  // Memory contains ONLY rollouts, remember note, and memory reads — never docs/learnings/*
  assert.equal(memItems.some((it) => it.filePath === cacheDoc || it.filePath === readmeDoc), false);
  assert.equal(memSaved.filter((it) => it.action === 'consolidated').length, 2);
  const walRollout = memSaved.find((it) => it.filePath === rolloutMain);
  assert.equal(walRollout.short, 'wal-cache-architecture');
  assert.match(walRollout.summary, /read-only SQLite/i);

  const remItem = memSaved.find((it) => it.action === 'remembered');
  assert.ok(remItem);
  assert.equal(remItem.filePath, memMdPath);
  assert.equal(remItem.summary, 'Check WAL mtime before cache hit');

  assert.deepEqual(memReads.map((it) => it.action), ['drift', 'search']);
  assert.equal(ov.usedDetails.memory.savedCount, 3);
  assert.equal(ov.usedDetails.memory.readCount, 2);
  assert.equal(ov.used.memory, 5);

  // Learnings contains cache-race.md deduplicated to 1 entry, excludes README.md, rollouts, and remember note
  const learnItems = ov.usedDetails.learnings.items;
  const learnSaved = learnItems.filter((it) => it.group === 'saved');
  assert.equal(learnSaved.filter((it) => it.filePath === cacheDoc).length, 1);
  assert.equal(learnItems.some((it) => it.filePath === readmeDoc), false);
  assert.equal(learnItems.some((it) => it.filePath === rolloutMain || it.action === 'remembered'), false);
  assert.equal(learnSaved.find((it) => it.filePath === cacheDoc).earlier, false); // touched in current turn
  assert.match(learnSaved.find((it) => it.filePath === cacheDoc).summary, /WAL reader cache race/);
  assert.equal(ov.usedDetails.learnings.savedCount, 1);
  assert.equal(ov.usedDetails.learnings.readCount, 0);
  assert.equal(ov.used.learnings, 1);

  // Earlier-turn capture gets earlier=true on a clean follow-up turn under learnings (and absent from memory)
  makeBrain(home, [
    user(0, 'fix cache race', T0),
    planner(1, [['write_file', { Path: JSON.stringify(cacheDoc) }]], T0),
    generic(2, T0),
    planner(3, [], T0),
    user(4, 'just ask a question', T1),
    planner(5, [], T1),
  ]);
  const followOv = buildOverview(brain, at(T1) + 1000);
  const earlierCache = followOv.usedDetails.learnings.items.find((it) => it.filePath === cacheDoc);
  assert.equal(earlierCache.earlier, true);
  assert.equal(followOv.usedDetails.memory.items.some((it) => it.filePath === cacheDoc), false);

  // 3. Edge cases: standalone README.md, direct memory write, and subagent learning read
  const edgeHome = mkdtempSync(join(tmpdir(), 'margin-mem-edge-'));
  const edgeRepo = join(edgeHome, 'repo');
  const edgeLearnDir = join(edgeRepo, 'docs', 'learnings');
  const edgeMemDir = join(edgeHome, '.agents', 'memories', '--edge--');
  mkdirSync(edgeLearnDir, { recursive: true });
  mkdirSync(edgeMemDir, { recursive: true });
  const edgeReadme = join(edgeLearnDir, 'README.md');
  const edgeSubLearn = join(edgeLearnDir, 'sub-gotcha.md');
  const edgeMemMd = join(edgeMemDir, 'MEMORY.md');
  writeFileSync(edgeReadme, '# Index\n');
  writeFileSync(edgeSubLearn, '# Subagent Gotcha\n');
  writeFileSync(edgeMemMd, '# Edge Memory\n');

  const subConv = 'ffff1111-2222-4333-8444-555555555555';
  makeBrain(edgeHome, [
    { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: T0, content: 'brief' },
    planner(1, [['read_file', { Path: JSON.stringify(edgeSubLearn) }]], T0),
    generic(2, T0),
    planner(3, [], T0),
  ], subConv);

  const { brain: edgeBrain } = makeBrain(edgeHome, [
    user(0, 'edge checks', T0),
    planner(1, [
      ['write_file', { Path: JSON.stringify(edgeReadme) }],
      ['write_file', { Path: JSON.stringify(edgeMemMd) }],
      ['invoke_subagent', { Role: '"Learnings Scout"', TypeName: '"research"', Prompt: '"Read learning"' }],
    ], T0),
    generic(2, T0, 'DONE', `Created the following subagent:\n{\n  "conversationId": "${subConv}"\n}`),
  ]);
  const edgeOv = buildOverview(edgeBrain, at(T0) + 2000);
  assert.equal(edgeOv.used.memory, 1);
  assert.equal(edgeOv.usedDetails.memory.savedCount, 1);
  assert.equal(edgeOv.usedDetails.memory.agents, 0);
  assert.equal(edgeOv.usedDetails.memory.items[0].filePath, edgeMemMd);
  assert.equal(edgeOv.used.learnings, 2); // main write_file README.md + subagent read_file sub-gotcha.md
  assert.equal(edgeOv.usedDetails.learnings.savedCount, 1);
  assert.equal(edgeOv.usedDetails.learnings.agents, 1);
  assert.equal(edgeOv.usedDetails.learnings.items.some((it) => it.filePath === edgeReadme && it.reader === 'main'), true);
  assert.equal(edgeOv.usedDetails.learnings.items.some((it) => it.name === edgeSubLearn && it.reader === 'Learnings Scout'), true);
});

test('memory viewer: allowlist blocks traversal, symlinks outside allowlist, blocked dirs/files, and escapes HTML', () => {
  const home = mkdtempSync(join(tmpdir(), 'margin-view-'));
  const memDir = join(home, '.agents', 'memories', '--demo--');
  const learningDir = join(home, 'repo', 'docs', 'learnings', 'bugs');
  const outsideDir = join(home, 'private');
  const sshDir = join(home, '.ssh');
  mkdirSync(memDir, { recursive: true });
  mkdirSync(learningDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  mkdirSync(sshDir, { recursive: true });

  const allowedMem = join(memDir, 'MEMORY.md');
  const allowedLearning = join(learningDir, 'xss-guard.md');
  const envFile = join(memDir, '.env.local');
  const keyFile = join(memDir, 'secret.key');
  const sshMd = join(sshDir, 'notes.md');
  const outsideMd = join(outsideDir, 'secret.md');
  const symEscape = join(memDir, 'escape-link.md');
  const bigFile = join(memDir, 'huge.md');

  writeFileSync(allowedMem, '# Memory\n\n- Safe note with `code`.\n');
  writeFileSync(allowedLearning, '# XSS Check\n\n<script>alert(1)</script>\n');
  writeFileSync(envFile, 'SECRET=1\n');
  writeFileSync(keyFile, 'KEY\n');
  writeFileSync(sshMd, 'ssh secret\n');
  writeFileSync(outsideMd, 'outside secret\n');
  symlinkSync(outsideMd, symEscape);
  writeFileSync(bigFile, 'x'.repeat(270 * 1024));

  const opts = { home, memoriesDir: join(home, '.agents', 'memories') };
  assert.ok(isAllowedMemoryPath(allowedMem, opts));
  assert.ok(isAllowedMemoryPath(allowedLearning, opts));
  assert.equal(isAllowedMemoryPath('/etc/passwd', opts), null);
  assert.equal(isAllowedMemoryPath(join(memDir, '..', '..', 'private', 'secret.md'), opts), null);
  assert.equal(isAllowedMemoryPath(envFile, opts), null);
  assert.equal(isAllowedMemoryPath(keyFile, opts), null);
  assert.equal(isAllowedMemoryPath(sshMd, opts), null);
  assert.equal(isAllowedMemoryPath(outsideMd, opts), null);
  assert.equal(isAllowedMemoryPath(symEscape, opts), null);
  assert.equal(isAllowedMemoryPath(bigFile, opts), null);

  const docRes = readMemoryDocument(allowedLearning, opts);
  assert.equal(docRes.ok, true);
  assert.match(docRes.content, /XSS Check/);

  const htmlRes = renderMemoryViewHtml(allowedLearning, opts);
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.body.includes('<script>alert(1)</script>'), false);
  assert.ok(htmlRes.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(htmlRes.body.includes('— Learning</title>'));

  const memHtmlRes = renderMemoryViewHtml(allowedMem, opts);
  assert.equal(memHtmlRes.status, 200);
  assert.ok(memHtmlRes.body.includes('— Memory</title>'));

  const blockedRes = renderMemoryViewHtml(symEscape, opts);
  assert.equal(blockedRes.status, 403);
});

test('UI bundle includes tight copy and memory viewer hooks', () => {
  const doc = appHtml({ sidecar: true });
  for (const token of [
    'memory-doc',
    'Captured & extracted',
    'learnings',
    'Learnings',
    'Captured',
    'toggleAuxPane',
    '/api/memory-view',
    '/api/memory-doc',
    'Planning…',
    'Nothing yet',
  ]) {
    assert.ok(doc.includes(token), `expected UI bundle to include ${token}`);
  }
});
