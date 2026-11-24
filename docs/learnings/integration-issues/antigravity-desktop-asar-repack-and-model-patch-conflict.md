---
title: Antigravity Desktop ASAR Repacking Must Preserve Pickle Alignment and Coordinate With antigravity-model-patch Hashes
category: integration-issues
module: config/plugins/margin/bin/agy-overview-patch
tags: [asar, electron, chromium-pickle, antigravity, sha256, patching, margin]
problem_type: integration-issue
date: 2026-11-20
---

# Antigravity Desktop ASAR Repacking Must Preserve Pickle Alignment and Coordinate With `antigravity-model-patch` Hashes

## Context

Patching Antigravity Desktop's renderer preload (`/opt/Antigravity/resources/app.asar` -> `dist/preload.js`) without external npm dependencies requires writing a valid Chromium Pickle ASAR archive while accounting for existing third-party patches in `/opt/Antigravity/resources/.antigravity-model-patch/`.

## Guidance

1. **Follow exact Chromium Pickle header framing and unpacked entry rules (`config/plugins/margin/lib/asar.mjs`):**
   - Encode the 16-byte preamble as little-endian `uint32`: `[4, headerSize, headerPayloadSize, jsonLen]` where `pad = (4 - (jsonLen % 4)) % 4`, `headerPayloadSize = jsonLen + pad + 4`, `headerSize = headerPayloadSize + 4`, and packed file data begins at `dataOffset = 8 + headerSize`.
   - Recompute `{ algorithm: "SHA256", hash, blockSize: 4194304, blocks }` integrity metadata for replaced files and update sequential string `offset`s for all packed files while leaving `unpacked: true` (`347` entries in v2.32.1) and `link` entries untouched so `app.asar.unpacked` remains byte-for-byte valid.
2. **Respect `.antigravity-model-patch/state.json` SHA-256 locks (`bin/agy-overview-patch`):**
   - `vahapogut/antigravity-add-model` stores `original.archive` and `patched.archive` SHA-256 digests in `.antigravity-model-patch/state.json`.
   - Modifying `app.asar` underneath it causes `--restore` and `inspectForUpdate` to abort with `RESTORE_REFUSED`, and causes re-apply/`doctor` to abort with `UNSUPPORTED_RUNTIME` (skipping its clean backup and failing on its `/* antigravity-model-patch: vendor-runtime-v1 */` marker in `dist/preload.js`).
   - Refuse `check` and `apply` by default when `.antigravity-model-patch/state.json` or its preload marker is present (requiring user removal first or an explicit `--force`), store independent backups under `.agy-overview-patch/backups/`, and validate round-trip readback + `vm.Script` compilation on a temp file before atomic `renameSync`.

## Verification

- `node --test config/plugins/margin/tests/overview-patch.test.mjs` verifies Pickle 4-byte alignment across all 4 mod-4 header lengths (`0..3`), `executable`/`unpacked` preservation, conflict guards, and idempotent `apply`/`restore`.
- `~/.local/bin/agy-overview-patch check --force` against the real `/opt/Antigravity/resources/app.asar` passes round-trip verification (`CHECK PASSED (764 packed, 347 unpacked)`).

## References

0
