# Implementation contract

The schema is the API source of truth. Begin a change at the owning boundary:

| Change | Owner |
| --- | --- |
| New endpoint or changed request contract | `src/schema.ts`, `schema/metadata.json` |
| Credential persistence or target precedence | `src/config.ts` |
| Outbound requests, pagination, redirects | `src/http.ts` |
| Resource-specific state reconciliation | `src/resources.ts` |
| Request encodings and confirmation policy | `src/execute.ts` |
| CLI routing and discovery | `src/cli.ts` |
| Redaction and compact/full output | `src/output.ts` |

Keep operation discovery offline. Keep the single transport boundary responsible for host validation and bearer attachment. Never follow server-provided destinations across origins or automatically retry writes. Errors expose status and recovery guidance instead of echoing server bodies, credentials or request payloads.

Read the current resource before reconciling a mutation. Feature flag changes use the current server version. Resource PATCH comparisons are recursive subsets for objects and exact comparisons for arrays; document any different equality rule alongside the command that needs it. Generic operations preserve the server contract and make no exactly-once promise.

For schema refreshes, run the schema update script against an explicitly selected host, without credentials. Review the metadata and coverage diff, inspect changed component definitions, then exercise changed request paths through mocked HTTP. Commit the snapshot, metadata and coverage manifest together. The metadata separates the original decompressed byte digest from the canonical document digest.

Tests execute CLI or transport behavior. The exhaustive routing test is evidence that every pinned method/path can be called, not evidence that every PostHog business workflow was exercised against a live tenant. Add focused request and failure-mode tests for behavior you change. CI and package checks must work without a real API key.

Use Conventional Commits as each working slice lands. Keep runtime dependencies small. Use package scripts for the current validation commands; the pack check invokes npm itself and rejects files outside the publication allowlist. Publishing and replacing a user's installed binary are explicit operator actions, never install hooks.
