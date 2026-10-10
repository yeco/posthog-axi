import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '../dist/http.js';
import { Args } from '../dist/args.js';
import { bodyOptions } from '../dist/execute.js';
import { promptKey } from '../dist/config.js';
import { render } from '../dist/output.js';
import { decode } from '@toon-format/toon';

test('real fetch serializes JSON and refuses a local redirect without a second request', async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ path: req.url, auth: req.headers.authorization, body });
    if (req.url === '/api/redirect/') { res.writeHead(302, { location: '/api/stolen/' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":1}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new Client(`http://127.0.0.1:${server.address().port}`, 'phx_test');
    await client.request('POST', '/api/example/', await bodyOptions(new Args(['--data', '{"name":"test"}'])));
    await assert.rejects(client.request('GET', '/api/redirect/'), { code: 'redirect_refused' });
    assert.deepEqual(received, [{ path: '/api/example/', auth: 'Bearer phx_test', body: '{"name":"test"}' }, { path: '/api/redirect/', auth: 'Bearer phx_test', body: '' }]);
  } finally { server.close(); await once(server, 'close'); }
});
test('JSON files, multipart uploads, URL-encoded forms and raw bytes retain input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'axi-bodies-'));
  try {
    const path = join(dir, 'body.json'); await writeFile(path, '{"value":42}');
    assert.equal((await bodyOptions(new Args(['--input', path]))).body, '{"value":42}');
    const multipart = await bodyOptions(new Args(['--form', 'name=note', '--file-field', `file=${path}`]));
    assert.equal(multipart.contentType, undefined); assert.equal(multipart.body.get('name'), 'note');
    assert.equal(await multipart.body.get('file').text(), '{"value":42}');
    const form = await bodyOptions(new Args(['--form', 'name=a & b', '--content-type', 'application/x-www-form-urlencoded']));
    assert.equal(form.body.toString(), 'name=a+%26+b');
    const raw = await bodyOptions(new Args(['--raw', path])); assert.equal(Buffer.from(raw.body).toString(), '{"value":42}');
    await assert.rejects(bodyOptions(new Args(['--raw', path, '--data', '{}'])), { code: 'usage' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('SSE is a bounded sample with event IDs and multiline data', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': heartbeat\n\nid: 1\ndata: {"x":1}\n\nid: 2\ndata: second\ndata: line\n\n')); }, cancel() { cancelled = true; } });
  const client = new Client('https://us.posthog.com', 'phx_test', async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  const result = await client.request('GET', '/api/events/', { maxEvents: 2 });
  assert.deepEqual(result.events, [{ id: '1', data: { x: 1 } }, { id: '2', data: 'second\nline' }]);
  assert.equal(result.stream, 'sample_limit'); assert.equal(cancelled, true);
});
test('hidden login input restores the terminal on success and cancellation', async () => {
  for (const cancelled of [false, true]) {
    const input = new EventEmitter(); let output = '';
    input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; }; input.resume = () => {}; input.pause = () => {};
    const promise = promptKey(input, { isTTY: true, write: value => { output += value; } });
    input.emit('data', Buffer.from(cancelled ? 'secret\x03' : 'secret\x7ft\r'));
    if (cancelled) await assert.rejects(promise, { code: 'cancelled' }); else assert.equal(await promise, 'secret');
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0); assert.ok(!output.includes('secret'));
  }
});
test('compact output declares omissions; full and JSON preserve rows while redacting', () => {
  const value = { results: Array.from({ length: 25 }, (_, id) => ({ id, name: 'x'.repeat(300), token: 'private' })) };
  const compact = decode(render(value)); assert.equal(compact.data.results.length, 20); assert.ok(compact.truncated.length);
  assert.equal(decode(render(value, { full: true })).results.length, 25);
  assert.equal(JSON.parse(render(value, { json: true })).results[0].name.length, 300);
  assert.ok(!render(value, { full: true }).includes('private'));
});
