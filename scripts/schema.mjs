import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Registry, hash, parseDocument, buildPath, schemaMetadata } from '../dist/schema.js';
import { Client } from '../dist/http.js';
const action = process.argv[2];
const root = new URL('../schema/', import.meta.url);
if (action === 'update') {
  const source = process.env.POSTHOG_HOST || 'https://us.posthog.com';
  const client = new Client(source);
  const doc = parseDocument(await client.request('GET', '/api/schema/', { public: true }));
  const bytes = Buffer.from(JSON.stringify(doc));
  const registry = new Registry(doc);
  await writeFile(new URL('openapi.json.gz', root), gzipSync(bytes, { level: 9 }));
  await writeFile(new URL('metadata.json', root), JSON.stringify({ source: `${client.host}/api/schema/`, fetched_at: new Date().toISOString(), openapi: doc.openapi, api_version: doc.info.version, sha256: hash(doc), snapshot_sha256: createHash('sha256').update(bytes).digest('hex'), paths: Object.keys(doc.paths).length, operations: registry.operations.length }, null, 2) + '\n');
  await writeFile(new URL('coverage.json', root), JSON.stringify(registry.operations.map(({ id, method, path }) => ({ operation: id, method, path, command: `api call ${id}` })), null, 2) + '\n');
} else if (action === 'check') {
  const registry = new Registry(); const meta = schemaMetadata();
  const expected = registry.operations.map(({ id, method, path }) => ({ operation: id, method, path, command: `api call ${id}` }));
  const bytes = gunzipSync(await readFile(new URL('openapi.json.gz', root)));
  if (createHash('sha256').update(bytes).digest('hex') !== meta.snapshot_sha256) throw new Error('Snapshot byte digest mismatch');
  const recorded = JSON.parse(await readFile(new URL('coverage.json', root), 'utf8'));
  if (hash(expected) !== hash(recorded) || hash(registry.document) !== meta.sha256 || registry.operations.length !== meta.operations) throw new Error('Schema or coverage metadata is stale; run npm run schema:update and review the diff');
  for (const op of registry.operations) buildPath(registry.get(op.id), Object.fromEntries([...op.path.matchAll(/\{([^}]+)\}/g)].map(m => [m[1], '123'])), '123');
  console.log(`coverage: ${expected.length}/${meta.operations} operations routable`);
} else throw new Error('Usage: node scripts/schema.mjs check|update');
