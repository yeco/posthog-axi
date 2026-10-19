import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Args, pairs, uniquePairs } from './args.js';
import { AxiError, object, usage } from './errors.js';
import { Client, type RequestOptions } from './http.js';
import { buildPath, Registry, resolveRef, type Operation } from './schema.js';

export const REQUEST_FLAGS = ['param', 'query', 'header', 'data', 'input', 'raw', 'content-type', 'form', 'file-field', 'confirm', 'all'];
export async function inputFile(path: string): Promise<Buffer> {
  try {
    if (path !== '-') return await readFile(path);
    const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch { throw new AxiError('input_error', 'Could not read request input'); }
}
export async function jsonBody(args: Args): Promise<unknown> {
  if (args.has('data') && args.has('input')) usage('Choose --data or --input, not both');
  const text = args.get('data') ?? (args.has('input') ? (await inputFile(args.get('input')!)).toString('utf8') : undefined);
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { throw new AxiError('invalid_json', 'Request body is not valid JSON'); }
}
export async function bodyOptions(args: Args): Promise<RequestOptions> {
  const forms = pairs(args.many('form')), files = pairs(args.many('file-field'));
  const types = Number(args.has('data') || args.has('input')) + Number(args.has('raw')) + Number(forms.length > 0 || files.length > 0);
  if (types > 1) usage('Choose JSON, raw input, or form fields');
  const contentType = args.get('content-type');
  if (args.has('raw')) return { body: new Uint8Array(await inputFile(args.get('raw')!)), contentType: contentType ?? 'application/octet-stream' };
  if (forms.length || files.length) {
    if (contentType === 'application/x-www-form-urlencoded') {
      if (files.length) usage('File fields need multipart/form-data');
      return { body: new URLSearchParams(forms), contentType };
    }
    if (contentType && contentType !== 'multipart/form-data') usage('Form fields need multipart/form-data or application/x-www-form-urlencoded');
    const form = new FormData(); for (const [name, value] of forms) form.append(name, value);
    for (const [name, path] of files) form.append(name, new Blob([new Uint8Array(await inputFile(path))]), basename(path));
    return { body: form }; // fetch owns the multipart boundary.
  }
  const body = await jsonBody(args);
  return body === undefined ? {} : { body: JSON.stringify(body), contentType: contentType ?? 'application/json' };
}
export function requireConfirmation(args: Args, method: string) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !args.has('confirm')) throw new AxiError('confirmation_required', 'This operation can change PostHog state', ['Inspect api describe <operation>, then repeat with --confirm. Writes are never retried automatically.']);
}
export async function execute(registry: Registry, client: Client, op: Operation, args: Args, project: string): Promise<unknown> {
  requireConfirmation(args, op.method);
  if (args.has('all') && op.method !== 'GET') usage('--all is only valid for GET operations');
  const path = buildPath(op, uniquePairs(args.many('param')), project);
  const url = client.url(path);
  const query = pairs(args.many('query'));
  for (const [name, value] of query) url.searchParams.append(name, value);
  const headers = uniquePairs(args.many('header'));
  for (const parameter of op.parameters) {
    if (parameter.required && parameter.in === 'query' && !url.searchParams.has(parameter.name)) usage(`Missing required query parameter ${parameter.name}`);
    if (parameter.required && parameter.in === 'header' && !Object.keys(headers).some(k => k.toLowerCase() === parameter.name.toLowerCase())) usage(`Missing required header ${parameter.name}`);
  }
  const options = { ...await bodyOptions(args), headers };
  if (['GET', 'HEAD'].includes(op.method) && options.body !== undefined) usage('GET and HEAD do not accept request bodies');
  const bodySpec = resolveRef(registry.document, op.definition.requestBody);
  if (bodySpec.required && options.body === undefined) usage('This operation requires a body; use api describe for its schema');
  if (op.method === 'GET') return client.pages(url.href, args.has('all'), options);
  const result = await client.request(op.method, url.href, options);
  return ['HEAD', 'OPTIONS'].includes(op.method) ? result : { operation: op.id, status: 'completed', result };
}
export function subset(desired: unknown, actual: unknown): boolean {
  if (Array.isArray(desired)) return Array.isArray(actual) && desired.length === actual.length && desired.every((v, i) => subset(v, actual[i]));
  if (desired && typeof desired === 'object') return actual !== null && typeof actual === 'object' && Object.entries(desired).every(([k, v]) => Object.hasOwn(actual, k) && subset(v, object(actual)[k]));
  return desired === actual;
}
