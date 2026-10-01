import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AxiError, object } from './errors.js';

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
export interface Parameter { name: string; in: string; required?: boolean; schema?: unknown; description?: string; }
export interface Operation {
  id: string; method: string; path: string; tags: string[]; summary: string;
  parameters: Parameter[]; definition: Record<string, unknown>;
}
export interface Document { openapi: string; info: Record<string, unknown>; paths: Record<string, Record<string, unknown>>; components?: Record<string, unknown>; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function parseDocument(value: unknown): Document {
  const doc = object(value);
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.') || !doc.paths || !doc.info) throw new AxiError('invalid_schema', 'Expected an OpenAPI 3 document');
  return doc as unknown as Document;
}
export function resolveRef(doc: Document, value: unknown): Record<string, unknown> {
  const node = object(value);
  if (typeof node.$ref !== 'string') return node;
  if (!node.$ref.startsWith('#/')) throw new AxiError('invalid_schema', 'Only local OpenAPI references are supported');
  let resolved: unknown = doc;
  for (const key of node.$ref.slice(2).split('/')) resolved = object(resolved)[key.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (!resolved) throw new AxiError('invalid_schema', 'Unresolved OpenAPI reference');
  return object(resolved);
}
export function operations(doc: Document): Operation[] {
  const result: Operation[] = []; const ids = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      if (!item[method]) continue;
      const definition = object(item[method]);
      const id = definition.operationId;
      if (typeof id !== 'string' || ids.has(id)) throw new AxiError('invalid_schema', 'Operations need unique operationId values');
      ids.add(id);
      const parameters = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(definition.parameters) ? definition.parameters : [])].map(p => resolveRef(doc, p) as unknown as Parameter);
      result.push({ id, method: method.toUpperCase(), path, tags: Array.isArray(definition.tags) ? definition.tags.map(String) : [], summary: String(definition.summary ?? ''), parameters, definition });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
let cached: Document | undefined;
export function loadSchema(): Document {
  return cached ??= parseDocument(JSON.parse(gunzipSync(readFileSync(new URL('../schema/openapi.json.gz', import.meta.url))).toString('utf8')));
}
export function schemaMetadata(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL('../schema/metadata.json', import.meta.url), 'utf8'));
}
export class Registry {
  readonly operations: Operation[];
  private byId: Map<string, Operation>;
  constructor(readonly document = loadSchema()) {
    this.operations = operations(document); this.byId = new Map(this.operations.map(op => [op.id, op]));
  }
  get(id: string): Operation {
    const op = this.byId.get(id);
    if (!op) throw new AxiError('unknown_operation', 'Operation not found in the pinned schema', ['posthog-axi api operations --search <term>']);
    return op;
  }
  describe(id: string) {
    const op = this.get(id);
    const body = resolveRef(this.document, op.definition.requestBody);
    return { operation: op.id, method: op.method, path: op.path, description: op.definition.description ?? op.summary, parameters: op.parameters,
      request_body: { ...body, content: Object.fromEntries(Object.entries(object(body.content)).map(([type, media]) => [type, { ...object(media), schema: resolveRef(this.document, object(media).schema) }])) },
      responses: op.definition.responses, security: op.definition.security,
      help: ['Use api schema <name> to inspect nested component schemas.', 'Use --param name=value for path values and --query name=value for query parameters.'] };
  }
}
export function buildPath(op: Operation, values: Record<string, string>, project: string): string {
  const used = new Set<string>();
  const path = op.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    used.add(name);
    const value = values[name] ?? (name === 'project_id' ? project : undefined);
    if (!value || value === '.' || value === '..' || /[\\/\x00-\x1f]/.test(value)) throw new AxiError('invalid_parameter', `Provide a valid path value for ${name}`, [`--param ${name}=<value>`]);
    return encodeURIComponent(value);
  });
  if (Object.keys(values).some(k => !used.has(k))) throw new AxiError('unknown_parameter', 'A supplied path parameter does not belong to this operation');
  return path;
}
export function driftReport(local: Document, live: Document) {
  const before = new Map(operations(local).map(op => [op.id, hash(op)]));
  const after = new Map(operations(live).map(op => [op.id, hash(op)]));
  const added = [...after.keys()].filter(k => !before.has(k));
  const removed = [...before.keys()].filter(k => !after.has(k));
  const changed = [...after.keys()].filter(k => before.has(k) && before.get(k) !== after.get(k));
  const componentChanges: string[] = [];
  const lc = object(local.components), rc = object(live.components);
  for (const section of new Set([...Object.keys(lc), ...Object.keys(rc)])) {
    const a = object(lc[section]), b = object(rc[section]);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (hash(a[key]) !== hash(b[key])) componentChanges.push(`${section}/${key}`);
  }
  return { drift: hash(local) !== hash(live), local_hash: hash(local), live_hash: hash(live), live_version: live.info.version, added, removed, changed, component_changes: componentChanges,
    note: 'Changed lists inline operation contracts; component_changes includes referenced schema changes. Drift is not a server compatibility guarantee.' };
}
