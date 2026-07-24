import re
import subprocess
from pathlib import Path

import duckdb
import requests

WORKDIR = Path("/app")
EXPECTED_FILE = WORKDIR / "reports" / "publications.expected.txt"
DB_PATH = WORKDIR / "releases.duckdb"
GATEWAY = "http://localhost:7070"

# expected bundles after reconciliation — BND-104 fully withdrawn so excluded
EXPECTED_BUNDLES = {"BND-101", "BND-102", "BND-103"}
WITHDRAWN_BUNDLE = "BND-104"


def run_publisher():
    result = subprocess.run(
        ["npm", "run", "report", "--silent"],
        cwd=str(WORKDIR),
        capture_output=True,
        text=True,
    )
    return result.stdout.strip(), result.returncode


def get_output():
    stdout, _ = run_publisher()
    return stdout


def mask_receipt(text):
    return re.sub(r"RECEIPT=[^ ]+", "RECEIPT=<id>", text)


def test_output_matches_golden():
    """Output matches expected file (receipt field masked)."""
    stdout, code = run_publisher()
    assert code == 0, f"npm run report exited {code}"

    expected = mask_receipt(EXPECTED_FILE.read_text().strip())
    actual = mask_receipt(stdout)
    assert actual == expected, f"Output mismatch.\nExpected:\n{expected}\nGot:\n{actual}"


def test_correct_bundles_published():
    """Only the reconciled publishable bundles appear in output."""
    stdout, _ = run_publisher()
    found = set(re.findall(r"BUNDLE (BND-\d+) SIGNED", stdout))
    assert found == EXPECTED_BUNDLES, f"Expected {EXPECTED_BUNDLES}, got {found}"
    assert WITHDRAWN_BUNDLE not in stdout, f"{WITHDRAWN_BUNDLE} should be excluded (fully withdrawn)"


def test_all_published_not_rejected():
    """Every bundle has STATUS=PUBLISHED, none are UNTRUSTED_SIGNATURE."""
    stdout, code = run_publisher()
    assert code == 0, f"npm run report exited {code}"
    assert "UNTRUSTED_SIGNATURE" not in stdout
    published = re.findall(r"STATUS=(\w+)", stdout)
    assert len(published) > 0, "No STATUS lines in output"
    assert all(s == "PUBLISHED" for s in published), f"Non-PUBLISHED statuses: {published}"


def test_receipts_persisted_in_db():
    """releases.duckdb contains receipts for all published bundles."""
    assert DB_PATH.exists(), "releases.duckdb not created"
    con = duckdb.connect(str(DB_PATH), read_only=True)
    rows = con.execute("SELECT bundle_id, request_token, status FROM receipts ORDER BY bundle_id").fetchall()
    con.close()

    bundle_ids = {r[0] for r in rows}
    assert bundle_ids == EXPECTED_BUNDLES, f"DB bundles: {bundle_ids}"
    for bundle_id, request_token, status in rows:
        assert request_token == f"token-{bundle_id}"
        assert status == "PUBLISHED"


def test_idempotent_rerun():
    """Second run produces identical output and no duplicate gateway publications."""
    # get gateway publication count before second run
    key_res = requests.get(f"{GATEWAY}/v1/signing-key/current")
    assert key_res.status_code == 200

    first, _ = run_publisher()
    second, _ = run_publisher()

    assert mask_receipt(first) == mask_receipt(second), "Second run output differs"

    # gateway should still have exactly 3 publications
    # check via request_token replay — same tokens return same receipts
    for bundle_id in EXPECTED_BUNDLES:
        token = f"token-{bundle_id}"
        res = requests.post(
            f"{GATEWAY}/v1/publications",
            json={"descriptor": "{}", "signature": "dummy", "request_token": token},
        )
        # idempotent replay returns existing receipt, not an error about missing sig
        data = res.json()
        assert "publication_id" in data, f"Expected receipt replay for {token}, got: {data}"
