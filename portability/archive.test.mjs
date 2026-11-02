import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createArchive,
  readArchive,
  hashValue,
  canonicalStringify,
  validateDatasets,
  MAX_ARCHIVE_BYTES,
} from './archive.mjs';

export function fixture() {
  const at = '2026-01-01T12:00:00.000Z';
  const accounts = ['bank', 'wallet'].map((id) => ({
    id,
    label: id,
    provider: 'Synthetic',
    currency: 'GHS',
    includeInCash: true,
    createdAt: at,
  }));
  const movement = (id, accountId, direction, amountMinor, status = 'confirmed') => ({
    id,
    accountId,
    direction,
    amountMinor,
    feeMinor: 25,
    taxMinor: 10,
    currency: 'GHS',
    date: '2026-01-01',
    occurredAt: at,
    status,
    description: `Fictional ${id}`,
    category: 'Other',
    sourceId: `source-${id}`,
    sourceKind: 'manual',
    sourceFingerprint: `fp-${id}`,
    legacyTransactionId: null,
    feeTransactionId: null,
    legacyClassification: null,
  });
  const movements = [
    movement('payment', 'bank', 'out', 10000),
    movement('refund', 'bank', 'in', 2500),
    movement('loan', 'bank', 'out', 5000),
    movement('repayment', 'bank', 'in', 2000),
    movement('transfer-out', 'bank', 'out', 3000, 'transfer'),
    movement('transfer-in', 'wallet', 'in', 3000, 'transfer'),
  ];
  const ref = (id) => ({ movementId: id, sourceFingerprint: `fp-${id}` });
  const datasets = {
    accounts,
    movements,
    snapshots: [
      {
        id: 'snapshot',
        accountId: 'bank',
        balanceMinor: 70000,
        occurredAt: at,
        sourceId: 'reported-bank',
        sourceMovementId: null,
      },
    ],
    transfers: [
      {
        id: 'transfer',
        outgoing: ref('transfer-out'),
        incoming: ref('transfer-in'),
        createdAt: at,
      },
    ],
    settlements: [
      {
        id: 'partial-refund',
        kind: 'refund',
        original: ref('payment'),
        returns: [{ ...ref('refund'), principalMinor: 2000 }],
        createdAt: at,
      },
      {
        id: 'partial-loan',
        kind: 'loan',
        original: ref('loan'),
        returns: [{ ...ref('repayment'), principalMinor: 1500 }],
        createdAt: at,
      },
    ],
    'moneyTracker.native': {
      notes: [{ description: 'Fictional preserved unsupported record' }],
      planning: { thirdPartyGroups: [{ id: 'synthetic-group' }] },
    },
  };
  return {
    sourceApp: 'money-tracker',
    namespace: 'synthetic:v1',
    timezone: 'Africa/Accra',
    currency: 'GHS',
    exportedAt: at,
    datasets,
    coverage: Object.keys(datasets).map((dataset) => ({
      dataset,
      status: dataset.includes('.') ? 'preserved' : 'supported',
      reason: 'Synthetic fixture coverage',
    })),
  };
}
const clone = (value) => structuredClone(value);
const crc = (bytes) => {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1));
  }
  return (n ^ 0xffffffff) >>> 0;
};
// Test-only ZIP mutator keeps local and central CRC/lengths in agreement to reach JSON/hash validators.
function editEntry(bytes, entryIndex, transform) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    end = bytes.length - 22;
  let central = view.getUint32(end + 16, true);
  for (let i = 0; i < entryIndex; i++) central += 46 + view.getUint16(central + 28, true);
  const local = view.getUint32(central + 42, true),
    nameLength = view.getUint16(local + 26, true),
    length = view.getUint32(local + 22, true),
    start = local + 30 + nameLength;
  const replacement = new TextEncoder().encode(
    transform(new TextDecoder().decode(bytes.subarray(start, start + length))),
  );
  assert.equal(replacement.length, length, 'test mutation must preserve byte length');
  bytes.set(replacement, start);
  const checksum = crc(replacement);
  view.setUint32(local + 14, checksum, true);
  view.setUint32(central + 16, checksum, true);
  return bytes;
}

