// Combine transcript facts with the agent-reported intent, subagents/swarm, context, and watchdog into one payload.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { appDataDirs, brainDirOf, ID_RE, intentPath, outcomePath, topicsPath, transcriptPath } from './paths.mjs';
import { enrichTake, readIntent } from './intent.mjs';
import { collectSessionSavedMemories, memoryStoreDirs, readMarkdownExcerpt } from './memory.mjs';
import {
  buildHeuristicOutcome,
  extractTurnExecution,
  mergeOutcome,
  OUTCOME_DEFAULT_LABELS,
  OUTCOME_MARKS,
  readOutcomeState,
} from './outcome.mjs';
import { spawnOutcomeWorker } from './outcome-worker.mjs';
import { isTopicsRunning, readTopicsState } from './topics.mjs';
import { spawnTopicsWorker } from './topics-worker.mjs';
import {
  collectUsed,
  computeContext,
  detectModel,
  extractNativeSteps,
  readHeadText,
  readRows,
  resolveTurnSteps,
  summarize,
  summarizeSubagent,
  toolCalls,
  unquote,
} from './transcript.mjs';

/** Newest-modified conversation transcript: the fallback when the model omits/garbles its id. */
export function newestConversation(dirs = appDataDirs()) {
  let best = null;
  for (const d of dirs) {
    const root = join(d, 'brain');
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (!ID_RE.test(n)) continue;
      const t = transcriptPath(join(root, n));
      if (!existsSync(t)) continue;
      const m = statSync(t).mtimeMs;
      if (!best || m > best.m) best = { id: n, m };
    }
  }
  return best?.id ?? null;
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function contextDirsFromBrain(brain) {
  const conv = basename(brain);
  const appData = dirname(dirname(brain));
  const geminiDir = dirname(appData);
  const isHermetic = basename(geminiDir) === '.gemini';
  const home = isHermetic ? dirname(geminiDir) : homedir();
  const discovered = appDataDirs({ env: {}, home });
  const dirs = [appData, ...discovered].filter((d, i, arr) => d && arr.indexOf(d) === i);
  const wdEnv = !isHermetic || home === homedir() ? process.env.AGY_WATCHDOG_HOME : '';
  const watchdogDir = wdEnv || join(home, '.agents', 'watchdog');
  const configDir = join(home, '.gemini', 'config');
  return { conv, home, isHermetic, dirs, watchdogDir, configDir };
}

function cleanBriefSummary(raw, workerName = '') {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let text = raw
    .replace(/\[antigravity-subagent-route:[^\]]+\]/g, '')
    .trim();
  if (workerName && text.startsWith(`@${workerName}`)) {
    text = text.slice(workerName.length + 1).trim();
  }
  const goalMatch = /(?:^|\n)\s*Goal:\s*([^\n]+)/i.exec(text);
  if (goalMatch?.[1]) return goalMatch[1].trim().slice(0, 140);
  for (const line of text.split('\n')) {
    const cleaned = line.replace(/^[#>*-\s]+/, '').trim();
    if (!cleaned) continue;
    if (/^You own ONLY\b/i.test(cleaned) || /^Do NOT touch\b/i.test(cleaned)) continue;
    return cleaned.slice(0, 140);
  }
  const first = text.split('\n')[0]?.trim() ?? '';
  return first.slice(0, 140);
}

function readSwarmBriefs(brain, rows) {
  const briefs = new Map();
  const boardPath = join(brain, '.system_generated', 'swarm', 'board.jsonl');
  if (existsSync(boardPath)) {
    try {
      for (const line of readFileSync(boardPath, 'utf-8').split('\n')) {
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg?.kind !== 'brief' || typeof msg.text !== 'string') continue;
        const m = /^@([A-Za-z0-9_-]+)\s+([\s\S]*)$/.exec(msg.text.trim());
        if (m) briefs.set(m[1], cleanBriefSummary(m[2], m[1]));
      }
    } catch { /* ignore partial board */ }
  }
  for (const r of rows) {
    for (const c of toolCalls(r)) {
      if (c?.name !== 'swarm') continue;
      const a = c.args ?? {};
      if (unquote(a.action) !== 'add') continue;
      const name = String(unquote(a.name ?? '') || '').trim();
      const brief = String(unquote(a.brief ?? '') || '').trim();
      if (name && brief && !briefs.has(name)) {
        briefs.set(name, cleanBriefSummary(brief, name));
      }
    }
  }
  return briefs;
}

