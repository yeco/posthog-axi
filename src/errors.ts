export class AxiError extends Error {
  constructor(
    public code: string,
    message: string,
    public help: string[] = [],
    public status?: number,
    public retryAfter?: string,
  ) { super(message); }
}

export function errorOutput(error: unknown) {
  const e = error instanceof AxiError ? error : new AxiError('internal_error', 'Unexpected failure', ['Retry with a minimal request; report the command without credentials.']);
  return { error: { code: e.code, message: e.message, status: e.status, retry_after: e.retryAfter }, help: e.help };
}

export function usage(message: string): never {
  throw new AxiError('usage', message, ['posthog-axi --help']);
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
