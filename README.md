# posthog-axi

posthog-axi is my PostHog CLI for AI agents and scripts. It can call every operation in PostHog's published OpenAPI schema, run HogQL queries, and manage feature flags, experiments, surveys and a few other common resources (writes need `--confirm`, and `ensure` and `update` are meant to be run more than once).

I wanted PostHog to fit the way I work with agents: inspect what's available, make a small request, and get enough context to decide what to do next. This is my CLI for that workflow.

It targets PostHog's published OpenAPI schema rather than a hand-maintained list of endpoints. The pinned snapshot has 2,409 operations across 1,801 paths. Every one has an `api call` command. Common resources also get shorter commands (feature flags deserved a few extra conveniences).

## Installing it and logging in

Requires Node.js 22 or newer. It's on npm:

```sh
npm install -g posthog-axi
posthog-axi login
posthog-axi
```

From a checkout:

```sh
npm ci --ignore-scripts
npm run build
node dist/bin.js --help
```

`login` asks for the host (default `https://us.posthog.com`), the project ID and a personal API key. It doesn't echo the key, verifies it with PostHog, and writes a 0600 file at `~/.config/posthog-axi/config.json`. `XDG_CONFIG_HOME` changes that base directory. There is no key argument to leak into shell history. Create a key with the scopes you need in [PostHog's personal API key settings](https://us.posthog.com/settings/user-api-keys).

There's no built-in project. Without a saved or supplied project, project commands fail with `missing_project` and tell you to run `posthog-axi login` or pass `--project` (or set `POSTHOG_PROJECT_ID` when the key comes from `POSTHOG_API_KEY`, which bypasses the saved login). Override the saved target explicitly:

```sh
posthog-axi flags list --host https://eu.posthog.com --project 123
posthog-axi auth
posthog-axi logout
```

For automation, provide `POSTHOG_API_KEY` through your secret environment, with optional `POSTHOG_HOST` and `POSTHOG_PROJECT_ID`. Flags override environment values. A supplied environment key bypasses saved credentials and uses the environment and flag connection settings. Without an environment key, saved settings apply unless a flag or environment variable overrides them. A saved key is bound to its host and is never reused for a different `--host`. `logout` removes the file; it cannot unset your environment.

No arguments gives a compact home with the selected target and, when authenticated, recent flags. An unavailable project or missing scope shows a connection error rather than an empty result.

## How do I find the right PostHog API operation?

```sh
posthog-axi api resources
posthog-axi api operations --search experiments
posthog-axi api describe experiments_create --full
posthog-axi api schema Experiment --full
posthog-axi experiments list
posthog-axi experiments show 123 --full
```

The short resource commands include flags, experiments, surveys, actions, cohorts, insights, dashboards, annotations, persons, events, recordings, projects, early-access and schedules. The schema also exposes many more areas, including batch exports, the data warehouse, Hog functions, workflows and organization settings. `api resources` discovers project resources; `api operations` searches the entire surface.

A resource's `--help` lists its available CRUD commands. Use the exact operation ID as a subcommand for its other actions, or use `api call` directly:

```sh
posthog-axi api call feature_flags_versions_retrieve \
  --param id=123 --param version_number=4
posthog-axi projects list --param organization_id=ORG_ID
posthog-axi api call organizations_projects_retrieve \
  --param organization_id=ORG_ID --param id=PROJECT_ID
```

The current schema places project administration under organizations, so those commands need an organization ID. Other project operations fill `project_id` from the selected project automatically.

`api describe` includes parameter and request-body definitions. Nested `$ref` values can be inspected with `api schema <name>`. The CLI checks routing and required parameters/body presence; PostHog validates the full request payload and permissions. Some schema operations need special authentication or enabled products. Being listed here does not grant access to them.

## Compact output, and what about pagination?

Output is [TOON](https://toonformat.dev). Compact mode previews long values and shows at most 20 items per array, with explicit omission notices. `--full` preserves all returned fields and rows. `--json` gives the full response as JSON. Both still redact known credential fields and the active personal key.

These options do different jobs:

```sh
posthog-axi persons list --limit 50 --full  # one API page, expanded output
posthog-axi persons list --all --json      # follow all pages
posthog-axi api operations --search surveys --limit 10 --offset 10
```

Pagination follows the server's cursor, stays on the selected host and stops on repeated cursors or after 1,000 pages. Use narrower filters for larger exports. Query parameters can always be passed as repeated `--query name=value`; resource shortcuts also accept their non-conflicting schema query names as kebab-case options.

## Feature flags and writes you can repeat

```sh
posthog-axi flags ensure --data '{"key":"new-checkout","name":"New checkout","active":false}' --confirm
posthog-axi flags enable 123 --confirm
posthog-axi flags rollout 123 25 --condition 0 --confirm
posthog-axi flags update 123 --data '{"name":"Checkout v2"}' --confirm
posthog-axi flags delete 123 --confirm
```

`enable`, `disable` and JSON `update` read current state and skip an already-applied change. Flag writes carry the current version; rollout changes one condition without replacing its neighbors or variant distribution. A version conflict requires a fresh read.

`create --ensure <field>` matches a stable field, then creates or updates. `flags ensure` uses the key field and also matches archived flags. If the match is archived and your body doesn't set `archived`, it returns `status: archived` with the unarchive command instead of changing anything. Multiple matches are an error, and deleting an already-absent object succeeds as unchanged. Ensure is sequential reconciliation, not a distributed lock: concurrent creates can race, and a resource without a unique server constraint can still get duplicates.

Plain create, replace and arbitrary `api call` mutations keep the API's semantics. They are not promised to be idempotent. All writes require `--confirm` and none are retried automatically. After a timeout, check the server state before repeating the request. HogQL execution is a read-oriented POST and does not need confirmation; cancelling a query does.

Schedules are their own resource:

```sh
posthog-axi api describe scheduled_changes_create --full
posthog-axi schedules create --input schedule.json --confirm
posthog-axi schedules show 456 --full
```

For example, `schedule.json` can contain:

```json
{
  "model_name": "FeatureFlag",
  "record_id": "123",
  "scheduled_at": "2027-01-15T14:00:00Z",
  "payload": { "operation": "update_status", "value": true }
}
```

Use a future time for your run. The schema describes recurrence and approval-related fields too.

## HogQL queries, uploads and the less common endpoints

```sh
posthog-axi query 'select event, count() from events group by event limit 10'
posthog-axi query --file report.sql --refresh async
posthog-axi query status QUERY_ID
posthog-axi query cancel QUERY_ID --confirm
posthog-axi api call surveys_create --input survey.json --confirm
```

`--input -` reads JSON from stdin. `query --file -` reads SQL. Generic calls also support multipart `--form name=value` and `--file-field name=path`, URL-encoded forms with `--content-type application/x-www-form-urlencoded`, or binary `--raw file`. `--header name=value` supplies endpoint-specific headers, but cannot replace authentication or routing headers.

Non-JSON responses retain text or base64-encoded bytes. Event streams return a bounded SSE sample (20 events by default, adjusted with `--max-events`), including IDs for resuming with `--header Last-Event-ID=<id>`. `--timeout` is in milliseconds, defaulting to 60 seconds or 180 seconds for queries.

Errors go to stdout as structured data. Exit codes are 0 for success, 1 for request/authentication failures, 2 for usage errors and 3 for drift under `api-version --check`. HTTP failures include the status and, for rate limits, `retry_after`. Server error bodies are deliberately omitted because they can echo sensitive input.

## Which PostHog API version does this build target?

```sh
posthog-axi api-version --offline
posthog-axi api-version --check --full
```

The snapshot comes from [PostHog's `/api/schema/`](https://us.posthog.com/api/schema/), fetched on 2026-10-19. It identifies itself as OpenAPI 3.1.0 and API version 1.0.0. That version alone is too coarse for compatibility, so `schema/metadata.json` also records the fetch timestamp and SHA-256 digests. The compressed snapshot contains the full document; `schema/coverage.json` maps every operation to its command.

`api-version` compares the configured host's live schema without sending credentials. It reports added, removed and changed inline operation contracts, plus changed shared components. `--check` fails on any drift; `--offline` only reports the local target. This detects a changed contract, not whether a particular query will succeed on your tenant.

Exhaustive here means every operation in this published schema is routable. It does not invent endpoints absent from the schema, cover SDK ingestion protocols, or claim every product workflow was tested against a live account. Runtime traffic stays on the configured host, redirects are refused, and there is no telemetry, self-update process or automatic agent-hook installation.

## Working on it locally

```sh
npm test
npm run lint
npm run schema:check
npm run pack:check
```

Tests use mocked HTTP and a loopback fixture server, never a real key. CI runs on Node 22 and 24. Refresh the snapshot deliberately with `npm run schema:update`, inspect the diff and commit the metadata with it. [CONTRIBUTING.md](https://github.com/yeco/posthog-axi/blob/main/CONTRIBUTING.md) describes the implementation boundaries. The agent workflow lives in `skills/posthog-axi/SKILL.md`; install that directory through your agent's skill mechanism if you want it available there.

For a release, run `npm pack --dry-run` and inspect what ships, then `npm publish --access public`. `prepublishOnly` builds, runs the tests and checks schema coverage. Publishing is a separate operator action.

## License

MIT. Copyright (c) 2026 Jasson Cascante.
