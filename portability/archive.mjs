/** Finance portability v1. Browser/Worker/Node compatible; deliberately no ZIP extraction or compression. */
export const MAX_ARCHIVE_BYTES = 20_000_000;
export const MAX_RECORDS = 50_000;
const MAX_MANIFEST_BYTES = 128_000;
const ENTRIES = ['manifest.json', 'data.json'];
const CORE = ['accounts', 'movements', 'snapshots', 'transfers', 'settlements'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = (message) => {
  throw new Error(`Invalid finance archive: ${message}`);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const safeKeys = (value, keys, name) => {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)))
    fail(`${name} fields`);
};
const text = (value, max = 512) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const day = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const timestamp = (value) => {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  return (
    !!parts &&
    day(parts[1]) &&
    Number(parts[2]) < 24 &&
    Number(parts[3]) < 60 &&
    Number(parts[4]) < 60 &&
    (parts[5] === 'Z' ||
      (Number(parts[5].slice(1, 3)) < 24 && Number(parts[5].slice(4, 6)) < 60)) &&
    Number.isFinite(Date.parse(value))
  );
};
const money = (value) => Number.isSafeInteger(value);

function checkJson(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 32 || ++budget.nodes > 1_000_000) fail('JSON complexity limit');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite number');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 2_000_000) fail('text limit');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_RECORDS) fail('array record limit');
    for (const child of value) checkJson(child, depth + 1, budget);
    return;
  }
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail('JSON value');
  if (Object.keys(value).length > MAX_RECORDS) fail('object record limit');
  for (const key of Object.keys(value)) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      key.length > 500 ||
      /[\u0000-\u001f]/.test(key)
    )
      fail('unsafe JSON key');
    checkJson(value[key], depth + 1, budget);
  }
}

export function canonicalStringify(value) {
  checkJson(value);
  const encode = (item) =>
    item === null || typeof item !== 'object'
      ? JSON.stringify(item)
      : Array.isArray(item)
        ? `[${item.map(encode).join(',')}]`
        : `{${Object.keys(item)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
            .join(',')}}`;
  return encode(value);
}

export async function hashValue(value) {
  const bytes = encoder.encode(canonicalStringify(value));
  return sha256(bytes);
}
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
const count = (value) => (Array.isArray(value) ? value.length : Object.keys(value).length);

