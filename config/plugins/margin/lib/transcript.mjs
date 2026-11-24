// Deterministic facts about a conversation, derived from transcript.jsonl.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const IDLE_MS = 5 * 60 * 1000;
const TAIL_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;

export const USED_CATEGORIES = ['files', 'memory', 'learnings', 'skills', 'shell', 'web', 'agents', 'other'];

export const CATEGORIES = [
  ['files', /^(read_file|view_file|view_file_outline|write_file|edit_file|replace_file_content|multi_replace_file_content|write_to_file|list_dir|find_by_name|grep_search|read_many_files|glob|grep)$/],
  ['shell', /^(run_command|send_command_input|command_status|manage_task)$/],
  ['web', /^(search_web|read_url_content|read_url|browser_.*|.*web.*)$/],
  ['agents', /^(invoke_subagent|send_message|manage_subagents|swarm|run_workflow)$/],
];

export function unquote(v) {
  if (typeof v !== 'string') return v;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
    try { return JSON.parse(v); } catch { /* fall through */ }
  }
  return v.replace(/^"|"$/g, '');
}

export function isMarginToolCall(name, args) {
  const n = String(name ?? '');
  if (/^margin/.test(n) || /margin_(intent|overview)/.test(n) || n === 'swarm_wait' || n === 'read_board' || n === 'post_message') return true;
  if (n === 'call_mcp_tool' && args && typeof args === 'object') {
    const srv = String(unquote(args.ServerName ?? '') || '');
    const tl = String(unquote(args.ToolName ?? '') || '');
    if (/^margin/.test(srv) || /^margin/.test(tl) || /margin_(intent|overview)/.test(tl)) return true;
  }
  return false;
}

export function categoryOf(name, args) {
  const n = String(name ?? '');
  if (isMarginToolCall(n, args)) return null; // our own call is not "work"
  for (const [cat, re] of CATEGORIES) if (re.test(n)) return cat;
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
  if (size <= TAIL_BYTES) return parseRows(readFileSync(path, 'utf-8'));
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    const bytesRead = readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    const chunk = buf.toString('utf-8', 0, bytesRead);
    const nl = chunk.indexOf('\n');
    return parseRows(nl >= 0 ? chunk.slice(nl + 1) : chunk);
  } finally {
    closeSync(fd);
  }
}

