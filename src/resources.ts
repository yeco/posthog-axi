import { Args, integer, pairs } from './args.js';
import { AxiError, object, usage } from './errors.js';
import { execute, jsonBody, requireConfirmation, REQUEST_FLAGS, subset } from './execute.js';
import { Client } from './http.js';
import { buildPath, Registry, type Operation } from './schema.js';

const aliases: Record<string, string> = {
  flags: 'feature_flags', recordings: 'session_recordings', 'early-access': 'early_access_feature', schedules: 'scheduled_changes',
};
export function resourceRoot(name: string): string {
  if (name === 'projects') return '/api/organizations/{organization_id}/projects/';
  return `/api/projects/{project_id}/${aliases[name] ?? name.replaceAll('-', '_')}/`;
}
export function resourceOperations(registry: Registry, name: string): Operation[] {
  const root = resourceRoot(name);
  return registry.operations.filter(op => op.path.startsWith(root));
}
export function resources(registry: Registry): string[] {
  const names = new Set(['projects']);
  for (const op of registry.operations) {
    const match = /^\/api\/projects\/\{project_id\}\/([^/{]+)\//.exec(op.path);
    if (match) names.add(Object.entries(aliases).find(([, v]) => v === match[1])?.[0] ?? match[1]!.replaceAll('_', '-'));
  }
  return [...names].sort();
}
export function verb(op: Operation, root: string): string {
  const detail = /^\{[^}]+\}\/$/.test(op.path.slice(root.length));
  if (op.path === root || detail) {
    const standard = { GET: detail ? 'show' : 'list', POST: 'create', PATCH: 'update', PUT: 'replace', DELETE: 'delete' }[op.method];
    if (standard) return standard;
  }
  // The exact operation ID is unambiguous even for deeply nested actions.
  return op.id;
}
function detailPath(root: string, id: unknown): string {
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id) || /[\\/]/.test(String(id)) || ['.', '..'].includes(String(id))) usage('Expected a resource ID');
  return root + encodeURIComponent(String(id)) + '/';
}
async function patchState(client: Client, path: string, desired: Record<string, unknown>, flag: boolean, current?: Record<string, unknown>) {
  const before = current ?? object(await client.request('GET', path));
  if (subset(desired, before)) return { status: 'unchanged', result: before };
  const payload = flag ? { ...desired, version: before.version ?? null } : desired;
  const result = await client.request('PATCH', path, { contentType: 'application/json', body: JSON.stringify(payload) });
  return { status: 'updated', result };
}
export async function resourceCommand(registry: Registry, client: Client, name: string, args: Args, project: string): Promise<unknown> {
  const ops = resourceOperations(registry, name), root = resourceRoot(name);
  if (!ops.length) throw new AxiError('unknown_command', 'Unknown resource', ['posthog-axi api resources']);
  const action = args.words[1] ?? 'list';
  if (args.has('help')) return { resource: name, operations: ops.map(op => ({ command: verb(op, root), method: op.method, path: op.path })), help: ['<resource> list|show ID|create|update ID|replace ID|delete ID', 'Bodies: --data <json> or --input <file|->. Mutations: --confirm.', 'Create with --ensure <field> for sequential reconciliation. Use api describe <operation> for its contract.', 'Nonstandard actions use the exact operation ID as the subcommand.'] };
  if (name === 'flags' && ['enable', 'disable', 'rollout', 'ensure'].includes(action)) return flagCommand(registry, client, args, project);
  const op = ops.find(op => verb(op, root) === action || op.id === action);
  if (!op) throw new AxiError('unknown_action', 'Action not found for resource', [`posthog-axi ${name} --help`]);
  const directQuery = op.parameters.filter(p => p.in === 'query').map(p => p.name.replaceAll('_', '-'));
  args.allow([...REQUEST_FLAGS, ...directQuery, 'ensure']);
  const idParams = [...op.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!).filter(p => p !== 'project_id' && p !== 'organization_id');
  args.count(1, 3);
  const extra = [...args.many('param')];
  if (args.words[2] !== undefined) {
    if (!idParams[0]) usage('This action has no positional ID');
    extra.push(`${idParams[0]}=${args.words[2]}`);
  }
  const forwarded = new Args([]);
  for (const [k, v] of args.flags) if (!directQuery.includes(k) && k !== 'ensure') forwarded.flags.set(k, v);
  forwarded.flags.set('param', extra);
  const query = [...args.many('query')];
  for (const p of op.parameters.filter(p => p.in === 'query')) {
    const v = args.get(p.name.replaceAll('_', '-')); if (v !== undefined) query.push(`${p.name}=${v}`);
  }
  if (action === 'list' && op.parameters.some(p => p.name === 'limit') && !pairs(query).some(([k]) => k === 'limit')) query.push('limit=20');
  forwarded.flags.set('query', query);
  requireConfirmation(args, op.method);
  const path = buildPath(op, Object.fromEntries(pairs(extra)), project);
  const jsonOnly = args.has('data') || args.has('input');
  if (args.has('ensure')) {
    if (action !== 'create' || !jsonOnly) usage('--ensure is for create with a JSON body');
    if (query.length || args.has('raw') || args.has('form') || args.has('file-field') || args.has('header')) usage('--ensure accepts only JSON body and connection options');
    const field = args.get('ensure')!; const desired = object(await jsonBody(args));
    if (!['string', 'number'].includes(typeof desired[field]) || desired[field] === '') usage('--ensure needs a nonempty string or number body field');
    const list = ops.find(o => o.path === root && o.method === 'GET');
    const patch = ops.find(o => verb(o, root) === 'update');
    if (!list || !patch) usage('This resource cannot reconcile; use explicit create');
    const all = await client.pages(path, true);
    const rows = Array.isArray(all) ? all : object(all).results;
    if (!Array.isArray(rows)) throw new AxiError('invalid_response', 'Expected a resource list');
    const matches = rows.map(object).filter(row => row[field] === desired[field]);
    if (matches.length > 1) throw new AxiError('ambiguous_match', 'Multiple objects have this identity; use an explicit ID');
    if (matches[0]) return patchState(client, detailPath(path, matches[0].id), desired, name === 'flags', matches[0]);
  } else if (action === 'update' && jsonOnly) {
    if (args.has('raw') || args.has('form') || args.has('file-field') || args.has('header') || query.length) usage('Reconciled updates accept JSON only; use api call for other encodings or headers');
    const desired = await jsonBody(args);
    if (!desired || typeof desired !== 'object' || Array.isArray(desired)) usage('Update body must be a JSON object');
    return patchState(client, path, object(desired), name === 'flags');
  }
  try { return await execute(registry, client, op, forwarded, project); }
  catch (e) { if (action === 'delete' && e instanceof AxiError && e.status === 404) return { status: 'unchanged', reason: 'already absent' }; throw e; }
}

