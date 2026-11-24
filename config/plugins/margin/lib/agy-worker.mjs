// Shared ephemeral `agy` worker prompt runner with cross-product SQLite cleanup.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const INTERNAL_MARKER = '[AGY_INTERNAL_WORKER]';
export const AGY_PRODUCTS = ['antigravity-cli', 'antigravity', 'antigravity-ide'];
export const UUID_STEM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_MODEL = 'gemini-3.8-flash-low';

export function findBinary(candidates, fallbackName) {
  for (const cand of candidates) {
    if (cand && existsSync(cand)) return cand;
  }
  try {
    const found = execFileSync('which', [fallbackName], { encoding: 'utf8', timeout: 2000 }).trim();
    if (found) return found.split('\n')[0].trim();
  } catch {
    // ignore missing binary
  }
  return '';
}

export function findAgyBinary() {
  const home = homedir();
  return findBinary(
    [process.env.AGY_BIN, join(home, '.local', 'bin', 'agy'), '/usr/local/bin/agy'],
    'agy',
  );
}

export function findSqliteBinary() {
  return findBinary(['/usr/bin/sqlite3', '/usr/sbin/sqlite3'], 'sqlite3');
}

function geminiRoot() {
  return join(homedir(), '.gemini');
}

export function snapshotAgyState() {
  const root = geminiRoot();
  const brains = {};
  const convs = {};
  for (const prod of AGY_PRODUCTS) {
    const pdir = join(root, prod);
    const bdir = join(pdir, 'brain');
    try {
      brains[prod] = new Set(existsSync(bdir) ? readdirSync(bdir) : []);
    } catch {
      brains[prod] = new Set();
    }
    const cdir = join(pdir, 'conversations');
    const cset = new Set();
    try {
      if (existsSync(cdir)) {
        for (const name of readdirSync(cdir)) {
          if (!name.endsWith('.db') && !name.endsWith('.pb')) continue;
          const stem = name.slice(0, -3);
          if (UUID_STEM_RE.test(stem)) cset.add(stem);
        }
      }
    } catch {
      // ignore
    }
    convs[prod] = cset;
  }
  return { brains, convs };
}

