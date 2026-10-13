import { readEvents } from './stream.js';
import { AxiError, object } from './errors.js';

export function normalizeHost(host: string): string {
  let url: URL;
  try { url = new URL(host); } catch { throw new AxiError('invalid_host', 'Host must be an HTTPS origin'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AxiError('invalid_host', 'Use an HTTPS origin without credentials, path, query or fragment (HTTP allowed only on loopback)');
  }
  return url.origin;
}

export interface RequestOptions {
  body?: BodyInit;
  contentType?: string;
  headers?: Record<string, string>;
  public?: boolean;
  maxEvents?: number;
}

export class Client {
  readonly host: string;
  constructor(host: string, private key?: string, private fetcher: typeof fetch = fetch, private timeout = 60_000) {
    this.host = normalizeHost(host);
  }

  url(path: string): URL {
    let url: URL;
    try { url = new URL(path, this.host); } catch { throw new AxiError('unsafe_url', 'Invalid request URL'); }
    if (url.origin !== this.host || url.username || url.password || url.hash || !url.pathname.startsWith('/api/')) {
      throw new AxiError('unsafe_url', 'Request and pagination URLs must stay on the configured host under /api/');
    }
    return url;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = this.url(path);
    if (!options.public && !this.key) throw new AxiError('auth_required', 'No personal API key configured', ['posthog-axi login', 'Or set POSTHOG_API_KEY in the environment']);
    const headers = new Headers(options.headers);
    for (const name of ['authorization', 'cookie', 'host', 'proxy-authorization']) {
      if (headers.has(name)) throw new AxiError('unsafe_header', 'Authentication and routing headers cannot be overridden');
    }
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (!options.public) headers.set('Authorization', `Bearer ${this.key}`);
    if (options.contentType) headers.set('Content-Type', options.contentType);
    // No automatic retries: a lost response may already have committed a write.
    try {
      const response = await this.fetcher(url, { method, headers, body: options.body, redirect: 'manual', signal: AbortSignal.timeout(this.timeout) });
      if (response.status >= 300 && response.status < 400) throw new AxiError('redirect_refused', 'PostHog redirected the request; verify --host before retrying', [], response.status);
      if (!response.ok) {
        // Server error bodies may echo credentials or submitted sensitive values.
        await response.body?.cancel();
        const code = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' : response.status === 429 ? 'rate_limited' : 'http_error';
        const help = response.status === 403 ? ['Check the personal key scopes for this operation.'] : response.status === 409 ? ['Read the current state and reconcile before retrying.'] : ['Check the operation schema with posthog-axi api describe <operation>.'];
        throw new AxiError(code, `PostHog returned HTTP ${response.status}`, help, response.status, response.headers.get('retry-after') ?? undefined);
      }
      if (response.status === 204 || method === 'HEAD') return null;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) return await readEvents(response, options.maxEvents ?? 20);
      if (contentType.includes('json')) {
        try { return await response.json(); } catch { throw new AxiError('invalid_response', 'PostHog returned malformed JSON'); }
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (contentType.startsWith('text/')) return { content_type: contentType, text: bytes.toString('utf8') };
      return { content_type: contentType, encoding: 'base64', bytes: bytes.length, data: bytes.toString('base64') };
    } catch (e) {
      if (e instanceof AxiError) throw e;
      const timeout = e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name);
      throw new AxiError(timeout ? 'timeout' : 'network_error', timeout ? 'Request timed out' : 'Could not reach PostHog', ['Check --host and connectivity. Writes are not retried; verify state before repeating.']);
    }
  }

  async pages(path: string, all = false, options: RequestOptions = {}): Promise<unknown> {
    let next: string | undefined = path;
    const seen = new Set<string>();
    const results: unknown[] = [];
    let first: Record<string, unknown> | undefined;
    while (next) {
      const url = this.url(next).href;
      if (seen.has(url) || seen.size >= 1000) throw new AxiError('pagination_limit', 'Repeated cursor or 1000-page safety limit reached', ['Use a narrower filter.']);
      seen.add(url);
      const response = await this.request('GET', url, options);
      const page = object(response);
      if (!all || !Array.isArray(page.results)) return response;
      first ??= page;
      results.push(...page.results);
      next = typeof page.next === 'string' && page.next ? page.next : undefined;
    }
    return { ...first, results, next: null, pages: seen.size };
  }
}
