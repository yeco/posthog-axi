import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, normalizeHost } from '../dist/http.js';
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
test('host and pagination never leak bearer credentials', async () => {
  let calls = 0;
  const client = new Client('https://us.posthog.com', 'phx_fake', async (url, init) => {
    calls++;
    assert.equal(init.headers.get('authorization'), 'Bearer phx_fake');
    assert.equal(init.redirect, 'manual');
    return json({ results: [1], next: 'https://evil.invalid/api/stolen' });
  });
  await assert.rejects(client.pages('/api/projects/', true), { code: 'unsafe_url' });
  assert.equal(calls, 1);
  for (const host of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path']) assert.throws(() => normalizeHost(host));
});
test('errors hide server body and mutations are never retried', async () => {
  let calls = 0;
  const client = new Client('https://us.posthog.com', 'phx_fake', async () => {
    calls++; return new Response('phx_fake', { status: 429, headers: { 'retry-after': '7' } });
  });
  await assert.rejects(client.request('POST', '/api/projects/'), { code: 'rate_limited', retryAfter: '7' });
  assert.equal(calls, 1);
});
test('cursor pagination, 204 and redirects', async () => {
  let calls = 0;
  const client = new Client('https://us.posthog.com', 'fake', async () => json({ results: [++calls], next: calls === 1 ? '/api/projects/?cursor=x' : null }));
  assert.deepEqual((await client.pages('/api/projects/', true)).results, [1, 2]);
  assert.equal(await new Client('https://us.posthog.com', 'fake', async () => new Response(null, { status: 204 })).request('DELETE', '/api/projects/1/'), null);
  await assert.rejects(new Client('https://us.posthog.com', 'fake', async () => new Response(null, { status: 302 })).request('GET', '/api/projects/'), { code: 'redirect_refused' });
});
test('explicit response negotiation survives default headers', async () => {
  const client = new Client('https://us.posthog.com', 'fake', async (_url, init) => {
    assert.equal(init.headers.get('accept'), 'text/csv');
    return new Response('a,b\n1,2', { headers: { 'content-type': 'text/csv' } });
  });
  assert.equal((await client.request('GET', '/api/export/', { headers: { Accept: 'text/csv' } })).text, 'a,b\n1,2');
});