test('round trip preserves source evidence, raw unsupported domains, tax, partial principal and transfer links', async () => {
  const input = fixture(),
    bytes = await createArchive(input),
    result = await readArchive(bytes);
  assert.deepEqual(result.datasets, input.datasets);
  assert.equal(result.manifest.counts.movements, 6);
  assert.equal(result.manifest.checksums.movements, await hashValue(input.datasets.movements));
  assert.equal(result.datasets.movements[0].feeMinor, 25);
  assert.equal(result.datasets.movements[0].taxMinor, 10);
  assert.equal(result.datasets.settlements[0].returns[0].principalMinor, 2000);
});
test('canonical encoding produces deterministic ZIPs and snapshot identity survives a new export time', async () => {
  const input = fixture(),
    first = await createArchive(input),
    second = await createArchive(clone(input));
  assert.deepEqual(first, second);
  const later = await createArchive({ ...input, exportedAt: '2026-02-01T12:00:00.000Z' });
  assert.equal((await readArchive(first)).archiveId, (await readArchive(later)).archiveId);
  const changed = clone(input);
  changed.datasets.movements[0].amountMinor++;
  assert.notEqual(
    (await readArchive(first)).archiveId,
    (await readArchive(await createArchive(changed))).archiveId,
  );
  assert.equal(canonicalStringify({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
});
test('rejects truncated archives and oversized bytes before parsing', async () => {
  const bytes = await createArchive(fixture());
  for (const length of [0, 10, 22, bytes.length - 1])
    await assert.rejects(readArchive(bytes.slice(0, length)), /Invalid finance archive/);
  await assert.rejects(readArchive(new Uint8Array(MAX_ARCHIVE_BYTES + 1)), /byte limit/);
});
test('rejects traversal names, duplicate entries, encryption, compressed bombs and trailing bytes', async () => {
  const original = await createArchive(fixture());
  for (const mutate of [
    (b, v, c) => {
      b.set(new TextEncoder().encode('../evil.json!'), 30);
      b.set(new TextEncoder().encode('../evil.json!'), c + 46);
    },
    (b, v, c) => {
      v.setUint16(6, 1, true);
      v.setUint16(c + 8, 1, true);
    },
    (b, v, c) => {
      v.setUint16(8, 8, true);
      v.setUint16(c + 10, 8, true);
      v.setUint32(c + 24, 0x7fffffff, true);
    },
    (b, v, c) => {
      v.setUint32(c + 42, 1, true);
    },
    (b, v, c) => {
      v.setUint32(c + 38, 0xa1ff0000, true);
    },
    (b, v, c) => {
      v.setUint16(c + 30, 1, true);
    },
  ]) {
    const bytes = original.slice(),
      view = new DataView(bytes.buffer),
      central = view.getUint32(bytes.length - 6, true);
    mutate(bytes, view, central);
    await assert.rejects(readArchive(bytes), /Invalid finance archive/);
  }
  const withTail = new Uint8Array(original.length + 1);
  withTail.set(original);
  await assert.rejects(readArchive(withTail), /Invalid finance archive/);
});
test('checks both ZIP CRC and dataset SHA/counts, rejects duplicate JSON keys and unsafe keys', async () => {
  const original = await createArchive(fixture()),
    corrupted = original.slice();
  corrupted[100] ^= 1;
  await assert.rejects(readArchive(corrupted), /ZIP checksum/);
  await assert.rejects(
    readArchive(
      editEntry(original.slice(), 1, (s) => s.replace('Fictional payment', 'Fictional changed')),
    ),
    /SHA-256 mismatch/,
  );
  await assert.rejects(
    readArchive(editEntry(original.slice(), 0, (s) => s.replace('"movements":6', '"movements":7'))),
    /count or SHA-256 mismatch/,
  );
  await assert.rejects(
    readArchive(
      editEntry(original.slice(), 1, (s) =>
        s.replace('"currency":"GHS","date"', '"category":"GHS","date"'),
      ),
    ),
    /canonical/,
  );
  assert.throws(() => canonicalStringify(JSON.parse('{"__proto__":{}}')), /unsafe JSON key/);
  assert.throws(() => canonicalStringify({ constructor: 'invalid' }), /unsafe JSON key/);
});
test('rejects wrong version, invalid timezone and inconsistent domain references', async () => {
  const input = fixture();
  await assert.rejects(
    readArchive(
      editEntry(await createArchive(input), 0, (value) =>
        value.replace('"version":1', '"version":2'),
      ),
    ),
    /manifest schema or version/,
  );
  for (const changes of [
    { timezone: 'Invalid/Zone' },
    { namespace: '../owner' },
    { currency: 'GH' },
  ])
    await assert.rejects(createArchive({ ...input, ...changes }), /manifest schema|timezone/);
  const invalids = [
    (d) => {
      d.accounts.push(clone(d.accounts[0]));
    },
    (d) => {
      d.movements[0].ownerId = 'archive-attacker';
    },
    (d) => {
      d.movements[0].owner_id = 'archive-attacker';
    },
    (d) => {
      d.movements[1].sourceId = d.movements[0].sourceId;
    },
    (d) => {
      d.movements[0].accountId = 'missing';
    },
    (d) => {
      d.movements[0].amountMinor = 0.5;
    },
    (d) => {
      d.movements[0].taxMinor = -1;
    },
    (d) => {
      d.movements[0].date = '2026-02-30';
    },
    (d) => {
      d.transfers[0].incoming.sourceFingerprint = 'stale';
    },
    (d) => {
      d.movements[5].amountMinor++;
    },
    (d) => {
      d.movements[5].accountId = 'bank';
    },
    (d) => {
      d.settlements[0].returns[0].principalMinor = 2501;
    },
    (d) => {
      d.settlements[0].returns[0].movementId = 'repayment';
      d.settlements[0].returns[0].sourceFingerprint = 'fp-repayment';
    },
    (d) => {
      d.snapshots[0].sourceMovementId = 'refund';
      d.snapshots[0].sourceFingerprint = 'wrong';
    },
  ];
  for (const mutate of invalids) {
    const datasets = clone(input.datasets);
    mutate(datasets);
    assert.throws(() => validateDatasets(datasets), /Invalid finance archive/);
  }
});
test('native datasets are bounded JSON and cannot introduce JS prototypes', () => {
  const input = fixture();
  let value = {};
  for (let i = 0; i < 34; i++) value = { value };
  assert.throws(() => validateDatasets({ ...input.datasets, deep: value }), /complexity/);
  assert.throws(() => canonicalStringify({ nope: undefined }), /JSON value/);
  assert.throws(() => canonicalStringify({ nope: Number.NaN }), /non-finite/);
});

test('generated source snapshot identities and account labels retain native supported lengths', async () => {
  const input = fixture();
  input.datasets.accounts[0].label = 'a'.repeat(160);
  input.datasets.snapshots[0].id = 'source-snapshot:' + 's'.repeat(400);
  const archive = await readArchive(await createArchive(input));
  assert.equal(archive.datasets.accounts[0].label.length, 160);
  assert.equal(archive.datasets.snapshots[0].id.length, 416);
});

test('fee-only movements retain zero principal without inventing or dropping a charge', async () => {
  const input = fixture();
  input.datasets.movements.push({
    ...input.datasets.movements[0],
    id: 'fee-only',
    sourceId: 'fee-only-source',
    sourceFingerprint: 'fee-only-fingerprint',
    amountMinor: 0,
    feeMinor: 100,
    taxMinor: 5,
  });
  const archive = await readArchive(await createArchive(input));
  assert.equal(archive.datasets.movements.at(-1).amountMinor, 0);
  assert.equal(archive.datasets.movements.at(-1).feeMinor, 100);
  input.datasets.movements.at(-1).feeMinor = 0;
  input.datasets.movements.at(-1).taxMinor = 0;
  await assert.rejects(createArchive(input), /movement schema/);
});
