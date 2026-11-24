#!/usr/bin/env node
// Unified reversible Antigravity Desktop ASAR patcher (hide-top-bar + auto-open Overview + model-search).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { getEntry, patchAsarFiles, readAsarFile, readAsarHeader, sha256File } from './lib/asar.mjs';
import { applyModelSearchPatchToSource, hasModelSearchPatch } from './lib/model-search.mjs';
import { applyOverviewPatchToSource, OVERVIEW_PATCH_END, OVERVIEW_PATCH_START } from './lib/overview.mjs';
import { applyTopBarPatchToSource, hasTopBarPatch } from './lib/top-bar.mjs';

const DEFAULT_RESOURCES = '/opt/Antigravity/resources';
const RESOURCE_CANDIDATES = [
  '/opt/Antigravity/resources',
  '/usr/lib/antigravity/resources',
  '/usr/share/antigravity/resources',
  join(homedir(), '.local', 'share', 'Antigravity', 'resources'),
];
const MAIN_ENTRY = 'dist/main.js';
const PRELOAD_ENTRY = 'dist/preload.js';
const STATE_DIR = '.agy-desktop-patch';
const VALID_PATCHES = ['top-bar', 'overview', 'model-search'];

export function detectDefaultResources() {
  for (const cand of RESOURCE_CANDIDATES) {
    if (existsSync(join(cand, 'app.asar'))) return cand;
  }
  return DEFAULT_RESOURCES;
}

function usage() {
  return [
    'Usage: agy-desktop-patch [apply|status|check|restore] [--resources PATH] [--only top-bar|overview|model-search] [--force]',
    '',
    'Commands (default: apply; auto-elevates with sudo when writing requires root):',
    '  apply     Back up app.asar and apply patches in one pass (default)',
    '  status    Inspect app.asar and show state of all patches',
    '  check     Dry-run patches and verify temp ASAR (no app changes)',
    '  restore   Restore the exact pre-patch app.asar backup',
    '',
    'Options:',
    '  --only <name>   Apply or check only "top-bar", "overview", or "model-search" (default: all)',
    '  --resources     Path to Antigravity resources dir (default: /opt/Antigravity/resources)',
    '  --force         Bypass external modification guard on restore',
  ].join('\n');
}

export function parseArgs(argv) {
  const args = [...argv];
  let command = null;
  let resources = detectDefaultResources();
  let force = false;
  let only = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg === '--force') {
      force = true;
    } else if (arg === '--resources') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) throw new Error('Missing path after --resources');
      resources = resolve(next);
      i += 1;
    } else if (arg === '--only') {
      const next = args[i + 1];
      if (!next || !VALID_PATCHES.includes(next)) {
        throw new Error(`Invalid --only value: ${next || '(missing)'}. Expected: ${VALID_PATCHES.join(', ')}`);
      }
      only = next;
      i += 1;
    } else if (!arg.startsWith('-') && !command) {
      command = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const resolvedCommand = command || 'apply';
  if (!['status', 'check', 'apply', 'restore'].includes(resolvedCommand)) {
    throw new Error(`Unknown command: ${resolvedCommand}`);
  }
  const patches = only ? [only] : [...VALID_PATCHES];
  return { help: false, command: resolvedCommand, resources, force, patches };
}

function countTreeFiles(node) {
  let packed = 0;
  let unpacked = 0;
  for (const name of Object.keys(node.files || {})) {
    const entry = node.files[name];
    if (entry.files) {
      const sub = countTreeFiles(entry);
      packed += sub.packed;
      unpacked += sub.unpacked;
    } else if (entry.unpacked || Object.hasOwn(entry, 'link')) {
      unpacked += 1;
    } else {
      packed += 1;
    }
  }
  return { packed, unpacked };
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeAtomic(filePath, text) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, filePath);
}

