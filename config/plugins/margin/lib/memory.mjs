// Read-only session memory extraction/capture reader (memory.db, audit.jsonl, transcript) and safe doc viewer.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { classifyPath, parseMemoryShellCommand, pathArg, toolCalls, unquote } from './transcript.mjs';
export { parseMemoryShellCommand };

const isAbsPath = (p) => typeof p === 'string' && (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p));
const toPosix = (p) => String(p ?? '').replace(/\\/g, '/');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Node < 22.13 lacks unflagged node:sqlite; degrade memory.db queries gracefully.
}

const MAX_DOC_BYTES = 256 * 1024;
const EXCERPT_READ_BYTES = 8192;
const CACHE_LIMIT = 128;

const excerptCache = new Map();
const auditCache = new Map();
const dbCache = new Map();

const BLOCKED_PATH_RE = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.config\/gcloud|\.git-credentials|Downloads)(?:\/|$)/i;
const BLOCKED_FILE_RE = /^(?:\.env(?:\.|$)|.*\.pem$|.*\.key$|.*\.p12$|.*\.jks$|.*credentials.*)/i;
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file']);
const CREATE_TOOLS = new Set(['write_file', 'write_to_file']);

function boundedSet(map, key, val, limit = CACHE_LIMIT) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function clamp(v, max) {
  const s = String(v ?? '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function stripMdInline(s) {
  return String(s ?? '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cwdToSlug(cwd) {
  const cleaned = String(cwd || '').replace(/^\/+|\/+$/g, '').replace(/\//g, '-');
  return cleaned ? `--${cleaned}--` : '--root--';
}

function cleanRolloutShort(filePath) {
  const base = basename(filePath).replace(/\.(md|txt|json)$/i, '');
  return base.replace(/^\d{4}-\d{2}-\d{2}_[0-9a-f]{6,12}_/i, '') || base;
}

/** Resolve hermetic-safe `memoriesDir` and `compoundDir` from `contextDirsFromBrain` output. */
export function memoryStoreDirs(ctxDirs = {}) {
  const home = ctxDirs.home || homedir();
  const useEnv = !ctxDirs.isHermetic || home === homedir();
  const memEnv = useEnv ? process.env.AGY_MEMORY_HOME : '';
  const compEnv = useEnv ? process.env.AGY_COMPOUND_HOME : '';
  return {
    home,
    memoriesDir: memEnv || join(home, '.agents', 'memories'),
    compoundDir: compEnv || join(home, '.agents', 'compound'),
  };
}

/** Extract a concise 1-line summary from a markdown/text memory file (mtime-cached). */
export function readMarkdownExcerpt(filePath, maxChars = 140) {
  if (!filePath || typeof filePath !== 'string') return '';
  let st;
  try {
    st = statSync(filePath);
    if (!st.isFile() || st.size === 0) return '';
  } catch {
    return '';
  }
  const key = `${filePath}\0${st.mtimeMs}\0${st.size}\0${maxChars}`;
  if (excerptCache.has(key)) return excerptCache.get(key);

  let text = '';
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const len = Math.min(st.size, EXCERPT_READ_BYTES);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, 0);
    text = buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  let fmTitle = '';
  let body = text.replace(/\r\n/g, '\n');
  if (body.startsWith('---\n')) {
    const endIdx = body.indexOf('\n---\n', 4);
    if (endIdx > 0) {
      const fm = body.slice(4, endIdx);
      const tm = /^title:\s*(.+)$/im.exec(fm);
      if (tm?.[1]) fmTitle = stripMdInline(tm[1].trim().replace(/^['"]|['"]$/g, ''));
      body = body.slice(endIdx + 5);
    }
  }

  let heading = '';
  let firstProse = '';
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === '---' || line.startsWith('<!--') || /^>?\s*\[!/.test(line)) continue;
    if (/^#{1,6}\s+/.test(line)) {
      if (!heading) heading = stripMdInline(line.replace(/^#{1,6}\s+/, ''));
      continue;
    }
    const cleaned = stripMdInline(line.replace(/^(?:[-•*]|\d+\.)\s+/, ''));
    if (!cleaned || /^#\S+(?:\s+#\S+)*$/.test(cleaned)) continue;
    firstProse = cleaned;
    break;
  }

  let excerpt = '';
  if (fmTitle && firstProse && fmTitle.length < 70 && !firstProse.toLowerCase().startsWith(fmTitle.toLowerCase())) {
    excerpt = clamp(`${fmTitle} — ${firstProse}`, maxChars);
  } else {
    excerpt = clamp(fmTitle || firstProse || heading, maxChars);
  }
  boundedSet(excerptCache, key, excerpt);
  return excerpt;
}

function statMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/** Read Stage-1/Stage-2 extracted rollout memories and workspace `MEMORY.md` path from `memory.db`. */
export function readExtractedMemories(conv, memoriesDir) {
  const empty = { items: [], workspaceSlug: '', workspacePath: '', workspaceMemoryPath: '' };
  if (!conv || !memoriesDir || !DatabaseSync) return empty;
  const dbPath = join(memoriesDir, 'memory.db');
  if (!existsSync(dbPath)) return empty;

  const cacheKey = `${dbPath}\0${statMtime(dbPath)}\0${statMtime(`${dbPath}-wal`)}\0${conv}`;
  if (dbCache.has(cacheKey)) return dbCache.get(cacheKey);

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 500 });
    const proc = db.prepare(
      'SELECT workspace_slug, stage1_status, consolidated, rollout_file, updated_at FROM processed_threads WHERE thread_id = ?',
    ).get(`agy:${conv}`);
    const wsRow = db.prepare(
      'SELECT workspace_path, workspace_slug FROM session_workspaces WHERE conversation_id = ?',
    ).get(conv);
    const injRow = db.prepare(
      'SELECT workspace_slug, cwd FROM memory_injections WHERE cid = ?',
    ).get(conv);

    const workspaceSlug = String(proc?.workspace_slug || wsRow?.workspace_slug || injRow?.workspace_slug || '');
    const workspacePath = String(wsRow?.workspace_path || injRow?.cwd || '');
    const memMd = workspaceSlug ? join(memoriesDir, workspaceSlug, 'MEMORY.md') : '';
    const workspaceMemoryPath = memMd && existsSync(memMd) ? resolve(memMd) : '';

    const items = [];
    if (proc?.stage1_status === 'extracted' && proc?.rollout_file) {
      const primary = resolve(String(proc.rollout_file));
      const candidates = new Set();
      if (existsSync(primary)) candidates.add(primary);
      const rdir = dirname(primary);
      const cidPrefix = `_${conv.slice(0, 8)}_`;
      if (existsSync(rdir)) {
        try {
          for (const fname of readdirSync(rdir)) {
            if (fname.endsWith('.md') && fname.includes(cidPrefix)) {
              candidates.add(resolve(join(rdir, fname)));
            }
          }
        } catch { /* ignore unreadable dir */ }
      }

      const sorted = [...candidates].sort((a, b) => {
        const dt = statMtime(b) - statMtime(a);
        return dt !== 0 ? dt : basename(b).localeCompare(basename(a));
      });
      const action = proc.consolidated ? 'consolidated' : 'extracted';
      for (const absPath of sorted) {
        items.push({
          name: absPath,
          filePath: absPath,
          short: cleanRolloutShort(absPath),
          summary: readMarkdownExcerpt(absPath),
          action,
          group: 'saved',
          source: action,
          count: 1,
          reader: 'main',
          earlier: false,
        });
      }
    }

    const out = { items, workspaceSlug, workspacePath, workspaceMemoryPath };
    boundedSet(dbCache, cacheKey, out, 64);
    return out;
  } catch {
    return empty;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function readAuditIndex(auditPath) {
  let st;
  try {
    st = statSync(auditPath);
    if (!st.isFile()) return new Map();
  } catch {
    return new Map();
  }
  const cacheKey = `${auditPath}\0${st.mtimeMs}\0${st.size}`;
  if (auditCache.has(cacheKey)) return auditCache.get(cacheKey);

  const byCid = new Map();
  try {
    const raw = readFileSync(auditPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec?.cid) continue;
      if (!byCid.has(rec.cid)) byCid.set(rec.cid, []);
      byCid.get(rec.cid).push(rec);
    }
  } catch {
    return new Map();
  }
  boundedSet(auditCache, cacheKey, byCid, 8);
  return byCid;
}

function filterLearningFiles(files) {
  const list = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f.trim()) : [];
  const nonReadme = list.filter((f) => !/(?:^|\/)docs\/learnings\/README\.md$/i.test(f) && basename(f).toUpperCase() !== 'README.MD');
  return nonReadme.length ? nonReadme : list;
}

/** Read captured/updated learnings from `~/.agents/compound/audit.jsonl` for a conversation. */
export function readCompoundCaptures(conv, compoundDir, currentUserStep = -1) {
  if (!conv || !compoundDir) return [];
  const records = readAuditIndex(join(compoundDir, 'audit.jsonl')).get(conv) || [];
  const items = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.outcome !== 'CAPTURED' && r.outcome !== 'UPDATED') continue;
    const stepStr = typeof r.turn_key === 'string' ? r.turn_key.split(':')[0] : '';
    const turnStep = /^\d+$/.test(stepStr) ? Number(stepStr) : null;
    const earlier = turnStep !== null && Number.isInteger(currentUserStep) && currentUserStep >= 0
      ? turnStep !== currentUserStep
      : false;
    const action = r.outcome === 'UPDATED' ? 'updated' : 'captured';
    const files = filterLearningFiles(r.files);
    for (const rawFile of files) {
      const absPath = isAbsPath(rawFile) ? resolve(rawFile) : (r.cwd ? resolve(String(r.cwd), rawFile) : rawFile);
      const hasFile = isAbsPath(absPath) && existsSync(absPath);
      const excerpt = hasFile ? readMarkdownExcerpt(absPath) : '';
      items.push({
        name: absPath,
        filePath: isAbsPath(absPath) ? absPath : '',
        short: basename(rawFile).replace(/\.(md|txt|json)$/i, '') || rawFile,
        summary: excerpt || clamp(r.summary || '', 140),
        action,
        group: 'saved',
        source: 'agy-compound',
        count: 1,
        reader: 'main',
        earlier,
      });
    }
  }
  return items;
}

function dedupeSavedEntries(entriesByPriority) {
  const byKey = new Map();
  const findSuffixMatch = (relPath) => {
    if (!relPath || isAbsPath(relPath)) return '';
    const suffix = `/${toPosix(relPath).replace(/^\.\//, '')}`;
    for (const k of byKey.keys()) {
      if (k.startsWith('path:') && toPosix(k).endsWith(suffix)) return k;
    }
    return '';
  };
  const upsert = (item, priority) => {
    let key = item.action === 'remembered'
      ? `rem:${String(item.summary || item.name).trim().toLowerCase()}`
      : `path:${item.filePath || item.name}`;
    if (!item.filePath && item.action !== 'remembered') {
      const matched = findSuffixMatch(item.name);
      if (matched) key = matched;
    }
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { item: { ...item }, priority });
      return;
    }
    const earlier = Boolean(prev.item.earlier && item.earlier);
    if (priority >= prev.priority) {
      byKey.set(key, {
        item: {
          ...item,
          earlier,
          summary: item.summary || prev.item.summary,
          filePath: item.filePath || prev.item.filePath,
        },
        priority,
      });
    } else {
      prev.item.earlier = earlier;
      if (!prev.item.summary && item.summary) prev.item.summary = item.summary;
      if (!prev.item.filePath && item.filePath) prev.item.filePath = item.filePath;
    }
  };

  for (const [list, priority] of entriesByPriority) {
    for (const entry of list) upsert(entry, priority);
  }

  const items = [...byKey.values()].map((v) => v.item);
  // Current-turn items first, earlier-turn items after
  items.sort((a, b) => Number(Boolean(a.earlier)) - Number(Boolean(b.earlier)));
  return items;
}