/** Validate common records and every link before a destination maps any IDs. Native datasets remain opaque JSON. */
export function validateDatasets(datasets) {
  checkJson(datasets);
  if (!object(datasets) || Object.keys(datasets).length > 64) fail('dataset map');
  for (const [name, value] of Object.entries(datasets)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,99}$/.test(name) || (!Array.isArray(value) && !object(value)))
      fail('dataset name or collection');
  }
  for (const key of CORE) if (!Array.isArray(datasets[key])) fail(`${key} collection is required`);
  if (CORE.reduce((total, key) => total + datasets[key].length, 0) > MAX_RECORDS)
    fail('total core record limit');
  const index = (name) => {
    const result = new Map();
    for (const row of datasets[name]) {
      if (!object(row) || !text(row.id, 512) || result.has(row.id)) fail(`${name} unique ID`);
      if (own(row, 'ownerId') || own(row, 'userId') || own(row, 'user_id') || own(row, 'owner_id'))
        fail(`${name} must not contain ownership`);
      result.set(row.id, row);
    }
    return result;
  };
  const accounts = index('accounts'),
    movements = index('movements');
  index('snapshots');
  index('transfers');
  index('settlements');
  for (const row of accounts.values()) {
    if (
      !text(row.label, 160) ||
      !text(row.provider, 160) ||
      !/^[A-Z]{3}$/.test(row.currency) ||
      typeof row.includeInCash !== 'boolean' ||
      !timestamp(row.createdAt)
    )
      fail('account schema');
  }
  const sourceIdentities = new Set();
  for (const row of movements.values()) {
    if (
      (row.accountId !== null && !accounts.has(row.accountId)) ||
      !['in', 'out', 'internal'].includes(row.direction) ||
      !['confirmed', 'review', 'hold', 'transfer', 'duplicate', 'excluded'].includes(row.status) ||
      !integer(row.amountMinor) ||
      !integer(row.feeMinor) ||
      !integer(row.taxMinor ?? 0) ||
      !Number.isSafeInteger(row.amountMinor + row.feeMinor + (row.taxMinor ?? 0)) ||
      row.amountMinor + row.feeMinor + (row.taxMinor ?? 0) <= 0 ||
      !/^[A-Z]{3}$/.test(row.currency) ||
      !day(row.date) ||
      (row.occurredAt !== null && !timestamp(row.occurredAt)) ||
      typeof row.description !== 'string' ||
      row.description.length > 10_000 ||
      typeof row.category !== 'string' ||
      row.category.length > 120 ||
      !text(row.sourceId) ||
      !['bank', 'transaction', 'manual'].includes(row.sourceKind) ||
      !text(row.sourceFingerprint) ||
      ![null, 'refund', 'loan'].includes(row.legacyClassification) ||
      (![undefined, null].includes(row.reportedBalanceMinor) && !money(row.reportedBalanceMinor)) ||
      (![undefined, null].includes(row.reportedBalanceBeforeMinor) &&
        !money(row.reportedBalanceBeforeMinor))
    )
      fail('movement schema or account reference');
    if (row.accountId && accounts.get(row.accountId).currency !== row.currency)
      fail('account currency mismatch');
    if (row.status !== 'duplicate') {
      const key = JSON.stringify([row.sourceKind, row.sourceId]);
      if (sourceIdentities.has(key)) fail('duplicate source identity');
      sourceIdentities.add(key);
    }
  }
  const reference = (ref) => {
    const row = object(ref) ? movements.get(ref.movementId) : undefined;
    if (!row || row.sourceFingerprint !== ref.sourceFingerprint)
      fail('missing or changed movement reference');
    return row;
  };
  for (const row of datasets.snapshots) {
    if (
      !accounts.has(row.accountId) ||
      !money(row.balanceMinor) ||
      !timestamp(row.occurredAt) ||
      !text(row.sourceId)
    )
      fail('snapshot schema');
    if (row.sourceMovementId !== null) {
      const source = movements.get(row.sourceMovementId);
      if (
        !source ||
        source.accountId !== row.accountId ||
        row.sourceFingerprint !== source.sourceFingerprint ||
        row.sourceId !== source.sourceId ||
        source.occurredAt === null ||
        Date.parse(row.occurredAt) !== Date.parse(source.occurredAt)
      )
        fail('snapshot source reference');
      if (source.reportedBalanceMinor != null && source.reportedBalanceMinor !== row.balanceMinor)
        fail('snapshot balance mismatch');
    }
  }
  const reserved = new Set();
  const reserve = (row) => {
    if (reserved.has(row.id)) fail('movement linked more than once');
    reserved.add(row.id);
  };
  for (const row of datasets.transfers) {
    const outgoing = reference(row.outgoing),
      incoming = reference(row.incoming);
    if (
      !timestamp(row.createdAt) ||
      outgoing.id === incoming.id ||
      outgoing.direction !== 'out' ||
      incoming.direction !== 'in' ||
      !outgoing.accountId ||
      !incoming.accountId ||
      outgoing.accountId === incoming.accountId ||
      outgoing.currency !== incoming.currency ||
      outgoing.amountMinor <= 0 ||
      outgoing.amountMinor !== incoming.amountMinor ||
      outgoing.status !== 'transfer' ||
      incoming.status !== 'transfer'
    )
      fail('transfer legs');
    reserve(outgoing);
    reserve(incoming);
  }
  for (const row of datasets.settlements) {
    const original = reference(row.original);
    if (
      !['refund', 'loan'].includes(row.kind) ||
      !timestamp(row.createdAt) ||
      !Array.isArray(row.returns) ||
      row.returns.length > 100 ||
      (row.kind === 'refund' && !row.returns.length) ||
      original.direction !== 'out' ||
      original.status !== 'confirmed' ||
      original.legacyClassification !== null ||
      original.amountMinor <= 0
    )
      fail('settlement schema');
    reserve(original);
    let total = 0;
    for (const ref of row.returns) {
      const incoming = reference(ref);
      if (
        incoming.direction !== 'in' ||
        incoming.status !== 'confirmed' ||
        incoming.legacyClassification !== null ||
        incoming.currency !== original.currency ||
        !integer(ref.principalMinor, 1) ||
        ref.principalMinor > incoming.amountMinor ||
        incoming.date < original.date ||
        (incoming.occurredAt &&
          original.occurredAt &&
          Date.parse(incoming.occurredAt) < Date.parse(original.occurredAt))
      )
        fail('settlement return');
      reserve(incoming);
      total += ref.principalMinor;
      if (!Number.isSafeInteger(total) || total > original.amountMinor)
        fail('settlement allocation');
    }
  }
  return datasets;
}

