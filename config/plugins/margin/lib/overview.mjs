// Combine transcript facts with the agent-reported intent into one payload.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDirs, brainDirOf, ID_RE, intentPath, transcriptPath } from './paths.mjs';
import { readIntent } from './intent.mjs';
import { readRows, summarize } from './transcript.mjs';

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

export function buildOverview(brain, now = Date.now()) {
  const facts = summarize(readRows(transcriptPath(brain)), now);
  const stored = readIntent(intentPath(brain));
  // Intent from an earlier user turn is stale: show only the ask, not an old plan.
  const fresh = stored && stored.userStep === facts.userStep ? stored : null;
  const steps = fresh?.steps ?? [];
  return {
    status: facts.status,
    ask: facts.ask,
    wants: fresh?.wants || '',
    take: fresh?.take ?? null,
    steps,
    done: steps.filter((s) => s.status === 'completed').length,
    verdict: fresh?.verdict || '',
    reported: Boolean(fresh),
    used: facts.used,
    files: facts.files,
    turnStartedAt: facts.turnStartedAt,
    lastStepAt: facts.lastStepAt,
    stepCount: facts.steps,
  };
}

/** Resolve conversation overview with ETag support for sidecar HTTP polling. */
export function resolveOverview({ conversationId = '', etag = '' } = {}, dirs = appDataDirs()) {
  const raw = String(conversationId ?? '');
  const conv = ID_RE.test(raw) && brainDirOf(raw, dirs) ? raw : newestConversation(dirs);
  const brain = brainDirOf(conv, dirs);
  if (!brain) return { conversationId: conv || null, overview: null };
  const overview = buildOverview(brain);
  const nextEtag = JSON.stringify(overview);
  if (etag && etag === nextEtag) return { conversationId: conv, unchanged: true, etag: nextEtag };
  return { conversationId: conv, overview, etag: nextEtag };
}
