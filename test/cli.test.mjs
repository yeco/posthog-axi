import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../dist/cli.js';
import { decode } from '@toon-format/toon';
const env = { POSTHOG_API_KEY: 'phx_test_only', XDG_CONFIG_HOME: '/nonexistent/posthog-axi-tests' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noNetwork = async () => { throw new Error('Unexpected network request'); };
async function cli(argv, fetch = noNetwork) {
  const result = await run([...argv, '--json'], { env, fetch });
  return { code: result.code, ...JSON.parse(result.output) };
}
test('help, discovery, schema and offline compatibility do not need credentials or network', async () => {
  for (const argv of [[], ['--help'], ['api', 'resources'], ['api', 'describe', 'surveys_create'], ['api-version', '--offline'], ['flags', '--help']]) {
    const result = await run(argv, { env: { XDG_CONFIG_HOME: '/nonexistent/posthog-axi-tests' }, fetch: noNetwork });
    assert.equal(result.code, 0, result.output);
    assert.ok(decode(result.output));
  }
  const result = await cli(['api', 'operations', '--search', 'early_access', '--limit', '2']);
  assert.equal(result.operations.length, 2); assert.ok(result.total >= 6);
});
test('unknown options and missing inputs fail before HTTP', async () => {
  for (const argv of [['flags', 'list', '--activee', 'true'], ['api', 'call', 'surveys_create'], ['api', 'call', 'surveys_retrieve'], ['query'], ['flags', 'show', '1', 'extra'], ['api-version', '--offline', '--check']]) {
    const result = await cli(argv); assert.notEqual(result.code, 0, JSON.stringify(argv));
  }
});
test('resource query options and positional ids serialize correctly', async () => {
  const result = await cli(['flags', 'list', '--active', 'true', '--search', 'a & b'], async (url) => {
    assert.equal(url.pathname, '/api/projects/613011/feature_flags/');
    assert.equal(url.searchParams.get('search'), 'a & b'); assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.get('active'), 'true'); return json({ results: [{ id: 1, key: 'beta' }], next: null });
  });
  assert.equal(result.code, 0); assert.equal(result.results[0].key, 'beta');
});
test('flags enable is sequentially idempotent and sends optimistic version', async () => {
  let active = false, writes = 0;
  const fetch = async (_url, init) => {
    if (init.method === 'GET') return json({ id: 1, active, version: 7 });
    const body = JSON.parse(init.body); assert.equal(body.version, 7); active = body.active; writes++; return json({ id: 1, active });
  };
  assert.equal((await cli(['flags', 'enable', '1', '--confirm'], fetch)).status, 'updated');
  assert.equal((await cli(['flags', 'enable', '1', '--confirm'], fetch)).status, 'unchanged');
  assert.equal(writes, 1);
});
test('rollout uses current version and never rewrites unrelated release conditions', async () => {
  let writes = 0;
  const fetch = async (url, init) => {
    if (init.method === 'GET') return json({ id: 1, version: 9, filters: { groups: [{ rollout_percentage: 5 }, { rollout_percentage: 80, properties: [{ key: 'email' }] }] } });
    writes++; assert.equal(url.pathname, '/api/projects/613011/feature_flags/1/set_release_condition_rollout/');
    assert.deepEqual(JSON.parse(init.body), { condition_index: 0, rollout_percentage: 12.5, version: 9 }); return json({ id: 1 });
  };
  assert.equal((await cli(['flags', 'rollout', '1', '12.5', '--confirm'], fetch)).code, 0);
  assert.equal(writes, 1);
  assert.equal((await cli(['flags', 'rollout', '1', '101', '--confirm'], fetch)).code, 2);
});
test('create ensure reconciles by identity and supports schedules', async () => {
  let writes = 0;
  const fetch = async (url, init) => {
    if (url.searchParams.get('archived') === 'true') return json({ results: [], next: null });
    if (init.method === 'GET') return json(url.pathname.endsWith('/1/') ? { id: 1, key: 'beta', active: true } : { results: [{ id: 1, key: 'beta', active: true }], next: null });
    writes++; return json({ id: 1 });
  };
  const result = await cli(['flags', 'ensure', '--data', '{"key":"beta","active":true}', '--confirm'], fetch);
  assert.equal(result.status, 'unchanged'); assert.equal(writes, 0);
  const schedule = await cli(['schedules', 'create', '--data', '{"model_name":"FeatureFlag","record_id":"1","scheduled_at":"2027-01-01T00:00:00Z","payload":{"operation":"update_status","value":true}}', '--confirm'], async (url, init) => {
    assert.equal(url.pathname, '/api/projects/613011/scheduled_changes/'); assert.equal(JSON.parse(init.body).payload.operation, 'update_status'); return json({ id: 1 }, 201);
  });
  assert.equal(schedule.code, 0);
});
test('delete of an absent resource succeeds without hiding authorization errors', async () => {
  assert.equal((await cli(['surveys', 'delete', 'abc', '--confirm'], async () => new Response(null, { status: 404 }))).status, 'unchanged');
  assert.equal((await cli(['surveys', 'delete', 'abc', '--confirm'], async () => new Response(null, { status: 403 }))).error.code, 'forbidden');
});
test('generic nested operation parameters and repeated query fields', async () => {
  const result = await cli(['api', 'call', 'feature_flags_versions_retrieve', '--param', 'id=1', '--param', 'version_number=4', '--query', 'flag_keys=a', '--query', 'flag_keys=b'], async (url) => {
    assert.equal(url.pathname, '/api/projects/613011/feature_flags/1/versions/4/'); assert.deepEqual(url.searchParams.getAll('flag_keys'), ['a', 'b']); return json({ key: 'beta' });
  }); assert.equal(result.code, 0);
});
test('HogQL query, async status and cancellation use API contracts', async () => {
  const paths = [];
  const fetch = async (url, init) => {
    paths.push([url.pathname, init.method]);
    if (paths.length === 1) assert.deepEqual(JSON.parse(init.body), { query: { kind: 'HogQLQuery', query: 'select 1' }, refresh: 'async' });
    return json({ query_status: { id: 'uuid' } });
  };
  for (const argv of [['query', 'select 1', '--refresh', 'async'], ['query', 'status', 'uuid'], ['query', 'cancel', 'uuid', '--confirm']]) assert.equal((await cli(argv, fetch)).code, 0);
  assert.deepEqual(paths.map(p => p[1]), ['POST', 'GET', 'DELETE']);
});
test('keys are redacted in JSON, TOON, home data and errors', async () => {
  for (const format of [[], ['--json'], ['--full']]) {
    const result = await run(['projects', 'show', '1', '--param', 'organization_id=org-test', ...format], { env, fetch: async () => json({ token: 'secret', api_key: 'phx_test_only', nested: { message: 'echo phx_test_only' } }) });
    assert.equal(result.code, 0); assert.ok(!result.output.includes('phx_test_only')); assert.ok(!result.output.includes('secret'));
  }
});
test('every requested resource has executable read shortcuts', async () => {
  for (const resource of ['flags', 'experiments', 'surveys', 'actions', 'cohorts', 'insights', 'dashboards', 'annotations', 'persons', 'events', 'recordings', 'early-access', 'schedules', 'projects']) {
    const argv = [resource, 'list', ...(resource === 'projects' ? ['--param', 'organization_id=test-org'] : [])];
    const result = await cli(argv, async () => json({ results: [], next: null })); assert.equal(result.code, 0, resource);
  }
});
test('ambiguous ensure and duplicate IDs refuse mutations', async () => {
  let writes = 0;
  const result = await cli(['surveys', 'create', '--ensure', 'name', '--data', '{"name":"dup"}', '--confirm'], async (_url, init) => {
    if (init.method !== 'GET') writes++;
    return json({ results: [{ id: 1, name: 'dup' }, { id: 2, name: 'dup' }], next: null });
  });
  assert.equal(result.error.code, 'ambiguous_match'); assert.equal(writes, 0);
  assert.equal((await cli(['flags', 'update', '1', '--param', 'id=2', '--data', '{}', '--confirm'])).code, 2);
});
test('live api-version omits Authorization and --check distinguishes drift', async () => {
  const { loadSchema } = await import('../dist/schema.js');
  const fetch = async (url, init) => {
    assert.equal(url.pathname, '/api/schema/'); assert.equal(init.headers.has('authorization'), false);
    return json({ ...loadSchema(), info: { title: 'PostHog API', version: 'different' } });
  };
  const result = await cli(['api-version', '--check'], fetch);
  assert.equal(result.code, 3); assert.equal(result.drift, true); assert.ok(result.target.sha256);
});
test('explicit stale flag version is a conflict, not silently replaced', async () => {
  let writes = 0;
  const result = await cli(['flags', 'update', '1', '--data', '{"name":"next","version":1}', '--confirm'], async (_url, init) => {
    if (init.method !== 'GET') writes++;
    return json({ name: 'current', version: 2 });
  });
  assert.equal(result.error.code, 'conflict'); assert.equal(writes, 0);
});
test('flags ensure finds archived identity rather than creating a duplicate', async () => {
  let creates = 0;
  const result = await cli(['flags', 'ensure', '--data', '{"key":"archived-flag","archived":false}', '--confirm'], async (url, init) => {
    if (init.method === 'POST') { creates++; return json({ id: 2 }); }
    if (init.method === 'PATCH') { assert.equal(url.pathname, '/api/projects/613011/feature_flags/1/'); return json({ id: 1, archived: false }); }
    if (url.pathname.endsWith('/1/')) return json({ id: 1, key: 'archived-flag', archived: true, version: 5 });
    return json({ results: url.searchParams.get('archived') === 'true' ? [{ id: 1, key: 'archived-flag' }] : [], next: null });
  });
  assert.equal(result.status, 'updated'); assert.equal(creates, 0);
});
