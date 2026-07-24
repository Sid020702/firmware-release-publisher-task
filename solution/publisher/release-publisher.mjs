import Database from 'duckdb';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../releases.duckdb');
const CSV_PATH = resolve(__dirname, '../fixtures/build_manifest.csv');

const db = new Database.Database(DB_PATH);
const conn = db.connect();

function query(sql) {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

//Setup db
await query(`
  CREATE OR REPLACE TABLE raw_entries AS
  SELECT DISTINCT * FROM read_csv_auto('${CSV_PATH}', header=true)
`);

await query(`
  CREATE TABLE IF NOT EXISTS receipts (
    bundle_id VARCHAR PRIMARY KEY,
    request_token VARCHAR,
    publication_id VARCHAR,
    status VARCHAR
  )
`);

//Fetch eligible bundles
const bundles = await query(`
  WITH withdrawn AS (
    SELECT supersedes_id AS entry_id FROM raw_entries
    WHERE record_type = 'WITHDRAWAL' AND supersedes_id IS NOT NULL AND supersedes_id != ''
  ),
  eligible AS (
    SELECT DISTINCT entry_id, bundle_id, size_bytes FROM raw_entries
    WHERE record_type = 'BUILD' AND entry_id NOT IN (SELECT entry_id FROM withdrawn)
  )
  SELECT bundle_id, COUNT(*) AS artifact_count, SUM(size_bytes) AS total_bytes
  FROM eligible
  GROUP BY bundle_id
  ORDER BY bundle_id
`);

//Key metadata
const keyRes = await fetch('http://localhost:7070/v1/signing-key/current');
const keyMeta = await keyRes.json();

//Iterate over eligible bundles
for (const row of bundles) {
  const request_token = `token-${row.bundle_id}`;
  const existing = await query(`SELECT * FROM receipts WHERE bundle_id = '${row.bundle_id}'`);

  //Idemptoency check
  if (existing.length > 0) {
    const r = existing[0];
    console.log(`BUNDLE ${row.bundle_id} SIGNED KEY=${keyMeta.key_id}`);
    console.log(`BUNDLE ${row.bundle_id} PUBLISHED RECEIPT=${r.publication_id} TOKEN=${r.request_token} STATUS=${r.status}`);
    continue;
  }

  const descriptor = JSON.stringify({
    artifact_count: Number(row.artifact_count),
    bundle_id: row.bundle_id,
    total_bytes: Number(row.total_bytes),
  });

  writeFileSync('/tmp/desc.bin', descriptor, 'utf8');
  execFileSync('openssl', [
    'cms',
    '-sign',
    '-in',
    '/tmp/desc.bin',
    '-signer',
    '/app/keys/current/current.cert.pem',
    '-inkey',
    '/app/keys/current/current.key.pem',
    '-outform',
    'PEM',
    '-binary',
    '-out',
    '/tmp/sig.pem',
  ]);

  const signature = readFileSync('/tmp/sig.pem', 'utf8');

  //Publish and record the receipt
  const res = await fetch('http://localhost:7070/v1/publications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descriptor, signature, request_token }),
  });

  const receipt = await res.json();

  await query(`
    INSERT OR REPLACE INTO receipts VALUES (
      '${row.bundle_id}', '${request_token}', '${receipt.publication_id}', '${receipt.status}'
    )
  `);

  console.log(`BUNDLE ${row.bundle_id} SIGNED KEY=${keyMeta.key_id}`);
  console.log(
    `BUNDLE ${row.bundle_id} PUBLISHED RECEIPT=${receipt.publication_id} TOKEN=${request_token} STATUS=${receipt.status}`,
  );
}

conn.close();
db.close();