function readSubagentMetaMap(brain) {
  const map = new Map();
  const dir = join(brain, '.system_generated', 'subagents');
  if (!existsSync(dir)) return map;
  let files = [];
  try { files = readdirSync(dir); } catch { return map; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const d = readJsonSafe(join(dir, f));
    if (!d?.conversationId) continue;
    map.set(d.conversationId, {
      id: d.conversationId,
      typeName: d.subagentDescriptor?.typeName || '',
      role: d.subagentDescriptor?.role || '',
      state: d.state || '',
      spawnStepIndex: typeof d.spawnStepIndex === 'number' ? d.spawnStepIndex : undefined,
    });
  }
  return map;
}

function brainFromLogUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  const p = uri.slice('file://'.length);
  const suffix = '/.system_generated/logs/transcript.jsonl';
  if (p.endsWith(suffix)) {
    const b = p.slice(0, -suffix.length);
    return existsSync(b) ? b : null;
  }
  return null;
}

export function sameAgentText(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function matchesAgentSpec(spawn, spec) {
  const s = String(spec ?? '').trim();
  if (!s) return false;
  if (sameAgentText(spawn.name, s) || sameAgentText(`@${spawn.name}`, s) || sameAgentText(spawn.description, s)) {
    return true;
  }
  const colonIdx = s.indexOf(':');
  if (colonIdx > 0) {
    const left = s.slice(0, colonIdx).trim();
    const right = s.slice(colonIdx + 1).trim();
    if (sameAgentText(spawn.name, left) || (right && sameAgentText(spawn.description, right))) return true;
  }
  return false;
}

function plannedAgentFromSpec(spec) {
  const s = String(spec ?? '').trim();
  const colonIdx = s.indexOf(':');
  if (colonIdx > 0 && colonIdx <= 28) {
    return {
      id: null,
      name: s.slice(0, colonIdx).trim(),
      description: s.slice(colonIdx + 1).trim(),
      status: 'planned',
      type: '',
      model: '',
    };
  }
  return {
    id: null,
    name: s.replace(/^@/, ''),
    description: '',
    status: 'planned',
    type: '',
    model: '',
  };
}

function toAgentItem(one) {
  return {
    id: one.id ?? null,
    name: one.name || one.description || 'agent',
    description: one.description && !sameAgentText(one.description, one.name) ? one.description : '',
    status: one.status || 'running',
    type: one.type || '',
    model: one.model || '',
  };
}

/**
 * Hang planned `step.agents` and discovered spawned subagents/swarm workers under their steps.
 * Matches explicit `step.agents` entries first (by name or description), then attaches any
 * remaining active/current-turn spawns to a matching `one.step`, the `in_progress` step, or the final step.
 */
export function hang(steps, spawns = []) {
  if (!Array.isArray(steps) || !steps.length) return [];
  const left = [...spawns];
  const perStep = steps.map((step) =>
    (Array.isArray(step.agents) ? step.agents : []).map((spec) => {
      const idx = left.findIndex((one) => matchesAgentSpec(one, spec));
      if (idx < 0) return plannedAgentFromSpec(spec);
      const [matched] = left.splice(idx, 1);
      return toAgentItem(matched);
    }),
  );

  const currentIdx = steps.findIndex((s) => s.status === 'in_progress');
  for (const one of left) {
    const byStep = one.step ? steps.findIndex((s) => sameAgentText(s.text, one.step)) : -1;
    const targetIdx = byStep >= 0 ? byStep : (currentIdx >= 0 ? currentIdx : steps.length - 1);
    if (targetIdx >= 0 && perStep[targetIdx]) {
      perStep[targetIdx].push(toAgentItem(one));
    }
  }

  return steps.map((s, idx) => ({
    index: idx + 1,
    text: s.text,
    status: s.status,
    agents: perStep[idx] ?? [],
  }));
}

export function computeStepProgress(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const total = list.length;
  if (!total) {
    return { done: 0, active: null, activeText: '', total: 0, label: '' };
  }
  const done = list.filter((s) => s.status === 'completed').length;
  const activeIdx = list.findIndex((s) => s.status === 'in_progress');
  if (activeIdx >= 0) {
    const active = activeIdx + 1;
    const activeText = list[activeIdx].text || '';
    return {
      done,
      active,
      activeText,
      total,
      label: `${done} done · on ${active} of ${total}`,
    };
  }
  return {
    done,
    active: null,
    activeText: '',
    total,
    label: `${done}/${total} steps`,
  };
}

/** Discover spawned `invoke_subagent` calls and `.system_generated/swarm/members.json` workers. */
export function discoverAgents(brain, rows, facts, ctxDirs, now = Date.now()) {
  const { conv, dirs } = ctxDirs;
  const subMetaById = readSubagentMetaMap(brain);
  const swarmBriefs = readSwarmBriefs(brain, rows);
  const spawns = [];
  const seenIds = new Set();

  // 1. Read swarm members first if `.system_generated/swarm/members.json` exists
  const membersFile = join(brain, '.system_generated', 'swarm', 'members.json');
  const swarmData = existsSync(membersFile) ? readJsonSafe(membersFile) : null;
  let coordinatorModel = '';
  if (swarmData?.members && typeof swarmData.members === 'object') {
    const coord = swarmData.members.coordinator;
    if (coord) coordinatorModel = String(coord.applied_model || coord.model || coord.desired_model || '').trim();

    const workerEntries = Object.entries(swarmData.members).filter(
      ([name, m]) => name !== 'coordinator' && m?.role !== 'coordinator' && m?.conversation_id !== conv,
    );

    const turnTouchedSwarm = facts.turnRows.some((r) =>
      toolCalls(r).some((c) => c?.name === 'swarm' || c?.name === 'read_board' || c?.name === 'post_message'),
    );

    const candidateWorkers = workerEntries.map(([name, m]) => {
      const id = typeof m?.conversation_id === 'string' && ID_RE.test(m.conversation_id) ? m.conversation_id : null;
      const meta = id ? subMetaById.get(id) : null;
      const wBrain = id ? brainDirOf(id, dirs) : null;
      const wRows = wBrain ? readRows(transcriptPath(wBrain)) : [];
      const lastWork = [...wRows].reverse().find((r) => r.type !== 'CHECKPOINT' && r.type !== 'SYSTEM_MESSAGE') ?? null;

      let status = 'running';
      if (lastWork && (lastWork.type === 'ERROR_MESSAGE' || lastWork.status === 'ERROR')) {
        status = 'failed';
      } else if (m?.killed || m?.phase === 'KILLED' || m?.desired_state === 'KILLED' || meta?.state === 'SUBAGENT_STATE_KILLED') {
        status = 'killed';
      } else if (m?.wake_mode && m.wake_mode !== 'working') {
        status = 'waiting';
      } else if (wRows.length) {
        const subStatus = summarizeSubagent(wRows, meta?.state, now);
        status = m?.wake_mode === 'working' && subStatus === 'pending' ? 'running' : subStatus;
      } else {
        status = m?.phase === 'RUNNING' || m?.wake_mode === 'working' ? 'running' : 'pending';
      }

      const spawnStep = meta?.spawnStepIndex;
      const spawnedInTurn = spawnStep === undefined ? true : spawnStep > facts.userStep;
      const model = String(
        m?.applied_model || m?.model || m?.desired_model || (wRows.length ? detectModel(wRows) : '') || '',
      ).trim();

      return {
        id,
        name,
        description: swarmBriefs.get(name) || '',
        status,
        type: 'swarm',
        model,
        rows: wRows,
        spawnedBeforeTurn: !spawnedInTurn,
      };
    });

    const anySpawnedInTurn = candidateWorkers.some((w) => !w.spawnedBeforeTurn);
    const anyRunningNow = candidateWorkers.some((w) => w.status === 'running');
    if (anySpawnedInTurn || turnTouchedSwarm || anyRunningNow) {
      for (const w of candidateWorkers) {
        if (w.id) seenIds.add(w.id);
        spawns.push(w);
      }
    }
  }

  // 2. Discover `invoke_subagent` calls in `rows`
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r?.type !== 'PLANNER_RESPONSE') continue;
    const stepIdx = typeof r.step_index === 'number' ? r.step_index : i;
    const subCalls = toolCalls(r).filter((c) => c?.name === 'invoke_subagent');
    if (!subCalls.length) continue;

    // Collect subagent result metadata from the following GENERIC tool outputs
    const resultEntries = [];
    for (let j = i + 1; j < rows.length; j++) {
      const nr = rows[j];
      if (nr?.type === 'PLANNER_RESPONSE' || (nr?.type === 'USER_INPUT' && nr?.source === 'USER_EXPLICIT')) break;
      if (nr?.type !== 'GENERIC' || typeof nr.content !== 'string') continue;
      const idMatch = /"conversationId"\s*:\s*"([0-9a-f-]{8,64})"/i.exec(nr.content);
      const uriMatch = /"logAbsoluteUri"\s*:\s*"([^"]+)"/.exec(nr.content);
      if (idMatch) {
        resultEntries.push({ id: idMatch[1], logUri: uriMatch?.[1] || '' });
      }
    }

    // Fallback match via `.system_generated/subagents/*.json` spawnStepIndex
    if (!resultEntries.length) {
      for (const meta of subMetaById.values()) {
        if (meta.spawnStepIndex === stepIdx && !seenIds.has(meta.id)) {
          resultEntries.push({ id: meta.id, logUri: '' });
        }
      }
    }

    subCalls.forEach((call, callIdx) => {
      const a = call.args ?? {};
      const explicitId = String(unquote(a.ConversationId ?? a.conversation_id ?? a.id ?? '') || '').trim();
      const matched = resultEntries[callIdx] ?? (explicitId && ID_RE.test(explicitId) ? { id: explicitId, logUri: '' } : null);
      const id = matched?.id ?? null;
      if (id && seenIds.has(id)) return;

      const meta = id ? subMetaById.get(id) : null;
      const role = String(unquote(a.Role ?? a.AgentName ?? a.Name ?? '') || meta?.role || '').trim();
      const type = String(unquote(a.TypeName ?? '') || meta?.typeName || 'subagent').trim();
      const rawModel = String(unquote(a.Model ?? '') || '').trim();
      const promptSummary = cleanBriefSummary(String(unquote(a.Prompt ?? '') || ''));
      const name = role || type || 'subagent';
      const description = promptSummary && !sameAgentText(promptSummary, name) ? promptSummary : '';

      const subBrain = brainFromLogUri(matched?.logUri) ?? (id ? brainDirOf(id, dirs) : null);
      const subRows = subBrain ? readRows(transcriptPath(subBrain)) : [];
      const model = (subRows.length ? detectModel(subRows) : '') || (rawModel && rawModel !== 'inherit' ? rawModel : '');

      const inCurrentTurn = stepIdx > facts.userStep;
      let status;
      if (subBrain || subRows.length || meta?.state) {
        status = summarizeSubagent(subRows, meta?.state, now);
      } else {
        status = inCurrentTurn ? 'running' : 'completed';
      }

      if (!inCurrentTurn && !['pending', 'running', 'waiting'].includes(status)) return;
      if (id) seenIds.add(id);
      spawns.push({
        id,
        name,
        description,
        status,
        type,
        model,
        step: String(unquote(a.Step ?? a.step ?? '') || '').trim(),
        rows: subRows,
        spawnedBeforeTurn: !inCurrentTurn,
      });
    });
  }

  return { spawns, coordinatorModel };
}