async function flagCommand(registry: Registry, client: Client, args: Args, project: string): Promise<unknown> {
  const action = args.words[1];
  if (action === 'ensure') {
    args.allow(['data', 'input', 'confirm']); args.count(2);
    const desired = object(await jsonBody(args)); if (typeof desired.key !== 'string' || !desired.key) usage('flags ensure requires a JSON key field');
    const copy = new Args([]); copy.words.push('flags', 'create'); for (const [k, v] of args.flags) copy.flags.set(k, v); copy.flags.set('ensure', ['key']);
    return resourceCommand(registry, client, 'flags', copy, project);
  }
  args.allow(['confirm', 'condition']); args.count(action === 'rollout' ? 4 : 3);
  if (action !== 'rollout' && args.has('condition')) usage('--condition is only for rollout');
  requireConfirmation(args, 'POST');
  const op = registry.get('feature_flags_retrieve');
  const path = buildPath(op, { id: args.words[2]! }, project);
  const current = object(await client.request('GET', path));
  if (action !== 'rollout') return patchState(client, path, { active: action === 'enable' }, true, current);
  const percentage = Number(args.words[3]);
  if (!args.words[3]?.trim() || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) usage('Rollout percentage must be from 0 to 100');
  const condition = integer(args.get('condition'), 0, 0, 10000);
  const groups = object(current.filters).groups;
  if (!Array.isArray(groups) || !groups[condition]) usage('Release condition does not exist; inspect flags show ID --full');
  if (object(groups[condition]).rollout_percentage === percentage) return { status: 'unchanged', result: current };
  const result = await client.request('POST', path + 'set_release_condition_rollout/', { contentType: 'application/json', body: JSON.stringify({ condition_index: condition, rollout_percentage: percentage, version: current.version ?? null }) });
  return { status: 'updated', result };
}
