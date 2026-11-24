// Zero-dependency ASAR archive reader and single-file repacker preserving unpacked entries.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs';

export const BLOCK_SIZE = 4 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;

function readAllSync(fd, buf, offset, length, position) {
  let total = 0;
  let pos = position;
  while (total < length) {
    const n = readSync(fd, buf, offset + total, length - total, pos);
    if (n === 0) throw new Error(`Unexpected EOF reading ASAR at byte ${pos}`);
    total += n;
    if (pos !== null) pos += n;
  }
}

function writeAllSync(fd, buf, length = buf.length) {
  let total = 0;
  while (total < length) {
    const n = writeSync(fd, buf, total, length - total);
    if (n <= 0) throw new Error('Short write while writing ASAR archive');
    total += n;
  }
}

/** Compute Electron ASAR SHA-256 file and 4 MiB block integrity metadata. */
export function computeIntegrity(buf) {
  const hash = createHash('sha256').update(buf).digest('hex');
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(hash);
  } else {
    for (let off = 0; off < buf.length; off += BLOCK_SIZE) {
      const end = Math.min(off + BLOCK_SIZE, buf.length);
      blocks.push(createHash('sha256').update(buf.subarray(off, end)).digest('hex'));
    }
  }
  return { algorithm: 'SHA256', hash, blockSize: BLOCK_SIZE, blocks };
}

