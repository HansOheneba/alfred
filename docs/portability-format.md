# Finance portability archive v1

Export, validation and mapping are deterministic. An archive contains private financial records and source text. Checksums detect corruption; they do not encrypt the data or authenticate its sender.

## ZIP and JSON contract

A ZIP contains exactly `manifest.json`, then `data.json`. Version 1 uses ZIP STORE, without compression, encryption, extra entries, directories, comments, attributes, data descriptors or extensions. Nothing is extracted to disk. The reader rejects traversal, duplicate entries, overlaps, invalid CRCs, trailing bytes and unsafe JSON keys.

Limits are 20,000,000 archive bytes, 128,000 manifest bytes, 50,000 common records and 32 JSON nesting levels. JSON is UTF-8 with recursively sorted object keys, original array order and no insignificant whitespace. Incoming noncanonical JSON and duplicate keys are rejected. Use `createArchive` or `canonicalStringify` from `portability/archive.mjs`.

The manifest contains:

- `format: "finance-portability"`, `version: 1`
- `sourceApp: "money-tracker" | "alfred"`, stable installation `namespace`
- ISO `exportedAt`, IANA `timezone`, default ISO `currency`
- Dataset `counts`, SHA-256 `checksums` and `coverage`

Coverage entries contain `dataset`, `status` (`supported`, `preserved`, `excluded`, `unavailable`), `reason` and optional `count`. Coverage describes source/destination capabilities; it is not permission to activate data.

`data.json` is `{ "datasets": { ... } }`. The common arrays `accounts`, `movements`, `snapshots`, `transfers` and `settlements` are mandatory. Native payloads use `alfred.native` and `moneyTracker.native`; additional documented datasets carry browser preferences and retained evidence.

## Common accounting

Money uses safe integer minor units. Principal is nonnegative and principal + fee + tax must be positive. A known fee-only charge may have zero principal. Fee and tax are separate nonnegative fields; missing `taxMinor` defaults to zero for older records. Unknown principals remain native evidence. Account and movement currencies must agree.

Accounts carry stable identity, label, provider, currency, cash inclusion and creation time. Movements carry source identity/fingerprint, date, direction, status, amounts and optional reported balance/source text. Ownership fields are forbidden on common rows: the destination derives ownership from its authenticated session.

Balance snapshots reference an account and optionally an exact source movement. Transfers link equal-principal, same-currency outgoing/incoming movements on different accounts with transfer status. Refund/loan settlements use exact source fingerprints and explicit per-return principal. Allocations cannot exceed either source principal or incoming amount; fees and taxes are not consumed by an offset. Transfers and settlements cannot reserve the same movement.

`importProvenance` preserves original namespace/source identity across hops. Destination IDs derive from those stable origins. Changed existing evidence is a conflict. `archiveId` hashes format, version, source app, namespace and datasets, excluding export time/coverage, so unchanged data retains its identity.

## Lifecycle and retained evidence

Preview validates archive structure, schema, checksums, counts and references before confirmation. Confirmation rechecks source/native/rule versions and commits supported records, links, evidence and receipt atomically. Retries are idempotent. Undo refuses later edits.

Unsupported data stays saved, visible and included in subsequent exports. Documented `preservedArchives` and native `retainedArchives` wrappers can carry `{manifest,datasets}` or scrubbed `{sourceManifest,datasets}` evidence. Alfred reviews bounded known wrappers; nested common cash arrays are not replayed. A scrubbed source manifest describes the original upload, not a new checksum assertion about redacted evidence.

Stored-source activation uses current adapters without re-upload. No new support means no financial change. Available additions require preview and confirmation with their own activation identity/receipt. Old receipts and audit records never gain authority over new destination records.

Each app must apply explicit export allowlists and exclude credentials, sessions, source ownership, push keys/endpoints, machine paths and operational actions. Version 1 is not a general database merge engine. See the [domain matrix](portability-domain-matrix.md) before treating every source feature as active.

## Verification

```sh
npm run test:portability:archive
npm run test:portability:sql
npm run test:portability:journey
```

These checks use repository-owned synthetic records and an ephemeral embedded database; no live migration or finance account is needed.
