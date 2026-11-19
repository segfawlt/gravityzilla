---
title: Unguarded 1s render ticker overwrites async Reconnecting status at 1 Hz
category: logic-errors
module: config/plugins/margin/app/app.js
tags: [polling, state-machine, timer, ui-flicker, margin]
problem_type: logic-error
date: 2026-11-19
---

# Unguarded 1s Render Ticker Overwrites Async `Reconnecting` Status at 1 Hz

## Problem

When sidecar polling hit repeated errors (`HTTP 431` or connection drops), the Overview header flickered between `Reconnecting` and stale `Done` (or `Working`) every second instead of holding a steady connection state until recovery.

## Symptoms

- Header text visually flashed `Reconnecting` → `Done` → `Reconnecting` on a 1–2s cadence.
- Failing on the very first poll (when `state.lastOk === 0`) immediately satisfied `Date.now() - state.lastOk > 6000` instead of waiting for an established connection grace window.

## What Didn't Work

- Writing `$('status-text').textContent = 'Reconnecting'` directly inside `pollSidecar()` / `poll()` `catch` blocks without updating a shared state flag. Because a separate `setInterval(..., 1000)` loop unconditionally called `renderStatus(state.ov)` using the cached `state.ov`, the DOM mutation lasted at most 1 second before being overwritten.

## Solution

In `config/plugins/margin/app/app.js`:
1. Track connection degradation explicitly in `state.reconnecting`.
2. In poll `catch`, require an established prior success and elapsed grace window (`state.lastOk > 0 && Date.now() - state.lastOk > 12000`), then set `state.reconnecting = true` and render via `renderStatus({ ...(state.ov || {}), status: 'reconnecting' })` so both dot state and label stay synchronized.
3. Clear `state.reconnecting = false` on successful poll and re-render `renderStatus(state.ov)` even on `unchanged: true` responses so recovery restores the true status immediately.
4. Guard the 1s stopwatch ticker with `if (state.ov && !state.reconnecting)` so local elapsed updates pause status overwrites while disconnected.

## Why This Works

Single-source UI rendering via `state.reconnecting` + `renderStatus()` eliminates competing DOM writers between the slower network poll loop (5s) and the fast local stopwatch ticker (1s).

## Prevention

Never bypass the shared `render*()` pipeline with ad-hoc DOM `.textContent` writes from async error handlers when a periodic timer also renders that element; model transient transport errors as explicit state checked by the timer.

## References

0