export function readHeadText(path) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  if (size <= TAIL_BYTES) return '';
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(size, HEAD_BYTES);
    const buf = Buffer.alloc(len);
    const bytesRead = readSync(fd, buf, 0, len, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

export const toolCalls = (r) => (Array.isArray(r?.tool_calls) ? r.tool_calls : []);

export const pathArg = (c) => {
  const a = c?.args ?? {};
  const v = a.Path ?? a.AbsolutePath ?? a.TargetFile ?? a.DirectoryPath ?? a.SearchPath ?? a.path ?? a.file_path;
  const u = unquote(v);
  return typeof u === 'string' && u.trim() ? u.trim() : null;
};

export function classifyPath(rawPath) {
  const p = String(rawPath ?? '').trim();
  if (!p) return null;
  if (/(?:^|\/)SKILL\.md$/i.test(p)) {
    const m = /\/([^/]+)\/SKILL\.md$/i.exec(p);
    return { kind: 'skills', name: p, short: m ? m[1] : 'SKILL.md' };
  }
  if (/(?:^|\/)docs\/learnings(?:\/|$)/i.test(p)) {
    const b = basename(p);
    return { kind: 'learnings', name: p, short: b.replace(/\.(md|txt|json)$/i, '') || b };
  }
  if (/\/\.agents\/memories(?:\/|$)|\/\.claude\/projects\/[^/]+\/memory\/|(?:^|\/)MEMORY\.md$/i.test(p)) {
    const b = basename(p);
    return { kind: 'memory', name: p, short: b.replace(/\.(md|txt|json)$/i, '') || b };
  }
  return { kind: 'files', name: p, short: basename(p) || p };
}

const BASH_READ_HEAD = /^\s*(?:(?:\w+=\S*|rtk|env)\s+)*(?:\S*\/)?(git\s+grep|grep|rg|find|fd|ag|ack|cat|head|tail|ls)(?:\s+|$)/;
const PATTERN_CMDS = new Set(['grep', 'rg', 'git grep', 'ag', 'ack']);
const HEAD_TAIL_ARG_FLAGS = /^-(?:n|c|-lines|-bytes)$/;
const SEARCH_ARG_FLAGS = /^-(?:A|B|C|m|e|f|g|t|d|-max-count|-context|-after-context|-before-context|-regexp|-file|-glob|-type)$/;

function resolveShellPath(base, rawWord, home) {
  let w = rawWord.replace(/^["']|["']$/g, '').trim();
  if (!w || w === '.' || w === '..') return null;
  if (home) w = w.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (/[*?[(){}$`;|<>]/.test(w)) return null;
  const combined = w.startsWith('/') ? w : (base ? `${base}/${w}` : w);
  if (!combined.startsWith('/') && !combined.includes('/')) return null;
  const isAbs = combined.startsWith('/');
  const segs = [];
  for (const seg of combined.split('/')) {
    if (seg === '..') segs.pop();
    else if (seg && seg !== '.') segs.push(seg);
  }
  if (!segs.length) return null;
  const out = isAbs ? `/${segs.join('/')}` : segs.join('/');
  if (out.startsWith('/dev/') || out.startsWith('/proc/')) return null;
  return out;
}

/** Extract read-only file/dir paths referenced by shell commands (cat, head, tail, grep, rg, ls, find). */
export function bashPaths(cmd, home = '', cwd = '') {
  if (typeof cmd !== 'string' || !cmd.trim()) return [];
  const blank = (m) => '_'.repeat(m.length);
  const bare = cmd
    .replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$))/g, (_, h, _q, _w, b) => h + blank(b))
    .replace(/\\[\s\S]/g, blank)
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, blank)
    .replace(/\d*>&\d+|&>/g, blank);

  const out = [];
  let base = cwd || '';
  let at = 0;
  for (const m of [...bare.matchAll(/&&|\|\||[;|&\n()`]/g), { index: cmd.length, 0: '' }]) {
    const part = bare.slice(at, m.index);
    const orig = cmd.slice(at, m.index);
    const from = at;
    at = m.index + m[0].length;

    const cdMatch = /^\s*cd\s+(\S+)\s*$/.exec(orig);
    if (cdMatch) {
      const nextBase = resolveShellPath(base, cdMatch[1], home);
      if (nextBase) base = nextBase;
      continue;
    }

    const head = BASH_READ_HEAD.exec(part);
    if (!head || part.includes('<<')) continue;
    const verb = head[1].replace(/\s+/g, ' ');
    const needsPattern = PATTERN_CMDS.has(verb);
    let sawExplicitPattern = false;
    let positionalIdx = 0;
    let skipNext = false;

    for (const w of part.slice(head[0].length).matchAll(/\S+/g)) {
      const start = from + head[0].length + w.index;
      const word = cmd.slice(start, start + w[0].length);
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (/^(\d*|&)[<>]+/.test(word) || /[<>]/.test(word)) {
        skipNext = /^(\d*|&)[<>]+$/.test(word);
        continue;
      }
      if (word.startsWith('-')) {
        if (word === '-e' || word === '-f' || word.startsWith('--regexp=') || word.startsWith('--file=')) {
          sawExplicitPattern = true;
        }
        const isHeadTail = verb === 'head' || verb === 'tail';
        if ((isHeadTail && HEAD_TAIL_ARG_FLAGS.test(word)) || (!isHeadTail && SEARCH_ARG_FLAGS.test(word))) {
          skipNext = true;
        }
        continue;
      }
      positionalIdx += 1;
      if (needsPattern && !sawExplicitPattern && positionalIdx === 1) continue;

      const resolved = resolveShellPath(base, word, home);
      if (!resolved) continue;
      if (existsSync(resolved)) {
        try {
          const st = statSync(resolved);
          if (st.isFile() || (verb === 'ls' && st.isDirectory())) {
            if (!out.includes(resolved)) out.push(resolved);
          }
          continue;
        } catch { /* ignore */ }
      }
      if (resolved.includes('/') && !out.includes(resolved)) {
        out.push(resolved);
      }
    }
  }
  return out;
}

function shortCmd(cmd) {
  if (!cmd) return 'shell';
  const clean = cmd.replace(/\s+/g, ' ').trim();
  const firstSeg = clean.split(/\s*(?:&&|\|\||;|\|)\s*/)[0] || clean;
  return firstSeg.length > 36 ? `${firstSeg.slice(0, 35)}…` : firstSeg;
}

function clampShort(v, max = 36) {
  const s = String(v ?? '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function tokenizeShellSegment(seg) {
  const tokens = [];
  let cur = '';
  let quote = '';
  let hasToken = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else if (quote === '"' && ch === '\\' && i + 1 < seg.length) {
        cur += seg[++i];
      } else {
        cur += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < seg.length) {
      cur += seg[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

function expandHomePath(p, home) {
  if (!p) return '';
  if (home && (p === '~' || p.startsWith('~/'))) return join(home, p.slice(1));
  return p;
}

function filterLearningFiles(files) {
  const list = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f.trim()) : [];
  const nonReadme = list.filter((f) => !/(?:^|\/)docs\/learnings\/README\.md$/i.test(f) && basename(f).toUpperCase() !== 'README.MD');
  return nonReadme.length ? nonReadme : list;
}

/** Parse `agent-memory` and `agy-compound` CLI invocations inside a shell command string. */
export function parseMemoryShellCommand(cmd, home = '') {
  if (typeof cmd !== 'string' || !cmd.trim()) return [];
  const uses = [];
  let shellCwd = '';
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    const rawTokens = tokenizeShellSegment(seg);
    if (!rawTokens.length) continue;
    let idx = 0;
    while (idx < rawTokens.length && (/^[A-Za-z_]\w*=/.test(rawTokens[idx]) || /^(?:env|rtk|python3|python)$/.test(basename(rawTokens[idx])))) {
      idx += 1;
    }
    const bin = rawTokens[idx] ? basename(rawTokens[idx]) : '';
    const args = rawTokens.slice(idx + 1);
    if (bin === 'cd' && args[0] && !args[0].startsWith('-')) {
      const target = expandHomePath(args[0], home);
      shellCwd = target.startsWith('/') ? target : (shellCwd ? join(shellCwd, target) : target);
      continue;
    }
    if (!args.length) continue;

    if (bin === 'agent-memory') {
      const sub = args[0];
      if (sub === 'remember') {
        let cwd = shellCwd;
        const noteParts = [];
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--cwd' && args[i + 1]) cwd = expandHomePath(args[++i], home);
          else if (args[i].startsWith('--cwd=')) cwd = expandHomePath(args[i].slice(6), home);
          else if (!args[i].startsWith('-')) noteParts.push(args[i]);
        }
        const note = noteParts.join(' ').trim();
        if (note) {
          uses.push({
            kind: 'memory',
            name: `remember:${note}`,
            short: clampShort(note, 36),
            summary: note,
            action: 'remembered',
            group: 'saved',
            filePath: '',
            cwd,
            source: 'agent-memory',
          });
        }
      } else if (sub === 'search') {
        const qParts = [];
        for (let i = 1; i < args.length; i++) {
          if ((args[i] === '--cwd' || args[i] === '--limit' || args[i] === '-n') && args[i + 1]) i += 1;
          else if (args[i].startsWith('--')) continue;
          else qParts.push(args[i]);
        }
        const query = qParts.join(' ').trim();
        if (query) {
          uses.push({
            kind: 'memory',
            name: `search:${query}`,
            short: clampShort(query, 36),
            summary: query,
            action: 'search',
            group: 'read',
            filePath: '',
            source: 'agent-memory',
          });
        }
      } else if (sub === 'drift' || sub === 'context') {
        uses.push({
          kind: 'memory',
          name: `agent-memory ${sub}`,
          short: `memory ${sub}`,
          summary: '',
          action: sub,
          group: 'read',
          filePath: '',
          source: 'agent-memory',
        });
      }
    } else if (bin === 'agy-compound' && args[0] === 'record') {
      let cwd = shellCwd;
      let summary = '';
      let updated = false;
      const files = [];
      for (let i = 1; i < args.length; i++) {
        const tok = args[i];
        if (tok === '--updated') updated = true;
        else if (tok === '--cwd' && args[i + 1]) cwd = expandHomePath(args[++i], home);
        else if (tok.startsWith('--cwd=')) cwd = expandHomePath(tok.slice(6), home);
        else if (tok === '--summary' && args[i + 1]) summary = args[++i];
        else if (tok.startsWith('--summary=')) summary = tok.slice(10);
        else if (tok === '--cid' && args[i + 1]) i += 1;
        else if (tok === '--files') {
          while (i + 1 < args.length && !args[i + 1].startsWith('--')) files.push(args[++i]);
        }
      }
      for (const f of filterLearningFiles(files)) {
        uses.push({
          kind: 'learnings',
          name: f,
          short: basename(f).replace(/\.(md|txt|json)$/i, '') || f,
          summary: clampShort(summary, 140),
          action: updated ? 'updated' : 'captured',
          group: 'saved',
          filePath: f.startsWith('/') ? f : '',
          cwd,
          source: 'agy-compound',
        });
      }
    }
  }
  return uses;
}

function annotateMemoryUse(cls, toolName) {
  if (!cls || (cls.kind !== 'memory' && cls.kind !== 'learnings')) return { ...cls, source: toolName };
  const action = /^(write_file|write_to_file)$/.test(toolName)
    ? 'captured'
    : /^(edit_file|replace_file_content|multi_replace_file_content)$/.test(toolName)
      ? 'updated'
      : 'read';
  return {
    ...cls,
    action,
    group: action === 'read' ? 'read' : 'saved',
    filePath: cls.name,
    source: toolName,
  };
}

export function extractToolUses(call, home = '') {
  const name = String(call?.name ?? '');
  const args = call?.args && typeof call.args === 'object' ? call.args : {};
  if (!name || isMarginToolCall(name, args)) return [];

  const cat = categoryOf(name, args);
  if (!cat) return [];

  if (cat === 'files') {
    const multi = unquote(args.Paths ?? args.paths);
    if (Array.isArray(multi) && multi.length) {
      return multi.map((p) => unquote(p)).map(classifyPath).filter(Boolean).map((u) => annotateMemoryUse(u, name));
    }
    const p = pathArg(call);
    const query = String(unquote(args.Query ?? args.Pattern ?? args.query ?? args.pattern ?? '') || '').trim();
    if (p) {
      const isSearchTool = /^(grep_search|grep|glob|find_by_name|list_dir)$/.test(name);
      if (isSearchTool && query && !/\.[a-z0-9]{1,8}$/i.test(p)) {
        return [{ kind: 'files', name: p, short: `${basename(p) || p} (${query.slice(0, 20)})`, source: name }];
      }
      const cls = classifyPath(p);
      if (cls) return [annotateMemoryUse(cls, name)];
    }
    if (query) {
      return [{ kind: 'other', name: query, short: query.slice(0, 36), source: name }];
    }
    return [{ kind: 'files', name, short: name, source: name }];
  }

  if (cat === 'shell') {
    if (name === 'run_command') {
      const cmd = String(unquote(args.CommandLine ?? args.command ?? '') || '').trim();
      const summary = String(unquote(args.toolSummary ?? '') || '').trim();
      const uses = [{
        kind: 'shell',
        name: cmd ? cmd.replace(/\s+/g, ' ').slice(0, 240) : (summary || 'run_command'),
        short: summary ? summary.slice(0, 36) : shortCmd(cmd),
        source: 'run_command',
      }];
      for (const bp of bashPaths(cmd, home)) {
        const cls = classifyPath(bp);
        if (cls) uses.push(annotateMemoryUse(cls, 'bash'));
      }
      for (const mu of parseMemoryShellCommand(cmd, home)) {
        if (mu.source === 'agent-memory') uses.push(mu);
      }
      return uses;
    }
    const target = String(unquote(args.Action ?? args.TaskId ?? '') || name).trim();
    return [{ kind: 'shell', name: target, short: target.slice(0, 36), source: name }];
  }

  if (cat === 'web') {
    const query = String(unquote(args.query ?? args.Query ?? '') || '').trim();
    if (name === 'search_web' || query) {
      const q = query || name;
      return [{ kind: 'web', name: q, short: q.slice(0, 40), source: 'search' }];
    }
    const url = String(unquote(args.Url ?? args.url ?? '') || '').trim();
    if (url) {
      let host = url;
      try { host = new URL(url).host || url; } catch { /* keep raw */ }
      return [{ kind: 'web', name: url, short: host, source: name }];
    }
    return [{ kind: 'web', name, short: name, source: name }];
  }

  if (cat === 'agents') {
    if (name === 'invoke_subagent') {
      const role = String(unquote(args.Role ?? args.AgentName ?? args.TypeName ?? '') || 'subagent').trim();
      return [{ kind: 'agents', name: role, short: role.slice(0, 36), source: 'invoke_subagent' }];
    }
    if (name === 'swarm') {
      const action = String(unquote(args.action ?? '') || 'swarm').trim();
      const worker = String(unquote(args.name ?? args.title ?? '') || '').trim();
      const label = worker ? `${action} ${worker}` : action;
      return [{ kind: 'agents', name: label, short: (worker || action).slice(0, 36), source: 'swarm' }];
    }
    const label = String(unquote(args.AgentName ?? args.Role ?? '') || name).trim();
    return [{ kind: 'agents', name: label, short: label.slice(0, 36), source: name }];
  }

  if (name === 'call_mcp_tool') {
    const srv = String(unquote(args.ServerName ?? '') || 'mcp').trim();
    const tl = String(unquote(args.ToolName ?? '') || srv).trim();
    const kind = /playwright|chrome|browser/i.test(srv) ? 'web' : 'other';
    return [{ kind, name: tl, short: tl.slice(0, 36), source: srv }];
  }

  if (name === 'search_marketplace') {
    const qs = unquote(args.queries);
    const label = Array.isArray(qs) && qs.length ? qs.join(', ') : name;
    return [{ kind: 'other', name: label, short: label.slice(0, 36), source: name }];
  }

  return [{ kind: 'other', name, short: name, source: name }];
}

/**
 * Collect rich `used` totals and `usedDetails` breakdown across the main turn
 * and any spawned subagent / swarm worker transcripts.
 */
export function collectUsed(turnRows, subagentSources = [], home = '') {
  const buckets = Object.fromEntries(USED_CATEGORIES.map((k) => [k, { main: 0, agents: 0, byKey: new Map() }]));

  const record = (reader, rows) => {
    const isMain = reader === 'main';
    for (const r of rows) {
      for (const c of toolCalls(r)) {
        for (const u of extractToolUses(c, home)) {
          const b = buckets[u.kind] ?? buckets.other;
          if (isMain) b.main += 1;
          else b.agents += 1;
          const mapKey = `${reader}\0${u.name}`;
          const prev = b.byKey.get(mapKey);
          const count = (prev?.count ?? 0) + 1;
          // Re-insert so the most recent item sits last, then we reverse for newest-first.
          if (prev) b.byKey.delete(mapKey);
          const upgradedSaved = prev?.group === 'saved' || u.group === 'saved';
          const nextItem = {
            name: u.name,
            short: u.short || u.name,
            count,
            source: (u.group === 'saved' ? u.source : prev?.group === 'saved' ? prev.source : u.source) || prev?.source || '',
            reader,
          };
          if (u.action || prev?.action) {
            nextItem.action = u.group === 'saved' ? u.action : (prev?.action || u.action);
          }
          if (upgradedSaved) nextItem.group = 'saved';
          else if (u.group) nextItem.group = u.group;
          if (u.filePath || prev?.filePath) nextItem.filePath = u.filePath || prev.filePath;
          if (u.summary || prev?.summary) nextItem.summary = u.summary || prev.summary;
          if (u.cwd || prev?.cwd) nextItem.cwd = u.cwd || prev.cwd;
          b.byKey.set(mapKey, nextItem);
        }
      }
    }
  };

  record('main', turnRows);
  for (const sub of subagentSources) {
    if (!sub?.rows?.length) continue;
    record(sub.reader || sub.name || 'agent', sub.rows);
  }

  const used = {};
  const usedDetails = {};
  for (const k of USED_CATEGORIES) {
    const b = buckets[k];
    const allItems = [...b.byKey.values()].reverse();
    const mainItems = allItems.filter((it) => it.reader === 'main');
    const agentItems = allItems.filter((it) => it.reader !== 'main');
    used[k] = b.main + b.agents;
    usedDetails[k] = {
      main: b.main,
      agents: b.agents,
      items: [...mainItems, ...agentItems],
    };
  }
  return { used, usedDetails };
}

const safeInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

function rowChars(r) {
  if (!r || typeof r !== 'object') return 0;
  let total = 0;
  if (typeof r.content === 'string') total += r.content.length;
  if (typeof r.thinking === 'string') total += r.thinking.length;
  if (Array.isArray(r.tool_calls) && r.tool_calls.length) total += JSON.stringify(r.tool_calls).length;
  return total;
}

const MODEL_CHANGE_RE = /changed setting `Model Selection` from [^\n]+? to ([^\n]+?)(?:\.\s+No need|\.\s*$)/g;

function extractSettingsModel(text) {
  if (typeof text !== 'string' || !text.includes('Model Selection')) return '';
  let found = '';
  for (const m of text.matchAll(MODEL_CHANGE_RE)) {
    if (m[1]?.trim()) found = m[1].trim();
  }
  return found;
}

export function detectModel(rows, { fallbackModel = '', headText = '' } = {}) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (typeof r?.model === 'string' && r.model.trim()) return r.model.trim();
    if (typeof r?.content === 'string' && r.content.includes('Model Selection')) {
      const m = extractSettingsModel(r.content);
      if (m) return m;
    }
  }
  if (headText) {
    const m = extractSettingsModel(headText);
    if (m) return m;
  }
  return typeof fallbackModel === 'string' ? fallbackModel.trim() : '';
}

export function modelContextLimit(model, tokens = 0) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const m = model.toLowerCase();
  if (/gemini|orchestrator|\b(argon|carbon|hydrogen|neon)\b/.test(m)) return 1_000_000;
  if (/claude|\b(opus|sonnet|haiku)\b/.test(m)) return tokens > 200_000 ? 1_000_000 : 200_000;
  if (/\b(gpt-5|o1|o3|o4)\b/.test(m)) return 200_000;
  if (/gpt-4o|glm|ernie|deepseek/.test(m)) return 128_000;
  return null;
}