function validateManifest(manifest) {
  checkJson(manifest);
  safeKeys(
    manifest,
    [
      'format',
      'version',
      'sourceApp',
      'namespace',
      'exportedAt',
      'timezone',
      'currency',
      'counts',
      'checksums',
      'coverage',
    ],
    'manifest',
  );
  if (
    manifest.format !== 'finance-portability' ||
    manifest.version !== 1 ||
    !['money-tracker', 'alfred'].includes(manifest.sourceApp) ||
    !text(manifest.namespace, 200) ||
    !/^[A-Za-z0-9:._-]+$/.test(manifest.namespace) ||
    !timestamp(manifest.exportedAt) ||
    !text(manifest.timezone, 100) ||
    !/^[A-Z]{3}$/.test(manifest.currency) ||
    !object(manifest.counts) ||
    !object(manifest.checksums) ||
    !Array.isArray(manifest.coverage) ||
    manifest.coverage.length > 128
  )
    fail('manifest schema or version');
  try {
    new Intl.DateTimeFormat('en', { timeZone: manifest.timezone });
  } catch {
    fail('timezone');
  }
  for (const row of manifest.coverage) {
    safeKeys(row, ['dataset', 'status', 'reason', 'count'], 'coverage');
    if (
      !text(row.dataset, 100) ||
      !['supported', 'preserved', 'excluded', 'unavailable'].includes(row.status) ||
      !text(row.reason, 2000) ||
      (own(row, 'count') && !integer(row.count))
    )
      fail('coverage schema');
  }
}

// CRC guards transport corruption; SHA-256 dataset hashes are in the manifest. Neither authenticates the sender.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const files = entries.map(([name, bytes]) => ({
    name: encoder.encode(name),
    bytes,
    crc: crc32(bytes),
    offset: 0,
  }));
  const size = files.reduce(
    (sum, file) => sum + 30 + 46 + file.name.length * 2 + file.bytes.length,
    22,
  );
  if (size > MAX_ARCHIVE_BYTES) fail('archive byte limit');
  const output = new Uint8Array(size),
    view = new DataView(output.buffer);
  let offset = 0;
  for (const file of files) {
    file.offset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 12, 0x21, true); // deterministic DOS date: 1980-01-01
    view.setUint32(offset + 14, file.crc, true);
    view.setUint32(offset + 18, file.bytes.length, true);
    view.setUint32(offset + 22, file.bytes.length, true);
    view.setUint16(offset + 26, file.name.length, true);
    output.set(file.name, offset + 30);
    output.set(file.bytes, offset + 30 + file.name.length);
    offset += 30 + file.name.length + file.bytes.length;
  }
  const centralStart = offset;
  for (const file of files) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 14, 0x21, true);
    view.setUint32(offset + 16, file.crc, true);
    view.setUint32(offset + 20, file.bytes.length, true);
    view.setUint32(offset + 24, file.bytes.length, true);
    view.setUint16(offset + 28, file.name.length, true);
    view.setUint32(offset + 42, file.offset, true);
    output.set(file.name, offset + 46);
    offset += 46 + file.name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, files.length, true);
  view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  return output;
}