function assertNotSymlink(filePath, label) {
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing symlinked ${label}: ${filePath}`);
  }
}

function isAntigravityRunning(resources = DEFAULT_RESOURCES) {
  const binPath = join(dirname(resources), 'antigravity');
  const patterns = existsSync(binPath) ? [binPath, '/[Aa]ntigravity/antigravity'] : ['/[Aa]ntigravity/antigravity'];
  for (const pat of patterns) {
    try {
      execFileSync('pgrep', ['-f', pat], { stdio: 'ignore' });
      return true;
    } catch {
      // try next pattern
    }
  }
  return false;
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function buildReplacements(srcArchive, patches) {
  const replacements = new Map();

  if (patches.includes('top-bar')) {
    const mainSource = readAsarFile(srcArchive, MAIN_ENTRY).toString('utf8');
    const patchedMain = applyTopBarPatchToSource(mainSource);
    new Script(patchedMain, { filename: MAIN_ENTRY });
    replacements.set(MAIN_ENTRY, Buffer.from(patchedMain, 'utf8'));
  }

  if (patches.includes('overview') || patches.includes('model-search')) {
    let preloadText = readAsarFile(srcArchive, PRELOAD_ENTRY).toString('utf8');
    if (patches.includes('overview')) {
      preloadText = applyOverviewPatchToSource(preloadText);
    }
    if (patches.includes('model-search')) {
      preloadText = applyModelSearchPatchToSource(preloadText);
    }
    new Script(preloadText, { filename: PRELOAD_ENTRY });
    replacements.set(PRELOAD_ENTRY, Buffer.from(preloadText, 'utf8'));
  }

  return replacements;
}

function validateAndPackTemp(srcArchive, tmpArchive, patches) {
  const replacements = buildReplacements(srcArchive, patches);
  const srcCounts = countTreeFiles(readAsarHeader(srcArchive).header);
  const packResult = patchAsarFiles(srcArchive, tmpArchive, replacements);

  // Round-trip verification on the packed archive before any swap.
  const verifyHeader = readAsarHeader(tmpArchive).header;
  const verifyCounts = countTreeFiles(verifyHeader);
  if (verifyCounts.unpacked !== srcCounts.unpacked || verifyCounts.packed !== srcCounts.packed) {
    throw new Error(
      `ASAR entry count mismatch: expected ${srcCounts.packed} packed / ${srcCounts.unpacked} unpacked, ` +
        `got ${verifyCounts.packed} packed / ${verifyCounts.unpacked} unpacked`,
    );
  }

  for (const [entryPath, expectedBuf] of replacements.entries()) {
    const readBackBuf = readAsarFile(tmpArchive, entryPath);
    if (!readBackBuf.equals(expectedBuf)) {
      throw new Error(`Round-trip readback of ${entryPath} did not match patched bytes`);
    }
    const verifyEntry = getEntry(verifyHeader, entryPath);
    const expectedHash = sha256Buffer(expectedBuf);
    if (!verifyEntry?.integrity?.hash || verifyEntry.integrity.hash !== expectedHash) {
      throw new Error(`Round-trip integrity hash mismatch on ${entryPath}`);
    }
    new Script(readBackBuf.toString('utf8'), { filename: entryPath });
  }

  return { packResult, verifyCounts };
}

function formatStatus({ resources, currentSha, state, mainText, preloadText }) {
  const topBarActive = hasTopBarPatch(mainText);
  const overviewActive = preloadText.includes(OVERVIEW_PATCH_START) && preloadText.includes(OVERVIEW_PATCH_END);
  const modelSearchActive = hasModelSearchPatch(preloadText);
  const lines = [
    `Resources:              ${resources}`,
    `app.asar SHA-256:       ${currentSha}`,
    `Patch 1 (top-bar):      ${topBarActive ? 'installed' : 'not installed'}`,
    `Patch 2 (overview):     ${overviewActive ? 'installed' : 'not installed'}`,
    `Patch 3 (model-search): ${modelSearchActive ? 'installed' : 'not installed'}`,
  ];
  if (state) {
    const externalChange = state.patchedSha256 !== currentSha;
    lines.push(`State:                  ${externalChange ? 'app.asar changed externally since patching' : 'clean'}`);
    if (state.backupFile) {
      lines.push(`Backup file:            ${state.backupFile} (${existsSync(state.backupFile) ? 'ok' : 'missing'})`);
    }
  }
  return lines.join('\n');
}

export function runCommand(parsed, io = { log: console.log, error: console.error }) {
  const { command, resources, force, patches } = parsed;
  const archivePath = join(resources, 'app.asar');
  if (!existsSync(archivePath)) {
    throw new Error(`Missing app.asar at ${archivePath}`);
  }
  assertNotSymlink(archivePath, 'app.asar');

  const stateDir = join(resources, STATE_DIR);
  const statePath = join(stateDir, 'state.json');
  const backupsDir = join(stateDir, 'backups');
  const currentSha = sha256File(archivePath);
  const state = readJsonIfExists(statePath);

  if (command === 'status') {
    const mainText = readAsarFile(archivePath, MAIN_ENTRY).toString('utf8');
    const preloadText = readAsarFile(archivePath, PRELOAD_ENTRY).toString('utf8');
    io.log(formatStatus({ resources, currentSha, state, mainText, preloadText }));
    return 0;
  }

  if (command === 'check') {
    const tmpArchive = join(tmpdir(), `agy-desktop-check-${process.pid}.asar`);
    try {
      const { verifyCounts } = validateAndPackTemp(archivePath, tmpArchive, patches);
      const patchedSha = sha256File(tmpArchive);
      io.log(
        `CHECK PASSED [${patches.join(', ')}] (${verifyCounts.packed} packed, ${verifyCounts.unpacked} unpacked; candidate SHA-256 ${patchedSha.slice(0, 12)})`,
      );
    } finally {
      rmSync(tmpArchive, { force: true });
    }
    return 0;
  }

  if (command === 'apply') {
    let sourceArchive = archivePath;
    let originalSha256 = currentSha;
    let backupFile = join(backupsDir, `app-${currentSha.slice(0, 12)}.asar`);

    if (state && state.patchedSha256 === currentSha) {
      if (!state.backupFile || !existsSync(state.backupFile)) {
        throw new Error(`Cannot re-apply: backup missing at ${state.backupFile}`);
      }
      if (sha256File(state.backupFile) !== state.originalSha256) {
        throw new Error(`Backup checksum mismatch at ${state.backupFile}`);
      }
      sourceArchive = state.backupFile;
      originalSha256 = state.originalSha256;
      backupFile = state.backupFile;
    }

    mkdirSync(backupsDir, { recursive: true });
    if (!existsSync(backupFile)) {
      const tmpBackup = `${backupFile}.tmp.${process.pid}`;
      try {
        copyFileSync(sourceArchive, tmpBackup);
        if (sha256File(tmpBackup) !== originalSha256) {
          throw new Error('Prepared backup failed SHA-256 verification');
        }
        renameSync(tmpBackup, backupFile);
      } finally {
        rmSync(tmpBackup, { force: true });
      }
    } else if (sha256File(backupFile) !== originalSha256) {
      throw new Error(`Existing backup failed SHA-256 verification: ${backupFile}`);
    }

    const tmpArchive = join(stateDir, `app.asar.tmp.${process.pid}`);
    try {
      const { verifyCounts } = validateAndPackTemp(sourceArchive, tmpArchive, patches);
      const mode = statSync(archivePath).mode & 0o777;
      chmodSync(tmpArchive, mode || 0o644);
      const patchedSha256 = sha256File(tmpArchive);
      renameSync(tmpArchive, archivePath);
      writeAtomic(
        statePath,
        JSON.stringify(
          {
            schema: 1,
            patches,
            originalSha256,
            patchedSha256,
            backupFile,
            appliedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      io.log(
        `PATCH APPLIED [${patches.join(', ')}] (${verifyCounts.packed} packed, ${verifyCounts.unpacked} unpacked; SHA-256 ${patchedSha256.slice(0, 12)})`,
      );
      io.log(`Backup: ${backupFile}`);
      if (isAntigravityRunning(resources)) {
        io.log('Antigravity Desktop is running: close and reopen it for patches to take effect.');
      }
    } finally {
      rmSync(tmpArchive, { force: true });
    }
    return 0;
  }

  if (command === 'restore') {
    if (!state) {
      throw new Error(`Nothing to restore: missing ${statePath}`);
    }
    if (!state.backupFile || !existsSync(state.backupFile)) {
      throw new Error(`Missing backup archive: ${state.backupFile}`);
    }
    const backupSha = sha256File(state.backupFile);
    if (backupSha !== state.originalSha256) {
      throw new Error(`Backup checksum mismatch at ${state.backupFile}`);
    }
    if (currentSha !== state.patchedSha256 && !force) {
      throw new Error(
        `Refusing restore: ${archivePath} changed externally since patching. Pass --force to restore anyway.`,
      );
    }

    const tmpRestore = join(stateDir, `app.restore.tmp.${process.pid}`);
    try {
      copyFileSync(state.backupFile, tmpRestore);
      const mode = statSync(archivePath).mode & 0o777;
      chmodSync(tmpRestore, mode || 0o644);
      if (sha256File(tmpRestore) !== state.originalSha256) {
        throw new Error('Staged restore archive failed SHA-256 verification');
      }
      renameSync(tmpRestore, archivePath);
      if (sha256File(archivePath) !== state.originalSha256) {
        throw new Error('Restored app.asar failed final SHA-256 verification');
      }
      rmSync(statePath, { force: true });
      io.log(`RESTORED original app.asar (SHA-256 ${state.originalSha256.slice(0, 12)})`);
      if (isAntigravityRunning(resources)) {
        io.log('Antigravity Desktop is running: close and reopen it to load the restored archive.');
      }
    } finally {
      rmSync(tmpRestore, { force: true });
    }
    return 0;
  }

  return 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

function needsSudoElevation(parsed) {
  if (parsed.command !== 'apply' && parsed.command !== 'restore') return false;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return false;
  if (process.env.AGY_PATCH_NO_SUDO === '1') return false;
  try {
    accessSync(parsed.resources, fsConstants.W_OK);
    const archivePath = join(parsed.resources, 'app.asar');
    if (existsSync(archivePath)) {
      accessSync(archivePath, fsConstants.W_OK);
    }
    return false;
  } catch (err) {
    return err?.code === 'EACCES' || err?.code === 'EPERM';
  }
}

if (isMain()) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
      process.exit(0);
    }
    if (needsSudoElevation(parsed)) {
      const scriptPath = realpathSync(fileURLToPath(import.meta.url));
      const res = spawnSync('sudo', ['--', process.execPath, scriptPath, ...process.argv.slice(2)], {
        stdio: 'inherit',
      });
      if (res.error) {
        console.error(`Error: Failed to elevate with sudo (${res.error.message}).`);
        process.exit(1);
      }
      process.exit(res.status ?? 1);
    }
    process.exit(runCommand(parsed));
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      console.error(`Permission denied (${err.path || DEFAULT_RESOURCES}). Re-run with sudo.`);
    } else {
      console.error(`Error: ${err?.message || String(err)}`);
    }
    process.exit(1);
  }
}
