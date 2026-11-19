// Locating conversation brain dirs, shared by the MCP server and the sidecar.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,64}$/i;

function safeReaddir(p) {
  try { return readdirSync(p); } catch { return []; }
}

/**
 * App data dirs to search. Under a language server the sidecar reads only the
 * dir it runs under (<appData>/sidecar_data/<plugin>/<sidecar>/data); the MCP
 * server and standalone runs search every ~/.gemini/<product> that has brain/.
 */
export function appDataDirs({ env = process.env, home = homedir() } = {}) {
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(home, '.gemini');
  return safeReaddir(root).sort().map((n) => join(root, n)).filter((d) => existsSync(join(d, 'brain')));
}

/** Absolute brain dir of a conversation, or null. Never builds a path from an unvalidated id. */
export function brainDirOf(conv, dirs = appDataDirs()) {
  if (typeof conv !== 'string' || !ID_RE.test(conv)) return null;
  for (const d of dirs) {
    const p = join(d, 'brain', conv);
    if (existsSync(p)) return p;
  }
  return null;
}

export const transcriptPath = (brain) => join(brain, '.system_generated', 'logs', 'transcript.jsonl');
export const intentPath = (brain) => join(brain, '.system_generated', 'margin', 'intent.json');
