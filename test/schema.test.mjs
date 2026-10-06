import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, buildPath, driftReport, hash, schemaMetadata } from '../dist/schema.js';
import { execute } from '../dist/execute.js';
import { Args } from '../dist/args.js';
import { Client } from '../dist/http.js';
const registry = new Registry();
test('every pinned operation executes its HTTP method and path with mocked transport', async () => {
  let calls = 0;
  for (const op of registry.operations) {
    const args = new Args(['--confirm', '--data', '{}']);
    if (['GET', 'HEAD'].includes(op.method)) args.flags.delete('data');
    const params = Object.fromEntries([...op.path.matchAll(/\{([^}]+)\}/g)].map(m => [m[1], '123']));
    args.flags.set('param', Object.entries(params).map(([k, v]) => `${k}=${v}`));
    args.flags.set('query', op.parameters.filter(p => p.in === 'query' && p.required).map(p => `${p.name}=test`));
    args.flags.set('header', op.parameters.filter(p => p.in === 'header' && p.required).map(p => `${p.name}=test`));
    const client = new Client('https://us.posthog.com', 'phx_mock', async (url, init) => {
      calls++; assert.equal(url.pathname, buildPath(op, params, '613011')); assert.equal(init.method, op.method);
      return new Response(null, { status: 204 });
    });
    await execute(registry, client, registry.get(op.id), args, '613011');
  }
  assert.equal(calls, schemaMetadata().operations); assert.equal(calls, 2409);
});
test('drift separates operation changes from referenced component changes', () => {
  const doc = { openapi: '3.1.0', info: { version: '1' }, paths: { '/api/x/': { get: { operationId: 'x_list' } } }, components: { schemas: { Thing: { type: 'string' } } } };
  const changed = structuredClone(doc); changed.components.schemas.Thing.type = 'integer';
  changed.paths['/api/x/'].post = { operationId: 'x_create' };
  const drift = driftReport(doc, changed);
  assert.equal(drift.drift, true); assert.deepEqual(drift.added, ['x_create']); assert.deepEqual(drift.component_changes, ['schemas/Thing']);
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.equal(driftReport(doc, doc).drift, false);
});
test('path values cannot traverse or change origin', () => {
  const op = registry.get('feature_flags_retrieve');
  for (const id of ['..', '.', '\\evil', 'bad\nvalue']) assert.throws(() => buildPath(op, { id }, '1'));
  assert.equal(buildPath(op, { id: 'a ?#b' }, '1'), '/api/projects/1/feature_flags/a%20%3F%23b/');
});
