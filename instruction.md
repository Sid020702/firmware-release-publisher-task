# Firmware Release Publisher

Release engineering rotated the firmware code-signing key. The old key is revoked.
Your job is to write a publisher that reads the build manifest, figures out what
needs to be published, signs it with the current key, and submits it to the
distribution gateway.

## What to build

Create `publisher/release-publisher.mjs` (ESM, Node 20). Running `npm run report`
must produce output matching `reports/publications.expected.txt`.

## The manifest

`fixtures/build_manifest.csv` contains firmware build entries. Columns:
`entry_id, bundle_id, component_id, version, size_bytes, record_type, supersedes_id, recorded_at`

Two record types:
- `BUILD` — a firmware component ready to publish
- `WITHDRAWAL` — cancels the BUILD row whose `entry_id` matches this row's `supersedes_id`

Rules:
- Deduplicate rows that are byte-identical (same `entry_id` appearing twice = one row)
- A BUILD cancelled by a WITHDRAWAL is not publishable
- If every BUILD in a bundle is withdrawn, skip that bundle entirely
- Publishable bundles are processed in ascending `bundle_id` order

## The database

Load the manifest into `/app/releases.duckdb` (DuckDB, created at runtime).
Use SQL to derive publishable bundles. Store the gateway receipts and request
tokens in the same DB so re-runs are idempotent.

## Signing

Before submitting, call `GET /v1/signing-key/current` to get the active key id.

Build a canonical descriptor for each bundle:
```json
{"artifact_count": <n>, "bundle_id": "<id>", "total_bytes": <n>}
```
Keys must be in that order (alphabetical), no extra whitespace, integers not strings.

Sign with openssl:
```bash
openssl cms -sign -in <descriptor_file> \
  -signer /app/keys/current/current.cert.pem \
  -inkey  /app/keys/current/current.key.pem \
  -outform PEM -binary -out <sig_file>
```

Do NOT sign with the revoked key at `/app/keys/revoked/`. The gateway will reject it.

## Submitting

POST to `http://localhost:7070/v1/publications`:
```json
{
  "descriptor": "<canonical descriptor string>",
  "signature": "<PEM signature>",
  "request_token": "token-<bundle_id>"
}
```

The `request_token` must be deterministic (`token-BND-101` etc.) so re-runs replay
the same receipt rather than creating duplicates.

## Output format

Two lines per bundle, in bundle_id order:
```
BUNDLE <bundle_id> SIGNED KEY=<key_id>
BUNDLE <bundle_id> PUBLISHED RECEIPT=<publication_id> TOKEN=<request_token> STATUS=PUBLISHED
```

## Rules

- Only interact with the gateway over HTTP
- Do not read or write `distribution-gateway/data/gateway.json`
- Do not hardcode receipts, counts, or row data — derive everything from the manifest
- Second run must produce identical output and no duplicate gateway submissions

## Verify

```bash
npm run report --silent > /tmp/out.txt
diff <(sed -E 's/RECEIPT=[^ ]+/RECEIPT=<id>/' reports/publications.expected.txt) \
     <(sed -E 's/RECEIPT=[^ ]+/RECEIPT=<id>/' /tmp/out.txt)
```