function isWatchdogEnabled(configDir, watchdogDir) {
  const cfg = readJsonSafe(join(configDir, 'config.json'));
  if (cfg?.plugins?.watchdog && typeof cfg.plugins.watchdog.enabled === 'boolean') {
    if (!cfg.plugins.watchdog.enabled) return false;
  }
  const pjson = readJsonSafe(join(configDir, 'plugins', 'watchdog', 'plugin.json'));
  if (pjson && typeof pjson.disabled === 'boolean' && pjson.disabled) return false;
  const state = readJsonSafe(join(watchdogDir, 'state.json'));
  if (state && typeof state.enabled === 'boolean') return state.enabled;
  return true;
}

export function buildWatchdog(conv, facts, overviewStatus, ctxDirs, now = Date.now()) {
  const { configDir, watchdogDir } = ctxDirs;
  const enabled = isWatchdogEnabled(configDir, watchdogDir);
  const sess = conv ? readJsonSafe(join(watchdogDir, 'sessions', `${conv}.json`)) : null;

  const turnStartMs = facts.turnStartedAt ? Date.parse(facts.turnStartedAt) : 0;
  const sessTurnMs = Number(sess?.turn_started_epoch || 0) * 1000;
  const sessFresh = Boolean(
    sess && typeof sess === 'object' && (
      (turnStartMs > 0 && sessTurnMs >= turnStartMs - 10_000) ||
      (turnStartMs === 0 && sessTurnMs > 0)
    ),
  );

  const turnSteps = sessFresh
    ? Math.max(facts.turnSteps, Math.max(0, Math.floor(Number(sess.turn_step_count || 0))))
    : facts.turnSteps;
  const turnTools = sessFresh
    ? Math.max(facts.turnTools, Math.max(0, Math.floor(Number(sess.turn_tool_count || 0))))
    : facts.turnTools;

  const turnStartedAt = facts.turnStartedAt || (sessFresh && sessTurnMs > 0 ? new Date(sessTurnMs).toISOString() : null);
  const sessLastStepMs = sessFresh && sess?.last_step?.ts ? Number(sess.last_step.ts) * 1000 : 0;
  const factLastMs = facts.lastStepAt ? Date.parse(facts.lastStepAt) : 0;
  const bestLastMs = Math.max(factLastMs, sessLastStepMs);
  const lastStepAt = bestLastMs > 0 ? (bestLastMs === factLastMs ? facts.lastStepAt : new Date(bestLastMs).toISOString()) : null;

  const effStartMs = turnStartedAt ? Date.parse(turnStartedAt) : 0;
  const isActive = overviewStatus === 'planning' || overviewStatus === 'working' || overviewStatus === 'waiting_agents';
  const effEndMs = isActive ? now : (bestLastMs || effStartMs);
  const elapsedMs = effStartMs > 0 && effEndMs >= effStartMs ? Math.max(0, Math.round(effEndMs - effStartMs)) : 0;

  let status = enabled ? 'ok' : 'off';
  let alert = null;
  if (enabled && sessFresh && sess?.last_alert && typeof sess.last_alert === 'object') {
    const kind = String(sess.last_alert.kind || '');
    const detail = String(sess.last_alert.detail || '');
    const alertTsMs = Number(sess.last_alert.ts || 0) * 1000;
    const ageMs = alertTsMs > 0 ? Math.max(0, Math.round(now - alertTsMs)) : 0;
    if (kind === 'stall' && ageMs <= 120_000) {
      status = 'stall';
      alert = { kind, detail, ageMs };
    } else if (kind === 'loop' && ageMs <= 90_000) {
      status = 'loop';
      alert = { kind, detail, ageMs };
    }
  }

  return {
    enabled,
    status,
    turnSteps,
    turnTools,
    turnStartedAt,
    lastStepAt,
    elapsedMs,
    alert,
    sessionModel: typeof sess?.model === 'string' ? sess.model.trim() : '',
  };
}