export function discoverNewWorkerCids(existing, ephemeralCid, sqliteBin) {
  const root = geminiRoot();
  const found = new Set();
  if (ephemeralCid && UUID_STEM_RE.test(ephemeralCid)) found.add(ephemeralCid);

  for (const prod of AGY_PRODUCTS) {
    const pdir = join(root, prod);
    const bdir = join(pdir, 'brain');
    if (existsSync(bdir)) {
      try {
        for (const nb of readdirSync(bdir)) {
          if (existing.brains[prod]?.has(nb) || !UUID_STEM_RE.test(nb)) continue;
          const tp = join(bdir, nb, '.system_generated', 'logs', 'transcript.jsonl');
          if (!existsSync(tp)) continue;
          const firstLine = readFileSync(tp, 'utf8').split('\n', 1)[0] || '';
          if (firstLine.includes(INTERNAL_MARKER)) found.add(nb);
        }
      } catch {
        // ignore
      }
    }
    if (sqliteBin) {
      const cdir = join(pdir, 'conversations');
      if (existsSync(cdir)) {
        try {
          for (const name of readdirSync(cdir)) {
            if (!name.endsWith('.db')) continue;
            const stem = name.slice(0, -3);
            if (!UUID_STEM_RE.test(stem) || existing.convs[prod]?.has(stem)) continue;
            try {
              const hex = execFileSync(
                sqliteBin,
                [`file:${join(cdir, name)}?mode=ro`, 'SELECT hex(step_payload) FROM steps WHERE idx = 0 LIMIT 1;'],
                { encoding: 'utf8', timeout: 1000 },
              ).trim();
              if (hex && Buffer.from(hex, 'hex').toString('utf8').includes(INTERNAL_MARKER)) {
                found.add(stem);
              }
            } catch {
              // ignore unreadable db
            }
          }
        } catch {
          // ignore
        }
      }
      const sumDb = join(pdir, 'conversation_summaries.db');
      if (existsSync(sumDb)) {
        try {
          const out = execFileSync(
            sqliteBin,
            [
              `file:${sumDb}?mode=ro`,
              `SELECT conversation_id FROM conversation_summaries WHERE preview LIKE '%${INTERNAL_MARKER}%';`,
            ],
            { encoding: 'utf8', timeout: 1000 },
          );
          for (const line of out.split('\n')) {
            const cstr = line.trim();
            if (UUID_STEM_RE.test(cstr) && !existing.convs[prod]?.has(cstr)) found.add(cstr);
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return [...found];
}

export function purgeEphemeralConversations(cids, sqliteBin) {
  const valid = cids.filter((c) => UUID_STEM_RE.test(c));
  if (!valid.length) return;
  const root = geminiRoot();
  for (const prod of AGY_PRODUCTS) {
    const pdir = join(root, prod);
    for (const ccid of valid) {
      try {
        rmSync(join(pdir, 'brain', ccid), { recursive: true, force: true });
      } catch {
        // ignore
      }
      for (const ext of ['.pb', '.db', '.db-wal', '.db-shm']) {
        try {
          unlinkSync(join(pdir, 'conversations', `${ccid}${ext}`));
        } catch {
          // ignore missing
        }
      }
      try {
        unlinkSync(join(pdir, 'presence', `${ccid}.lock`));
      } catch {
        // ignore missing
      }
    }
    const sumDb = join(pdir, 'conversation_summaries.db');
    if (sqliteBin && existsSync(sumDb)) {
      const quoted = valid.map((c) => `'${c}'`).join(',');
      const sql = [
        'PRAGMA busy_timeout = 3000;',
        `DELETE FROM conversation_summaries WHERE conversation_id IN (${quoted});`,
        `DELETE FROM conversations_fts WHERE conversation_id IN (${quoted});`,
        `DELETE FROM conversation_parents WHERE conversation_id IN (${quoted});`,
      ].join('\n');
      try {
        execFileSync(sqliteBin, [sumDb], { input: sql, timeout: 4000 });
      } catch {
        // FTS or parent tables may not exist in older schemas; best-effort per statement
        for (const tbl of ['conversation_summaries', 'conversations_fts', 'conversation_parents']) {
          try {
            execFileSync(
              sqliteBin,
              [sumDb, `PRAGMA busy_timeout=3000; DELETE FROM ${tbl} WHERE conversation_id IN (${quoted});`],
              { timeout: 2000 },
            );
          } catch {
            // ignore
          }
        }
      }
    }
  }
}

/**
 * Run a one-shot ephemeral `agy` print prompt in plan mode and purge all leaked artifacts.
 */
export function runEphemeralAgyPrompt({
  prompt,
  guard = '',
  model = DEFAULT_MODEL,
  logPrefix = 'agy-margin-worker',
  timeoutSec = 45,
}) {
  const agyBin = findAgyBinary();
  if (!agyBin) {
    return { ok: false, rawText: '', error: 'agy_not_found' };
  }

  const sqliteBin = findSqliteBinary();
  const existing = snapshotAgyState();
  const tmpLog = `/tmp/${logPrefix}-${process.pid}-${Date.now()}.log`;
  const printArg = guard ? `${INTERNAL_MARKER}\n${guard}\n\n${prompt}` : `${INTERNAL_MARKER}\n${prompt}`;

  let ephemeralCid = '';
  let rawText = '';
  let error = '';
  try {
    const stdout = execFileSync(
      agyBin,
      [
        '--mode',
        'plan',
        '--model',
        model,
        '--disable-slash-commands',
        '--log-file',
        tmpLog,
        '--print-timeout',
        `${timeoutSec}s`,
        '--output-format',
        'json',
        `--print=${printArg}`,
      ],
      {
        cwd: '/tmp',
        encoding: 'utf8',
        timeout: (timeoutSec + 10) * 1000,
        env: { ...process.env, AGY_HOOK_INTERNAL: '1', WSL_INTEROP: '1' },
      },
    );
    const trimmed = String(stdout ?? '').trim();
    if (trimmed) {
      try {
        const envelope = JSON.parse(trimmed);
        ephemeralCid = String(envelope?.conversation_id || envelope?.session_id || '').trim();
        rawText = String(envelope?.response ?? '').trim();
      } catch {
        rawText = trimmed;
      }
    }
  } catch (e) {
    rawText = '';
    error = e?.message || 'exec_failed';
  } finally {
    try {
      unlinkSync(tmpLog);
    } catch {
      // ignore missing log
    }
    try {
      const cleaned = discoverNewWorkerCids(existing, ephemeralCid, sqliteBin);
      purgeEphemeralConversations(cleaned, sqliteBin);
    } catch {
      // ignore cleanup failures
    }
  }

  return { ok: Boolean(rawText), rawText, error };
}
