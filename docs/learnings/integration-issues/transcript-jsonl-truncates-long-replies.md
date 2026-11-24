---
title: "Compact transcript.jsonl truncates long reply middles; fall back to transcript_full.jsonl"
category: integration-issues
module: config/plugins/margin/lib/outcome.mjs
tags: [transcript, truncation, margin, outcome, antigravity]
problem_type: integration-issue
date: 2026-11-20
---

# Compact `transcript.jsonl` Truncates Long Reply Middles; Fall Back to `transcript_full.jsonl`

## Problem

End-of-turn classifiers and text parsers reading `.system_generated/logs/transcript.jsonl` silently miss sections sitting in the middle of long `PLANNER_RESPONSE` replies (such as `**Not covered:**`, inline caveats, or secondary findings).

Related transcript-reading nuances: [agy CLI context_window stdin and transcript bugs](../logic-errors/agy-context-window-stdin-and-transcript-bugs.md).

## Symptoms

- In live Antigravity sessions, long assistant replies in `transcript.jsonl` retain only their head and tail while replacing middle content, accompanied by `truncated_fields: ["content", ...]` on the JSON row (for example, a 5,124-byte reply shrunk to 4,106 bytes in `transcript.jsonl`, while `transcript_full.jsonl` kept all 5,124 bytes).
- Parsers scanning `transcript.jsonl` saw `**TL;DR**` and `**Next:**` at the edges while missing mid-reply `**Not covered:**` lists.

## What Didn't Work

- Reading only `transcript.jsonl` via `readRows()` and assuming `lastReplyRow.content` holds the full final response.
- Switching all high-frequency polling readers unconditionally to `transcript_full.jsonl`, which increases I/O on large sessions even when replies are short.

## Solution

Inspect `row.truncated_fields` on the target `PLANNER_RESPONSE` row in `transcript.jsonl` and fall back to `.system_generated/logs/transcript_full.jsonl` only when `'content'` is listed as truncated:

```js
const truncated = Array.isArray(lastReplyRow.truncated_fields) && lastReplyRow.truncated_fields.includes('content');
if (truncated && brain) {
  const fullPath = transcriptFullPath(brain);
  if (existsSync(fullPath)) {
    const match = readRows(fullPath).find(
      (r) => r?.type === 'PLANNER_RESPONSE' && typeof r.step_index === 'number' && r.step_index === lastReplyRow.step_index,
    );
    if (match && typeof match.content === 'string' && match.content.trim()) {
      return match.content;
    }
  }
}
```

## Why This Works

Antigravity writes compact summaries to `transcript.jsonl` (setting `truncated_fields` whenever it trims large fields) and preserves untruncated payloads in `transcript_full.jsonl`. Checking `truncated_fields.includes('content')` keeps common fast-path polling cheap while guaranteeing lossless text extraction for long replies before heuristic parsing or LLM classification.

## Prevention

In `config/plugins/margin/tests/margin.test.mjs`, keep a regression fixture with `truncated_fields: ['content']` on the compact `transcript.jsonl` row and full `**Not covered:**` bullets in `transcript_full.jsonl`, asserting `extractTurnExecution()` recovers every mid-reply bullet.

## References

0