export function buildOverview(brain, now = Date.now(), { triggerTopics = false, triggerOutcome = triggerTopics } = {}) {
  const ctxDirs = contextDirsFromBrain(brain);
  const tp = transcriptPath(brain);
  const rows = readRows(tp);
  const headText = readHeadText(tp);
  const facts = summarize(rows, now);
  if (triggerTopics) spawnTopicsWorker(brain);
  const stored = readIntent(intentPath(brain));
  const topicsState = readTopicsState(topicsPath(brain));
  const topicsRunning = isTopicsRunning(topicsState, now);
  const about = {
    summary: topicsState?.summary || '',
    topics: Array.isArray(topicsState?.topics) ? topicsState.topics : [],
    running: topicsRunning,
    failed: Boolean(topicsState?.failed && !topicsRunning),
  };

  const { spawns, coordinatorModel } = discoverAgents(brain, rows, facts, ctxDirs, now);

  // Count active subagents / swarm workers (excluding an idle daemon stall-monitor sleeping on mentions/anything)
  const activeSpawns = spawns.filter(
    (a) => ['pending', 'running', 'waiting'].includes(a.status) && !(a.type === 'swarm' && a.name === 'monitor' && a.status === 'waiting'),
  );
  const anyActivelyRunning = spawns.some((a) => a.status === 'running' || a.status === 'pending');
  const waitingAgents = activeSpawns.length;

  const fresh = stored && stored.userStep === facts.userStep ? stored : null;
  const workerAsk =
    topicsState && topicsState.askUserStep === facts.userStep && topicsState.ask
      ? topicsState.ask
      : '';

  let status = facts.status;
  if (waitingAgents > 0) {
    const lastTurnPlanner = [...facts.turnRows].reverse().find((r) => r.type === 'PLANNER_RESPONSE') ?? null;
    const lastLaunchedAgents = Boolean(
      lastTurnPlanner && toolCalls(lastTurnPlanner).some((c) => c?.name === 'invoke_subagent' || c?.name === 'swarm' || c?.name === 'swarm_wait'),
    );
    if (facts.status === 'done' || lastLaunchedAgents || (facts.status === 'stopped' && anyActivelyRunning)) {
      status = 'waiting_agents';
    }
  }

  let outcome = null;
  let storedOutcome = null;
  if (status === 'done') {
    const exec = extractTurnExecution(facts.turnRows, { brain });
    if (triggerOutcome && exec.finalStep >= 0 && exec.finalReply.trim()) {
      spawnOutcomeWorker(brain, now);
    }
    storedOutcome = readOutcomeState(outcomePath(brain));
    const heuristic = buildHeuristicOutcome(exec, { take: fresh?.take ? enrichTake(fresh.take) : null });
    outcome = mergeOutcome({
      heuristic,
      stored: storedOutcome,
      userStep: facts.userStep,
      finalStep: exec.finalStep,
      exec,
      now,
    });
  } else {
    storedOutcome = readOutcomeState(outcomePath(brain));
  }

  // Hang subagents/swarm workers under steps before auto-completing only when turn didn't pause for input/blockers
  const rawSteps = resolveTurnSteps(facts.turnRows, fresh);
  const hungSteps = hang(rawSteps, spawns);
  const shouldAutoComplete = status === 'done' && outcome?.kind !== 'needs_input' && outcome?.kind !== 'blocked';
  const steps = shouldAutoComplete && hungSteps.length
    ? hungSteps.map((s) => (s.status === 'skipped' || s.status === 'failed' ? s : { ...s, status: 'completed' }))
    : hungSteps;

  const stepProgress = computeStepProgress(steps);

  // Previous turn intent dim fallback while active and current turn hasn't landed a fresh Take yet
  const prevNativeSteps = extractNativeSteps(facts.prevTurnRows);
  const hasPrevIntent = Boolean(
    stored && stored.userStep !== facts.userStep && (stored.wants || stored.take || stored.steps?.length),
  );
  const isTurnActive = status === 'planning' || status === 'working' || status === 'waiting_agents';
  let previous = null;
  if (isTurnActive && !fresh?.take && (hasPrevIntent || prevNativeSteps.length > 0)) {
    const prevOutcome = storedOutcome && stored && storedOutcome.userStep === stored.userStep && storedOutcome.kind
      ? {
        kind: storedOutcome.kind,
        mark: OUTCOME_MARKS[storedOutcome.kind] || '✓',
        label: storedOutcome.label || OUTCOME_DEFAULT_LABELS[storedOutcome.kind] || storedOutcome.kind,
        summary: storedOutcome.summary || '',
        items: Array.isArray(storedOutcome.items) ? storedOutcome.items : [],
        evidence: '',
        verifyState: 'none',
        source: 'worker',
        running: false,
        failed: false,
        archiveSafe: storedOutcome.kind === 'clear',
      }
      : null;
    const prevCleanComplete = Boolean(
      facts.prevTurnDone && prevOutcome?.kind !== 'needs_input' && prevOutcome?.kind !== 'blocked',
    );
    const prevRawSteps = prevNativeSteps.length
      ? prevNativeSteps
      : (Array.isArray(stored?.steps) ? stored.steps : []);
    const prevSteps = prevRawSteps.map((s, idx) => ({
      index: idx + 1,
      text: s.text,
      status: prevCleanComplete && s.status !== 'skipped' && s.status !== 'failed' ? 'completed' : s.status,
      agents: Array.isArray(s.agents)
        ? s.agents.map((spec) => ({
          ...plannedAgentFromSpec(spec),
          status: prevCleanComplete ? 'completed' : 'planned',
        }))
        : [],
    }));
    previous = {
      wants: stored?.wants || '',
      take: stored?.take ? enrichTake(stored.take) : null,
      steps: prevSteps,
      outcome: prevOutcome,
    };
  }

  const { sessionModel, ...watchdog } = buildWatchdog(ctxDirs.conv, facts, status, ctxDirs, now);
  const context = computeContext(rows, {
    fallbackModel: sessionModel || coordinatorModel,
    headText,
  });

  // Attribute subagent tool calls (`+N`) for subagents spawned in or active during this turn
  const turnStartMs = facts.turnStartedAt ? Date.parse(facts.turnStartedAt) : 0;
  const subSources = spawns.map((s) => ({
    reader: s.name || 'agent',
    rows: s.spawnedBeforeTurn && turnStartMs > 0
      ? s.rows.filter((r) => !r.created_at || Date.parse(r.created_at) >= turnStartMs)
      : s.rows,
  }));
  const { used, usedDetails } = collectUsed(facts.turnRows, subSources, ctxDirs.home);

  // Merge session-wide captured learnings, remember notes, and extracted rollouts into `memory` and `learnings`.
  const memStores = memoryStoreDirs(ctxDirs);
  const { items: savedMemItems, learningItems: savedLearningItems } = collectSessionSavedMemories({
    conv: ctxDirs.conv,
    allRows: rows,
    currentUserStep: facts.userStep,
    home: ctxDirs.home,
    memoriesDir: memStores.memoriesDir,
    compoundDir: memStores.compoundDir,
  });

  const isAbsPath = (p) => typeof p === 'string' && (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p));
  const toPosix = (p) => String(p ?? '').replace(/\\/g, '/');

  const mergeSavedCategory = (detail, savedItems, { filterLearningReadme = false } = {}) => {
    const baseDetail = detail ?? { main: 0, agents: 0, items: [] };
    const inTurnMain = baseDetail.items.filter((it) => it.reader === 'main');
    const agents = baseDetail.items.filter((it) => it.reader !== 'main');

    const savedByKey = new Map();
    const savedKeyOf = (it) => (
      it.action === 'remembered'
        ? `rem:${String(it.summary || it.name).trim().toLowerCase()}`
        : `path:${it.filePath && isAbsPath(it.filePath) ? resolve(it.filePath) : it.name}`
    );
    for (const s of savedItems) {
      savedByKey.set(savedKeyOf(s), { ...s });
    }
    const hasNonReadmeLearning = filterLearningReadme && [...savedByKey.values()].some(
      (it) => it.filePath && toPosix(it.filePath).includes('/docs/learnings/') && basename(toPosix(it.filePath)).toUpperCase() !== 'README.MD',
    );
    for (const it of inTurnMain) {
      if (it.group !== 'saved') continue;
      const normPath = it.filePath && isAbsPath(it.filePath) ? resolve(it.filePath) : (it.filePath || it.name);
      if (hasNonReadmeLearning && /(?:^|\/)docs\/learnings\/README\.md$/i.test(toPosix(normPath))) continue;
      const k = it.action === 'remembered'
        ? `rem:${String(it.summary || it.name).trim().toLowerCase()}`
        : `path:${normPath}`;
      const prev = savedByKey.get(k);
      if (prev) {
        prev.earlier = false;
        prev.count = Math.max(prev.count || 1, it.count || 1);
        if (!prev.summary && it.summary) prev.summary = it.summary;
      } else {
        savedByKey.set(k, {
          ...it,
          filePath: isAbsPath(normPath) ? normPath : '',
          summary: it.summary || (isAbsPath(normPath) ? readMarkdownExcerpt(normPath) : ''),
          earlier: false,
        });
      }
    }
    const mergedSaved = [...savedByKey.values()].sort((a, b) => Number(Boolean(a.earlier)) - Number(Boolean(b.earlier)));
    const readItems = inTurnMain
      .filter((it) => it.group !== 'saved')
      .map((it) => (
        it.filePath && !it.summary
          ? { ...it, summary: readMarkdownExcerpt(it.filePath) }
          : it
      ));
    const mainCount = mergedSaved.reduce((sum, it) => sum + (it.earlier ? 1 : (it.count || 1)), 0)
      + readItems.reduce((sum, it) => sum + (it.count || 1), 0);

    return {
      total: mainCount + (baseDetail.agents || 0),
      detail: {
        main: mainCount,
        agents: baseDetail.agents || 0,
        savedCount: mergedSaved.length,
        readCount: readItems.length,
        items: [...mergedSaved, ...readItems, ...agents],
      },
    };
  };

  const mergedMemory = mergeSavedCategory(usedDetails.memory, savedMemItems, { filterLearningReadme: false });
  usedDetails.memory = mergedMemory.detail;
  used.memory = mergedMemory.total;

  const mergedLearnings = mergeSavedCategory(usedDetails.learnings, savedLearningItems, { filterLearningReadme: true });
  usedDetails.learnings = mergedLearnings.detail;
  used.learnings = mergedLearnings.total;

  return {
    about,
    status,
    waitingAgents,
    ask: facts.ask,
    wants: fresh?.wants || workerAsk || '',
    wantsSource: fresh?.wants ? 'agent' : (workerAsk ? 'worker' : ''),
    take: fresh?.take ? enrichTake(fresh.take) : null,
    steps,
    stepProgress,
    done: stepProgress.done,
    outcome,
    reported: Boolean(fresh?.take || fresh?.wants || rawSteps.length > 0),
    previous,
    context,
    watchdog,
    used,
    usedDetails,
    files: facts.files,
    turnStartedAt: facts.turnStartedAt,
    lastStepAt: facts.lastStepAt,
    stepCount: facts.steps,
  };
}

/** Resolve conversation overview with ETag support for sidecar HTTP polling. */
export function resolveOverview({ conversationId = '', etag = '', triggerTopics = true } = {}, dirs = appDataDirs()) {
  const raw = String(conversationId ?? '');
  const conv = ID_RE.test(raw) && brainDirOf(raw, dirs) ? raw : newestConversation(dirs);
  const brain = brainDirOf(conv, dirs);
  if (!brain) return { conversationId: conv || null, overview: null };
  const overview = buildOverview(brain, Date.now(), { triggerTopics });
  const stable = {
    ...overview,
    watchdog: overview.watchdog ? { ...overview.watchdog, elapsedMs: 0 } : null,
  };
  const nextEtag = createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
  if (etag && etag === nextEtag) return { conversationId: conv, unchanged: true, etag: nextEtag };
  return { conversationId: conv, overview, etag: nextEtag };
}