/** Collect all captured/remembered/extracted memories and learnings across the entire conversation. */
export function collectSessionSavedMemories({
  conv = '',
  allRows = [],
  currentUserStep = -1,
  home = '',
  memoriesDir = '',
  compoundDir = '',
} = {}) {
  const extracted = readExtractedMemories(conv, memoriesDir);
  const compoundItems = readCompoundCaptures(conv, compoundDir, currentUserStep);

  const txMemoryWrites = [];
  const txLearningWrites = [];
  const txRemembers = [];
  const txRecords = [];
  let curStep = -1;

  for (const r of allRows) {
    if (r?.type === 'USER_INPUT' && r?.source === 'USER_EXPLICIT') {
      curStep = Number(r.step_index);
      continue;
    }
    const earlier = Number.isInteger(currentUserStep) && currentUserStep >= 0 && curStep >= 0
      ? curStep !== currentUserStep
      : false;
    for (const c of toolCalls(r)) {
      const tname = String(c?.name ?? '');
      if (WRITE_TOOLS.has(tname)) {
        const p = pathArg(c);
        const cls = classifyPath(p);
        if (cls?.kind === 'memory' || cls?.kind === 'learnings') {
          const abs = isAbsPath(p) ? resolve(p) : p;
          const entry = {
            name: abs,
            filePath: isAbsPath(abs) ? abs : '',
            short: cls.short,
            summary: isAbsPath(abs) ? readMarkdownExcerpt(abs) : '',
            action: CREATE_TOOLS.has(tname) ? 'captured' : 'updated',
            group: 'saved',
            source: tname,
            count: 1,
            reader: 'main',
            earlier,
            step: curStep,
          };
          if (cls.kind === 'memory') txMemoryWrites.push(entry);
          else txLearningWrites.push(entry);
        }
      } else if (tname === 'run_command') {
        const cmd = String(unquote(c?.args?.CommandLine ?? c?.args?.command ?? '') || '');
        for (const u of parseMemoryShellCommand(cmd, home)) {
          if (u.group !== 'saved') continue;
          if (u.kind === 'memory' && u.action === 'remembered') {
            let memFile = '';
            if (u.cwd && memoriesDir) {
              const normCwd = isAbsPath(u.cwd) ? resolve(u.cwd) : u.cwd;
              const cand = join(memoriesDir, cwdToSlug(normCwd), 'MEMORY.md');
              if (existsSync(cand)) memFile = resolve(cand);
            }
            if (!memFile && extracted.workspaceMemoryPath) memFile = extracted.workspaceMemoryPath;
            txRemembers.push({
              name: u.name,
              filePath: memFile,
              short: u.short,
              summary: u.summary,
              action: 'remembered',
              group: 'saved',
              source: 'agent-memory',
              count: 1,
              reader: 'main',
              earlier,
            });
          } else if (u.kind === 'learnings' && u.source === 'agy-compound') {
            const cwd = u.cwd || extracted.workspacePath;
            const abs = u.filePath ? resolve(u.filePath) : (cwd ? resolve(cwd, u.name) : u.name);
            txRecords.push({
              name: abs,
              filePath: isAbsPath(abs) && existsSync(abs) ? abs : '',
              short: u.short,
              summary: (isAbsPath(abs) ? readMarkdownExcerpt(abs) : '') || u.summary,
              action: u.action,
              group: 'saved',
              source: 'agy-compound',
              count: 1,
              reader: 'main',
              earlier,
            });
          }
        }
      }
    }
  }

  // Filter docs/learnings/README.md out of txLearningWrites per turn if another non-README learning file was written in the same turn.
  const nonReadmeSteps = new Set(
    txLearningWrites
      .filter((w) => !/(?:^|\/)docs\/learnings\/README\.md$/i.test(w.name) && basename(w.name).toUpperCase() !== 'README.MD')
      .map((w) => w.step),
  );
  const filteredLearningWrites = txLearningWrites.filter(
    (w) => !(nonReadmeSteps.has(w.step) && (/(?:^|\/)docs\/learnings\/README\.md$/i.test(w.name) || basename(w.name).toUpperCase() === 'README.MD')),
  );

  // Deduplicate by canonical path (richer source wins: audit/extracted > agy-compound record > write_file)
  const items = dedupeSavedEntries([
    [[...txMemoryWrites].reverse(), 1],
    [[...txRemembers].reverse(), 3],
    [extracted.items, 4],
  ]);
  const learningItems = dedupeSavedEntries([
    [[...filteredLearningWrites].reverse(), 1],
    [[...txRecords].reverse(), 2],
    [compoundItems, 3],
  ]);

  return { items, learningItems, extracted };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strict read-only allowlist check for memory & learnings markdown/text files. */
export function isAllowedMemoryPath(rawPath, { home = homedir(), memoriesDir = '' } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) return null;
  if (!isAbsPath(rawPath)) return null;
  const posixRaw = toPosix(rawPath);
  if (BLOCKED_PATH_RE.test(posixRaw) || BLOCKED_FILE_RE.test(basename(posixRaw))) return null;
  if (!/\.(?:md|txt)$/i.test(posixRaw)) return null;

  let realFile;
  try {
    realFile = realpathSync(rawPath);
    const st = statSync(realFile);
    if (!st.isFile() || st.size > MAX_DOC_BYTES) return null;
  } catch {
    return null;
  }

  const posixReal = toPosix(realFile);
  if (BLOCKED_PATH_RE.test(posixReal) || BLOCKED_FILE_RE.test(basename(posixReal))) return null;
  if (!/\.(?:md|txt)$/i.test(posixReal)) return null;

  const effMem = memoriesDir || join(home, '.agents', 'memories');
  let realMem = '';
  try { realMem = realpathSync(effMem); } catch { realMem = resolve(effMem); }
  let realHome = '';
  try { realHome = realpathSync(home); } catch { realHome = resolve(home); }

  const posixMem = toPosix(realMem);
  const posixHome = toPosix(realHome);
  const cmp = process.platform === 'win32'
    ? (a, b) => a.toLowerCase().startsWith(b.toLowerCase())
    : (a, b) => a.startsWith(b);

  if (cmp(posixReal, `${posixMem}/`)) return realFile;
  if (new RegExp(`^${escapeRe(posixHome)}/\\.claude/projects/[^/]+/memory/`, process.platform === 'win32' ? 'i' : '').test(posixReal)) return realFile;
  if (posixReal.toLowerCase().includes('/docs/learnings/')) return realFile;
  if (basename(posixReal).toUpperCase() === 'MEMORY.MD') return realFile;
  return null;
}

