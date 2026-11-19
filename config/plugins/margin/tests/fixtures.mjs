import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONV = '0a1b2c3d-1111-4222-8333-444455556666';

export const user = (i, text, at) => ({ step_index: i, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: at, content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>noise</ADDITIONAL_METADATA>` });
export const planner = (i, calls, at, status = 'DONE') => ({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status, created_at: at, tool_calls: calls.map(([name, args]) => ({ name, args })) });
export const generic = (i, at, status = 'DONE') => ({ step_index: i, source: 'MODEL', type: 'GENERIC', status, created_at: at, content: 'tool output' });

/** Make <home>/.gemini/antigravity/brain/<conv> with the given transcript rows. */
export function makeBrain(home, rows, conv = CONV) {
  const brain = join(home, '.gemini', 'antigravity', 'brain', conv);
  const logs = join(brain, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'transcript.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { brain, dirs: [join(home, '.gemini', 'antigravity')] };
}
