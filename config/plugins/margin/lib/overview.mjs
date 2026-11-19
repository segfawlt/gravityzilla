// Combine transcript facts with the agent-reported intent into one payload.
import { intentPath, transcriptPath } from './paths.mjs';
import { readIntent } from './intent.mjs';
import { readRows, summarize } from './transcript.mjs';

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
