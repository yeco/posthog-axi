import { Args, integer } from './args.js';
import { configPath, logout, promptKey, promptLine, resolveConfig, saveConfig } from './config.js';
import { AxiError, errorOutput, object, usage } from './errors.js';
import { execute, inputFile, REQUEST_FLAGS } from './execute.js';
import { Client, normalizeHost } from './http.js';
import { render } from './output.js';
import { resourceCommand, resources } from './resources.js';
import { buildPath, driftReport, parseDocument, Registry, resolveRef, schemaMetadata } from './schema.js';
import { VERSION } from './version.js';

const HELP = {
  usage: 'posthog-axi [command] [args] [options]',
  commands: ['(none): connection and project home', 'login | logout | auth', 'flags | experiments | surveys | actions | cohorts | insights | dashboards', 'annotations | persons | events | recordings | projects | early-access | schedules', 'query <SQL> | query status <id> | query cancel <id>', 'api resources | api operations | api describe <operation> | api schema <name> | api call <operation>', 'api-version [--offline] [--check]'],
  options: ['--host <https-origin> --project <id>', '--full (all returned fields) --json (full JSON) --all (every page)', '--data <json> | --input <file|-> --confirm (required for writes)', '--param name=value --query name=value --header name=value (repeatable)', '--timeout <milliseconds> (default 60000; query 180000)'],
  help: ['Resource --help lists its operations, including non-CRUD actions.', 'api describe exposes parameters and body schema before a call.', 'Target: login saves host and project; --host/--project or POSTHOG_HOST/POSTHOG_PROJECT_ID override. Personal key: login or POSTHOG_API_KEY.'],
};
export interface Runtime { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; prompt?: (question: string, hidden: boolean) => Promise<string>; }
export async function run(argv: string[], runtime: Runtime = {}): Promise<{ output: string; code: number }> {
  let args: Args | undefined; let key: string | undefined;
  try {
    args = new Args(argv);
    const env = runtime.env ?? process.env;
    const command = args.words[0];
    const output = (value: unknown, code = 0) => ({ output: render(value, { full: args!.has('full'), json: args!.has('json'), secrets: [key ?? '', env.POSTHOG_API_KEY ?? ''] }), code });
    if (args.has('version')) { args.allow(['version']); args.count(0); return output({ version: VERSION }); }
    if (args.has('help') && !command) return output(HELP);
    if (command === 'login' && args.has('help')) return output({ usage: 'posthog-axi login [--host <origin>] [--project <id>]', note: 'Prompts for host (default https://us.posthog.com), project ID and a hidden key; saved at ~/.config/posthog-axi/config.json with mode 0600. Environment overrides never persist automatically.' });
    if (command === 'api' && args.has('help')) return output({ usage: 'api resources | operations [--search <text>] | describe <operation> | schema <name> | call <operation>', request: REQUEST_FLAGS, help: ['Path values: --param name=value. Query values: --query name=value.', 'JSON: --data or --input. Multipart: --form name=value --file-field name=path.', 'Binary: --raw file --content-type <type>. Responses retain text or base64 bytes.'] });
    if (command === 'query' && args.has('help')) return output({ usage: 'query <SQL> | query --file <file|-> | query status <id> | query cancel <id> --confirm', options: ['--refresh <blocking|async|...> --name <label> --full --json'] });
    if (command === 'api-version' && args.has('help')) return output({ usage: 'api-version [--offline] [--check]', note: 'Reports the pinned snapshot and compares live /api/schema/ without credentials. --check exits 3 on drift; --offline makes no request.' });
    if (command === 'api-version' && args.has('offline')) {
      args.allow(['offline', 'check']); args.count(1);
      if (args.has('check')) usage('--check needs a live comparison; omit --offline');
      return output({ target: schemaMetadata(), comparison: 'not_requested' });
    }
    const registry = new Registry();
    if (command === 'api' && args.words[1] !== 'call') {
      const action = args.words[1];
      if (action === 'operations') {
        args.allow(['search', 'limit', 'offset']); args.count(2);
        const search = args.get('search')?.toLowerCase() ?? '';
        const matches = registry.operations.filter(op => `${op.id} ${op.path} ${op.tags.join(' ')} ${op.summary}`.toLowerCase().includes(search));
        const limit = integer(args.get('limit'), args.has('full') || args.has('json') ? matches.length || 1 : 20, 1, 10000);
        const offset = integer(args.get('offset'), 0, 0, 100000);
        return output({ total: matches.length, operations: matches.slice(offset, offset + limit).map(op => ({ operation: op.id, method: op.method, path: op.path })), next_offset: offset + limit < matches.length ? offset + limit : null });
      }
      if (action === 'resources') { args.allow([]); args.count(2); return output({ resources: resources(registry), help: ['Organization and global operations: api operations --search organizations (or any term).'] }); }
      if (action === 'describe') { args.allow([]); args.count(3); return output(registry.describe(args.words[2]!)); }
      if (action === 'schema') {
        args.allow([]); args.count(3);
        const name = args.words[2]!;
        const node = object(registry.document.components?.schemas)[name];
        if (!node) usage('Unknown component schema name');
        return output({ name, schema: resolveRef(registry.document, node) });
      }
      usage('Expected api resources, operations, describe, schema or call');
    }
    if (command && resources(registry).includes(command) && args.has('help')) return output(await resourceCommand(registry, new Client('https://us.posthog.com'), command, args, ''));
    if (command === 'logout') {
      args.allow([]); args.count(1); await logout(configPath(env));
      return output({ status: 'logged_out', note: 'Saved credentials removed; POSTHOG_API_KEY, if set, remains active.' });
    }
    if (command === 'login') {
      args.allow(['host', 'project']); args.count(1);
      const ask = runtime.prompt ?? ((question: string, hidden: boolean) => hidden ? promptKey() : promptLine(question));
      const host = normalizeHost(args.get('host') ?? ((await ask('PostHog host [https://us.posthog.com]: ', false)).trim() || 'https://us.posthog.com'));
      const project = args.get('project') ?? (await ask('Project ID: ', false)).trim();
      if (!/^\d+$/.test(project)) throw new AxiError('invalid_project', 'Project must be a numeric ID');
      const entered = await ask('Personal API key (hidden): ', true); key = entered;
      await new Client(host, entered, runtime.fetch).request('GET', '/api/users/@me/');
      await saveConfig(configPath(env), { host, project, key: entered });
      return output({ status: 'logged_in', host, project, note: 'Credential stored privately. Environment overrides still take precedence.' });
    }
    const config = await resolveConfig({ host: args.get('host'), project: args.get('project') }, env); key = config.key;
    const client = new Client(config.host, key, runtime.fetch, integer(args.get('timeout'), command === 'query' ? 180000 : 60000, 1, 600000));
    if (command === 'auth') { args.allow([]); args.count(1); return output({ host: config.host, project: config.project ?? null, auth: config.auth, note: 'Local credential presence, not a live authentication check.' }); }
    if (command === 'api-version') {
      args.allow(['offline', 'check']); args.count(1);
      const target = schemaMetadata();
      const live = parseDocument(await client.request('GET', '/api/schema/', { public: true }));
      const report = driftReport(registry.document, live);
      return output({ target, ...report }, args.has('check') && report.drift ? 3 : 0);
    }
    if (command === 'api') {
      args.allow(REQUEST_FLAGS); args.count(3);
      return output(await execute(registry, client, registry.get(args.words[2]!), args, config.project ?? ''));
    }
    if (command === 'query') {
      args.allow(['file', 'name', 'refresh', 'confirm']);
      const action = args.words[1];
      if (action === 'status' || action === 'cancel') {
        args.count(3); if (args.has('file') || args.has('refresh') || args.has('name')) usage('Query status/cancel accepts only its ID');
        const copy = new Args([]); copy.flags.set('param', [`id=${args.words[2]}`]); if (args.has('confirm')) copy.flags.set('confirm', ['true']);
        return output(await execute(registry, client, registry.get(action === 'status' ? 'query_retrieve' : 'query_destroy'), copy, config.project ?? ''));
      }
      args.count(args.has('file') ? 1 : 2);
      const sql = args.has('file') ? (await inputFile(args.get('file')!)).toString('utf8') : action!;
      if (!sql.trim()) usage('SQL cannot be empty');
      const result = await client.request('POST', buildPath(registry.get('query_create'), {}, config.project ?? ''), { contentType: 'application/json', body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql }, ...(args.get('name') ? { name: args.get('name') } : {}), ...(args.get('refresh') ? { refresh: args.get('refresh') } : {}) }) });
      return output(result);
    }
    if (command) return output(await resourceCommand(registry, client, command, args, config.project ?? ''));
    args.allow([]); args.count(0);
    const home: Record<string, unknown> = { tool: 'posthog-axi', version: VERSION, host: config.host, project: config.project ?? null, auth: config.auth, operations: registry.operations.length };
    if (key && config.project) {
      try { home.recent_flags = await client.request('GET', `/api/projects/${config.project}/feature_flags/?limit=3`); }
      catch (e) { home.connection = errorOutput(e); }
    }
    home.help = [key && config.project ? 'flags list | experiments list | query "select 1"' : config.auth === 'environment' ? 'Set POSTHOG_PROJECT_ID or pass --project; POSTHOG_API_KEY bypasses the saved login' : 'posthog-axi login', 'api resources | api operations --search <term>', 'api-version compares this build with the live API schema'];
    return output(home);
  } catch (e) {
    const code = object(e).code === 'usage' ? 2 : 1;
    return { output: render(errorOutput(e), { json: args?.has('json'), full: true, secrets: [key ?? '', runtime.env?.POSTHOG_API_KEY ?? process.env.POSTHOG_API_KEY ?? ''] }), code };
  }
}