function unzip(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    else fail('expected ZIP bytes');
  }
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE_BYTES) fail('archive byte limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    end = bytes.length - 22;
  const bounds = (offset, size) => {
    if (offset < 0 || size < 0 || offset + size > bytes.length) fail('truncated ZIP');
  };
  const u16 = (offset) => {
    bounds(offset, 2);
    return view.getUint16(offset, true);
  };
  const u32 = (offset) => {
    bounds(offset, 4);
    return view.getUint32(offset, true);
  };
  if (
    u32(end) !== 0x06054b50 ||
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== 2 ||
    u16(end + 10) !== 2 ||
    u16(end + 20)
  )
    fail('ZIP directory, entries or comment');
  const centralSize = u32(end + 12),
    centralStart = u32(end + 16);
  if (centralStart + centralSize !== end) fail('ZIP directory bounds');
  const output = Object.create(null);
  let at = centralStart,
    localAt = 0,
    total = 0;
  for (let i = 0; i < 2; i++) {
    bounds(at, 46);
    if (
      u32(at) !== 0x02014b50 ||
      u16(at + 8) ||
      u16(at + 10) ||
      u16(at + 30) ||
      u16(at + 32) ||
      u16(at + 34) ||
      u32(at + 38)
    )
      fail('ZIP compression, encryption, extras or attributes are unsupported');
    const length = u32(at + 24),
      compressed = u32(at + 20),
      nameLength = u16(at + 28),
      offset = u32(at + 42),
      crc = u32(at + 16);
    bounds(at + 46, nameLength);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name !== ENTRIES[i] || own(output, name) || compressed !== length || offset !== localAt)
      fail('ZIP entry name, traversal, duplicate or size');
    if (name === 'manifest.json' && length > MAX_MANIFEST_BYTES) fail('manifest byte limit');
    total += length;
    if (
      total > MAX_ARCHIVE_BYTES ||
      u32(offset) !== 0x04034b50 ||
      u16(offset + 6) ||
      u16(offset + 8) ||
      u32(offset + 14) !== crc ||
      u32(offset + 18) !== length ||
      u32(offset + 22) !== length ||
      u16(offset + 26) !== nameLength ||
      u16(offset + 28)
    )
      fail('ZIP local header or decompression limit');
    bounds(offset + 30, nameLength + length);
    if (decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)) !== name)
      fail('ZIP header name mismatch');
    const content = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + length);
    if (crc32(content) !== crc) fail('ZIP checksum');
    output[name] = content;
    localAt = offset + 30 + nameLength + length;
    at += 46 + nameLength;
  }
  if (at !== end || localAt !== centralStart) fail('ZIP overlap or extra bytes');
  return output;
}

export async function createArchive({
  sourceApp,
  namespace,
  timezone,
  currency,
  datasets,
  coverage,
  exportedAt = new Date().toISOString(),
}) {
  validateDatasets(datasets);
  const counts = {},
    checksums = {};
  for (const [name, value] of Object.entries(datasets)) {
    counts[name] = count(value);
    checksums[name] = await hashValue(value);
  }
  const manifest = {
    format: 'finance-portability',
    version: 1,
    sourceApp,
    namespace,
    timezone,
    currency,
    exportedAt,
    counts,
    checksums,
    coverage,
  };
  validateManifest(manifest);
  const manifestBytes = encoder.encode(canonicalStringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST_BYTES) fail('manifest byte limit');
  return zip([
    ['manifest.json', manifestBytes],
    ['data.json', encoder.encode(canonicalStringify({ datasets }))],
  ]);
}

export async function readArchive(bytes) {
  try {
    const entries = unzip(bytes),
      manifestText = decoder.decode(entries['manifest.json']),
      dataText = decoder.decode(entries['data.json']);
    const manifest = JSON.parse(manifestText),
      payload = JSON.parse(dataText);
    // Canonical JSON disallows ambiguous duplicate keys, alternate encodings and duplicate identity interpretations.
    if (canonicalStringify(manifest) !== manifestText || canonicalStringify(payload) !== dataText)
      fail('JSON must be canonical');
    validateManifest(manifest);
    safeKeys(payload, ['datasets'], 'payload');
    validateDatasets(payload.datasets);
    const names = Object.keys(payload.datasets).sort();
    if (
      canonicalStringify(Object.keys(manifest.counts).sort()) !== canonicalStringify(names) ||
      canonicalStringify(Object.keys(manifest.checksums).sort()) !== canonicalStringify(names)
    )
      fail('dataset coverage mismatch');
    for (const name of names) {
      if (
        manifest.counts[name] !== count(payload.datasets[name]) ||
        manifest.checksums[name] !== (await hashValue(payload.datasets[name]))
      )
        fail('dataset count or SHA-256 mismatch');
    }
    // Export time/coverage do not change identity; retrying a fresh export of the same snapshot is idempotent.
    const archiveId = await hashValue({
      format: manifest.format,
      version: manifest.version,
      sourceApp: manifest.sourceApp,
      namespace: manifest.namespace,
      datasets: payload.datasets,
    });
    return { manifest, datasets: payload.datasets, archiveId };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid finance archive:')) throw error;
    fail('malformed ZIP or JSON');
  }
}