/**
 * Compute accurate current context window telemetry from transcript rows,
 * handling CHECKPOINT compactions, >32KB trailing tool outputs, and char/4 fallback.
 */
export function computeContext(rows, opts = {}) {
  const model = detectModel(rows, opts);
  if (!rows.length) {
    return {
      tokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      maxTokens: modelContextLimit(model, 0),
      pct: null,
      model,
      source: 'none',
    };
  }

  let lastCheckpoint = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.type === 'CHECKPOINT') lastCheckpoint = i;
  }

  const postCheckpoint = lastCheckpoint >= 0 ? rows.slice(lastCheckpoint + 1) : rows;
  let sawTokenlessPlanner = false;
  for (let i = postCheckpoint.length - 1; i >= 0; i--) {
    const r = postCheckpoint[i];
    if (r?.type !== 'PLANNER_RESPONSE') continue;
    if (r.subagent_id || r.parent_conversation_id || (r.source && r.source !== 'MODEL')) continue;
    const cacheWriteTokens = safeInt(r.cache_write_tokens ?? r.cache_creation_tokens ?? r.cache_creation_input_tokens);
    const inputTokens = safeInt(r.input_tokens) + cacheWriteTokens;
    const cacheReadTokens = safeInt(r.cache_read_tokens ?? r.cache_read_input_tokens);
    const outputTokens = safeInt(r.output_tokens);
    const tokens = inputTokens + cacheReadTokens + outputTokens;
    if (tokens > 0) {
      const maxTokens = modelContextLimit(model, tokens);
      const pct = maxTokens ? Math.min(100, Math.round((tokens / maxTokens) * 100)) : null;
      return {
        tokens,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        maxTokens,
        pct,
        model,
        source: 'reported',
      };
    }
    sawTokenlessPlanner = true;
  }

  // Before any PLANNER_RESPONSE or CHECKPOINT exists, context has not been reported yet.
  if (lastCheckpoint < 0 && !sawTokenlessPlanner) {
    return {
      tokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      maxTokens: modelContextLimit(model, 0),
      pct: null,
      model,
      source: 'none',
    };
  }

  // Provider omitted token counts or right after CHECKPOINT before next PLANNER_RESPONSE: estimate chars / 4.
  let estimatedTokens = 0;
  if (lastCheckpoint >= 0) {
    const cp = rows[lastCheckpoint];
    const cpOut = safeInt(cp?.output_tokens);
    estimatedTokens += cpOut > 0 ? cpOut : Math.ceil(rowChars(cp) / 4);
  }
  const postChars = postCheckpoint.reduce((sum, r) => sum + rowChars(r), 0);
  estimatedTokens += Math.ceil(postChars / 4);

  const source = estimatedTokens > 0 ? 'estimated' : 'none';
  const maxTokens = modelContextLimit(model, estimatedTokens);
  const pct = maxTokens && source !== 'none' ? Math.min(100, Math.round((estimatedTokens / maxTokens) * 100)) : null;
  return {
    tokens: estimatedTokens,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    maxTokens,
    pct,
    model,
    source,
  };
}