/** Compute SHA-256 hex digest of a file on disk without buffering the whole file. */
export function sha256File(filePath) {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  const fd = openSync(filePath, 'r');
  try {
    let pos = 0;
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Parse Chromium Pickle preamble and JSON header from an ASAR archive. */
export function readAsarHeader(archivePath) {
  const size = statSync(archivePath).size;
  if (size < 16) throw new Error(`Invalid ASAR archive (too small: ${size} bytes): ${archivePath}`);

  const fd = openSync(archivePath, 'r');
  try {
    const preamble = Buffer.allocUnsafe(16);
    readAllSync(fd, preamble, 0, 16, 0);
    const u0 = preamble.readUInt32LE(0);
    const headerSize = preamble.readUInt32LE(4);
    const headerPayloadSize = preamble.readUInt32LE(8);
    const jsonLen = preamble.readUInt32LE(12);

    const dataOffset = 8 + headerSize;
    if (u0 !== 4 || headerSize < 8 || jsonLen === 0 || headerPayloadSize < jsonLen + 4 || dataOffset > size) {
      throw new Error(`Invalid ASAR Pickle header in ${archivePath}`);
    }

    const jsonBuf = Buffer.allocUnsafe(jsonLen);
    readAllSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    if (!header || typeof header !== 'object' || !header.files) {
      throw new Error(`Invalid ASAR directory tree in ${archivePath}`);
    }
    return { header, dataOffset, headerSize, jsonLen };
  } finally {
    closeSync(fd);
  }
}

/** Look up an entry by POSIX relative path (e.g. "dist/preload.js"). */
export function getEntry(header, posixPath) {
  const parts = String(posixPath).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let node = header;
  for (const seg of parts) {
    if (!node || !node.files || !Object.hasOwn(node.files, seg)) return null;
    node = node.files[seg];
  }
  return node;
}

/** Extract a single packed regular file from an ASAR archive as a Buffer. */
export function readAsarFile(archivePath, posixPath) {
  const { header, dataOffset } = readAsarHeader(archivePath);
  const entry = getEntry(header, posixPath);
  if (!entry) throw new Error(`Missing ASAR entry: ${posixPath}`);
  if (entry.files) throw new Error(`ASAR entry is a directory: ${posixPath}`);
  if (entry.link) throw new Error(`ASAR entry is a symlink: ${posixPath}`);
  if (entry.unpacked) throw new Error(`ASAR entry is unpacked: ${posixPath}`);

  const fileSize = Number(entry.size);
  const fileOffset = Number(entry.offset);
  if (!Number.isSafeInteger(fileSize) || fileSize < 0 || !Number.isSafeInteger(fileOffset) || fileOffset < 0) {
    throw new Error(`Invalid ASAR size/offset for ${posixPath}`);
  }

  const buf = Buffer.allocUnsafe(fileSize);
  const fd = openSync(archivePath, 'r');
  try {
    readAllSync(fd, buf, 0, fileSize, dataOffset + fileOffset);
  } finally {
    closeSync(fd);
  }
  return buf;
}

/** Encode an ASAR header using Chromium Pickle alignment (4-byte padded). */
export function encodeAsarHeader(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const paddedLen = jsonBuf.length + pad;
  const headerPayloadSize = paddedLen + 4;
  const headerSize = headerPayloadSize + 4;

  const out = Buffer.alloc(16 + paddedLen);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerSize, 4);
  out.writeUInt32LE(headerPayloadSize, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(out, 16);
  return { headerBuf: out, dataOffset: 8 + headerSize };
}

/**
 * Repack an ASAR archive with specific packed files replaced in memory while
 * copying all other packed payloads verbatim and leaving unpacked/link entries untouched.
 */
export function patchAsarFiles(srcArchivePath, destArchivePath, replacements) {
  const normalized = new Map();
  for (const [rawPath, buf] of replacements instanceof Map ? replacements : Object.entries(replacements)) {
    const rel = String(rawPath).replace(/^\/+|\/+$/g, '');
    if (!Buffer.isBuffer(buf)) throw new Error(`Replacement for ${rel} must be a Buffer`);
    normalized.set(rel, buf);
  }

  const { header, dataOffset } = readAsarHeader(srcArchivePath);
  const nextHeader = structuredClone(header);

  for (const rel of normalized.keys()) {
    const entry = getEntry(nextHeader, rel);
    if (!entry) throw new Error(`Cannot patch missing ASAR entry: ${rel}`);
    if (entry.files || entry.link || entry.unpacked) {
      throw new Error(`Cannot patch non-packed file entry: ${rel}`);
    }
  }

  const ops = [];
  let nextOffset = 0;
  let packedFiles = 0;
  let unpackedFiles = 0;

  function walk(dir, prefix) {
    for (const name of Object.keys(dir.files)) {
      const entry = dir.files[name];
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        walk(entry, rel);
      } else if (entry.unpacked || Object.hasOwn(entry, 'link')) {
        unpackedFiles += 1;
      } else if (normalized.has(rel)) {
        const buf = normalized.get(rel);
        entry.size = buf.length;
        entry.offset = String(nextOffset);
        entry.integrity = computeIntegrity(buf);
        ops.push({ kind: 'replace', buf });
        nextOffset += buf.length;
        packedFiles += 1;
      } else {
        const oldOffset = Number(entry.offset);
        const size = Number(entry.size);
        if (!Number.isSafeInteger(oldOffset) || oldOffset < 0 || !Number.isSafeInteger(size) || size < 0) {
          throw new Error(`Invalid ASAR offset/size for ${rel}`);
        }
        entry.offset = String(nextOffset);
        ops.push({ kind: 'copy', srcOffset: dataOffset + oldOffset, size });
        nextOffset += size;
        packedFiles += 1;
      }
    }
  }

  walk(nextHeader, '');
  const { headerBuf, dataOffset: nextDataOffset } = encodeAsarHeader(nextHeader);

  const srcFd = openSync(srcArchivePath, 'r');
  const destFd = openSync(destArchivePath, 'w');
  try {
    writeAllSync(destFd, headerBuf);
    const scratch = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (const op of ops) {
      if (op.kind === 'replace') {
        if (op.buf.length > 0) writeAllSync(destFd, op.buf);
        continue;
      }
      let remaining = op.size;
      let pos = op.srcOffset;
      while (remaining > 0) {
        const chunk = Math.min(remaining, scratch.length);
        readAllSync(srcFd, scratch, 0, chunk, pos);
        writeAllSync(destFd, scratch, chunk);
        pos += chunk;
        remaining -= chunk;
      }
    }
  } finally {
    closeSync(srcFd);
    closeSync(destFd);
  }

  return { header: nextHeader, dataOffset: nextDataOffset, packedFiles, unpackedFiles };
}