/** Safely read an allowlisted memory/learning document for the drawer viewer. */
export function readMemoryDocument(rawPath, opts = {}) {
  const realFile = isAllowedMemoryPath(rawPath, opts);
  if (!realFile) {
    return { ok: false, status: 403, error: 'Memory path not allowed or unavailable.' };
  }
  try {
    const content = readFileSync(realFile, 'utf8');
    return { ok: true, status: 200, path: realFile, title: cleanRolloutShort(realFile), content };
  } catch (err) {
    return { ok: false, status: 500, error: err?.message || 'Read failed.' };
  }
}

/** Render a standalone HTML document for viewing a memory file in a new browser tab (XSS-safe). */
export function renderMemoryViewHtml(rawPath, opts = {}) {
  const doc = readMemoryDocument(rawPath, opts);
  if (!doc.ok) {
    const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Memory unavailable</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#3c4043;background:#f8f9fa}@media(prefers-color-scheme:dark){body{background:#16181c;color:#c4c7c5}}</style></head><body><h2>Memory unavailable</h2><p>${escHtml(doc.error)}</p></body></html>`;
    return { status: doc.status || 403, contentType: 'text/html; charset=utf-8', body };
  }

  const lines = doc.content.replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let inCode = false;
  let codeLines = [];
  let inList = false;
  const closeList = () => { if (inList) { htmlParts.push('</ul>'); inList = false; } };
  const inlineFmt = (s) => escHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeList();
      if (inCode) {
        htmlParts.push(`<pre><code>${escHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const t = line.trim();
    if (!t) {
      closeList();
      continue;
    }
    if (/^---+$/.test(t)) {
      closeList();
      htmlParts.push('<hr>');
      continue;
    }
    const hm = /^(#{1,4})\s+(.+)$/.exec(t);
    if (hm) {
      closeList();
      const lvl = hm[1].length;
      htmlParts.push(`<h${lvl}>${inlineFmt(hm[2])}</h${lvl}>`);
      continue;
    }
    const lm = /^(?:[-•*]|\d+\.)\s+(.+)$/.exec(t);
    if (lm) {
      if (!inList) {
        htmlParts.push('<ul>');
        inList = true;
      }
      htmlParts.push(`<li>${inlineFmt(lm[1])}</li>`);
      continue;
    }
    closeList();
    htmlParts.push(`<p>${inlineFmt(t)}</p>`);
  }
  closeList();
  if (inCode) htmlParts.push(`<pre><code>${escHtml(codeLines.join('\n'))}</code></pre>`);

  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(doc.title)} — ${toPosix(doc.path).includes('/docs/learnings/') ? 'Learning' : 'Memory'}</title>
<style>
  :root { color-scheme: light dark; --bg:#f8f9fa; --surface:#fff; --fg:#1f1f1f; --muted:#5f6368; --line:rgba(0,0,0,.1); --code-bg:rgba(0,0,0,.045); }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --surface:#1e2126; --fg:#e8eaed; --muted:#9aa0a6; --line:rgba(255,255,255,.1); --code-bg:rgba(255,255,255,.06); } }
  body { margin:0; padding:28px 20px 56px; background:var(--bg); color:var(--fg); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width:760px; margin:0 auto; background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:24px 28px; }
  .path { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); margin:0 0 18px; word-break:break-all; }
  h1,h2,h3,h4 { margin:18px 0 8px; line-height:1.3; }
  h1 { font-size:18px; margin-top:0; } h2 { font-size:15px; } h3,h4 { font-size:14px; }
  p,li { margin:6px 0; } ul { padding-left:20px; margin:6px 0; }
  code { font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--code-bg); padding:1px 4px; border-radius:4px; }
  pre { background:var(--code-bg); padding:12px 14px; border-radius:6px; overflow-x:auto; }
  pre code { background:none; padding:0; }
  hr { border:0; border-top:1px solid var(--line); margin:16px 0; }
</style>
</head>
<body>
  <main>
    <p class="path">${escHtml(doc.path)}</p>
    ${htmlParts.join('\n    ')}
  </main>
</body>
</html>`;
  return { status: 200, contentType: 'text/html; charset=utf-8', body };
}