/** Summarise a subagent / worker transcript into one of: pending | running | waiting | completed | failed | killed. */
export function summarizeSubagent(rows, subagentState = '', now = Date.now()) {
  if (subagentState === 'SUBAGENT_STATE_KILLED') return 'killed';
  if (!rows.length) return 'pending';
  const lastWork = [...rows].reverse().find((r) => r.type !== 'CHECKPOINT' && r.type !== 'SYSTEM_MESSAGE') ?? null;
  const lastAt = (lastWork ?? rows[rows.length - 1])?.created_at ?? null;
  const age = lastAt ? now - Date.parse(lastAt) : 0;
  if (!lastWork) return age > IDLE_MS ? 'failed' : 'pending';
  if (lastWork.type === 'ERROR_MESSAGE' || lastWork.status === 'ERROR') return 'failed';
  if (lastWork.type === 'PLANNER_RESPONSE' && toolCalls(lastWork).length === 0 && lastWork.status === 'DONE') {
    return 'completed';
  }
  const lastPlanner = [...rows].reverse().find((r) => r.type === 'PLANNER_RESPONSE') ?? null;
  if (lastPlanner && toolCalls(lastPlanner).some((c) => c?.name === 'swarm_wait') && lastWork.status === 'DONE') {
    return 'waiting';
  }
  if (age > IDLE_MS) return 'failed';
  return 'running';
}

