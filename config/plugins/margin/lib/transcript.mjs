// Deterministic facts about a conversation, derived from transcript.jsonl.
import { readFileSync, statSync, existsSync } from 'node:fs';

const IDLE_MS = 5 * 60 * 1000;
const TAIL_BYTES = 8 * 1024 * 1024;

export const CATEGORIES = [
  ['files', /^(read_file|view_file|view_file_outline|write_file|edit_file|replace_file_content|multi_replace_file_content|write_to_file|list_dir|find_by_name|grep_search|read_many_files|glob|grep)$/],
  ['shell', /^(run_command|send_command_input|command_status|manage_task)$/],
  ['web', /^(search_web|read_url_content|read_url|browser_.*|.*web.*)$/],
  ['agents', /^(invoke_subagent|send_message|manage_subagents|swarm|run_workflow)$/],
];

export function categoryOf(name) {
  if (/^margin/.test(name) || /margin_intent/.test(name)) return null; // our own call is not "work"
  for (const [cat, re] of CATEGORIES) if (re.test(name)) return cat;
  return 'other';
}

export function stripUserText(content) {
  let t = String(content ?? '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(t);
  if (m) t = m[1];
  t = t.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '');
  return t.trim();
}

function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* partial trailing line */ }
  }
  return rows;
}

export function readRows(path) {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  let text = readFileSync(path, 'utf-8');
  if (size > TAIL_BYTES) text = text.slice(text.indexOf('\n', text.length - TAIL_BYTES) + 1);
  return parseRows(text);
}

const toolCalls = (r) => (Array.isArray(r.tool_calls) ? r.tool_calls : []);
const pathArg = (c) => {
  const a = c?.args ?? {};
  const v = a.Path ?? a.AbsolutePath ?? a.TargetFile ?? a.path ?? a.file_path;
  return typeof v === 'string' ? v.replace(/^"|"$/g, '') : null;
};

/**
 * Summarise the latest turn (everything since the last real user message).
 * @returns {{status:string, ask:string, userStep:number, turnStartedAt:string|null,
 *   lastStepAt:string|null, used:Record<string,number>, files:string[], steps:number}}
 */
export function summarize(rows, now = Date.now()) {
  let lastUser = -1;
  rows.forEach((r, i) => { if (r.type === 'USER_INPUT' && r.source === 'USER_EXPLICIT') lastUser = i; });
  const turn = rows.slice(lastUser + 1);
  const used = {};
  const files = [];
  for (const r of turn) {
    for (const c of toolCalls(r)) {
      const cat = categoryOf(String(c?.name ?? ''));
      if (!cat) continue;
      used[cat] = (used[cat] || 0) + 1;
      if (cat === 'files') {
        const p = pathArg(c);
        if (p && !files.includes(p)) files.push(p);
      }
    }
  }
  const user = lastUser >= 0 ? rows[lastUser] : null;
  const last = rows[rows.length - 1] ?? null;
  const lastWork = [...turn].reverse().find((r) => r.type !== 'CHECKPOINT' && r.type !== 'SYSTEM_MESSAGE') ?? null;
  const lastAt = (lastWork ?? user)?.created_at ?? last?.created_at ?? null;
  const age = lastAt ? now - Date.parse(lastAt) : 0;
  let status = 'idle';
  if (!rows.length) status = 'idle';
  else if (!lastWork) status = 'planning';
  else if (lastWork.type === 'PLANNER_RESPONSE' && toolCalls(lastWork).length === 0 && lastWork.status === 'DONE') status = 'done';
  else if (lastWork.status === 'ERROR' && age > 60_000) status = 'stopped';
  else if (age > IDLE_MS) status = 'stopped';
  else status = turn.some((r) => r.type === 'PLANNER_RESPONSE') ? 'working' : 'planning';
  return {
    status,
    ask: user ? stripUserText(user.content) : '',
    userStep: user ? Number(user.step_index) : -1,
    turnStartedAt: user?.created_at ?? null,
    lastStepAt: lastAt,
    used,
    files: files.slice(-8),
    steps: turn.length,
  };
}
