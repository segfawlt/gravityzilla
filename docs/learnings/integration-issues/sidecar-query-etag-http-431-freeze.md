---
title: Unbounded JSON ETag in sidecar GET polling overflows Node HTTP 431 and wedges live updates
category: integration-issues
module: config/plugins/margin/lib/overview.mjs
tags: [sidecar, http-431, etag, polling, compaction, margin, node-http]
problem_type: integration-issue
date: 2026-11-19
---

# Unbounded JSON ETag in Sidecar GET Polling Overflows Node HTTP 431 and Wedges Live Updates

## Problem

After multi-worker swarm turns or large tool fan-outs in `config/plugins/margin`, the Overview sidecar stopped updating live token/compaction counts (showing stale pre-compaction state indefinitely) and began showing transient `Reconnecting` errors.

Related margin sidecar integration notes: [Sidecar preload and --watch reload](./sidecar-preload-dark-mode-and-watch-reload.md).

## Symptoms

- `GET /api/overview?etag=...` returned `HTTP 431 Request Header Fields Too Large` once the turn payload exceeded Node's HTTP header limit.
- Even after conversation compaction (`CHECKPOINT`) reduced active context tokens back down to `~107k`, the already-open Overview pane remained frozen on stale pre-compaction state because every poll kept failing.

## What Didn't Work

- Relying on Node's `unchanged` short-circuit with raw `JSON.stringify(overview)` as the ETag string works in small unit tests (~200–5,000 bytes) but fails silently in production conversations with 5 swarm workers, where `usedDetails` file/shell item lists expand the serialized payload to `171,766` bytes (`256,487` bytes URL-encoded) against Node's default `16 KB` `maxHeaderSize`.
- Leaving `state.etag` untouched inside the `catch` handler of `pollSidecar()` kept re-sending the oversized `256 KB` query string forever.

## Solution

1. **Fixed-size hashed ETag (`config/plugins/margin/lib/overview.mjs`):**
   - Hash a normalized snapshot with SHA-1 truncated to 16 hex characters (`createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16)`).
   - Zero volatile millisecond counters (`watchdog.elapsedMs: 0`) before hashing so client 1s elapsed ticks or idle active-turn timers do not bust the ETag on every poll.
2. **Clear `state.etag` on poll failure (`config/plugins/margin/app/app.js`):**
   - Reset `state.etag = ''` in `catch` so transient request failures fall back cleanly to a full uncached fetch.
3. **Regression test (`config/plugins/margin/tests/margin.test.mjs`):**
   - Assert `/^[0-9a-f]{16}$/` on `resolveOverview().etag`.

## Why This Works

- A 16-char hex digest guarantees a constant `O(1)` query parameter footprint regardless of how many files or worker transcripts appear in `usedDetails`.
- Clearing `state.etag` on error breaks any retry deadlock if a request is ever rejected.

## Prevention

Never serialize full application payloads or unbounded lists into HTTP `GET` query parameters (`?etag=...`); hash to a compact fixed-length token and assert the token format in unit tests (`assert.match(etag, /^[0-9a-f]{16}$/)`). Always clear client cache validators in error recovery paths.

## References

0
