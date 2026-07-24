# Author Notes

## What the task is

The solver implements a Node.js publisher that reads a firmware build manifest CSV,
reconciles it with SQL (deduplication + withdrawal cancellations), signs each
publishable bundle with OpenSSL CMS, and submits to a local Express gateway. Output
must match a golden file byte-for-byte (receipt field masked).

## Design decisions

**DuckDB for reconciliation** — the manifest has ~40 rows but the interesting work
is in the SQL: collapsing duplicate entry_ids, joining withdrawals to their targets
via supersedes_id, and dropping fully-withdrawn bundles. Using an embedded DB makes
the reconciliation logic explicit and testable.

**OpenSSL CMS signing** — the gateway shells out to `openssl cms -verify` so the
solver must use the same tool. This rules out Node crypto APIs for the signing step,
which is intentional — forces the solver to understand the CMS format and the
cert/key file locations.

**Key rotation trap** — two keypairs are generated at image build time. The revoked
key path is present and functional (it produces valid CMS signatures) but the
gateway rejects them with UNTRUSTED_SIGNATURE. A solver who hardcodes the wrong
path or doesn't read the signing-key metadata endpoint will fail this silently.

**Idempotency** — the gateway deduplicates by request_token server-side, and the
solver is also expected to check its local DB first. A second run must produce
identical output. Tests verify no duplicate rows appear in the gateway's store.

**BND-104 trap** — both BUILD rows in this bundle are withdrawn. A naive
reconciliation that only drops the withdrawal rows themselves will still include
BND-104. The correct rule is: if the net publishable set for a bundle is empty,
drop the bundle.

**Duplicate rows** — three rows appear twice in the CSV with identical entry_ids
and all columns. DISTINCT on entry_id is sufficient; solvers who try to deduplicate
on all columns also pass (the grader only checks group membership).

## How I verified 0/1

1. Built the Docker image, started gateway, ran `npm run report --silent`
2. Diffed against `reports/publications.expected.txt` with RECEIPT masked — clean diff
3. Ran twice — second run used cached receipts from DB, output identical
4. Checked gateway data dir — 3 publications, no duplicates
5. Manually tested revoked key path → got UNTRUSTED_SIGNATURE as expected

## Proof results (clean container)

**Proof A — empty run, expect reward 0:**
```
docker run --rm -it -v "$PWD/../tests":/tests:ro task-img bash -lc \
  'bash /tests/test.sh; cat /logs/verifier/reward.txt'
```
Result: 4 tests failed (no publisher installed), reward = `0`

**Proof B — reference solution, expect reward 1:**
```
docker run --rm -it -v "$PWD/../tests":/tests:ro -v "$PWD/../solution":/solution:ro \
  task-img bash -lc 'bash /solution/publish.sh && bash /tests/test.sh; cat /logs/verifier/reward.txt'
```
Result: 5 tests passed, reward = `1`