/**
 * Summarise the latest turn (everything since the last real user message).
 * @returns {{status:string, ask:string, userStep:number, turnStartedAt:string|null,
 *   lastStepAt:string|null, used:Record<string,number>, files:string[], steps:number,
 *   turnSteps:number, turnTools:number, prevTurnDone:boolean, turnRows:object[]}}
 */
export function summarize(rows, now = Date.now()) {
  let lastUser = -1;
  rows.forEach((r, i) => { if (r.type === 'USER_INPUT' && r.source === 'USER_EXPLICIT') lastUser = i; });
  const turn = rows.slice(lastUser + 1);
  const used = {};
  const files = [];
  let turnSteps = 0;
  let turnTools = 0;
  for (const r of turn) {
    if (r.type === 'PLANNER_RESPONSE') turnSteps += 1;
    for (const c of toolCalls(r)) {
      const cat = categoryOf(String(c?.name ?? ''), c?.args);
      if (!cat) continue;
      turnTools += 1;
      used[cat] = (used[cat] || 0) + 1;
      if (cat === 'files') {
        const p = pathArg(c);
        if (p && !files.includes(p)) files.push(p);
      }
    }
  }

  let prevTurnDone = false;
  if (lastUser > 0) {
    const prevWork = [...rows.slice(0, lastUser)]
      .reverse()
      .find((r) => r.type !== 'CHECKPOINT' && r.type !== 'SYSTEM_MESSAGE' && !(r.type === 'USER_INPUT' && r.source === 'USER_EXPLICIT'));
    if (prevWork && prevWork.type === 'PLANNER_RESPONSE' && toolCalls(prevWork).length === 0 && prevWork.status === 'DONE') {
      prevTurnDone = true;
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
  else if ((lastWork.status === 'ERROR' || lastWork.type === 'ERROR_MESSAGE') && age > 60_000) status = 'stopped';
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
    turnSteps,
    turnTools,
    prevTurnDone,
    turnRows: turn,
  };
}
