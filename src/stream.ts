import { AxiError } from './errors.js';

/** Finite SSE inspection: stop after N events instead of waiting for an endless response. */
export async function readEvents(response: Response, limit: number): Promise<unknown> {
  if (!response.body) return { events: [], stream: 'ended' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  const events: Record<string, unknown>[] = [];
  try {
    while (events.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new AxiError('stream_limit', 'SSE sample exceeded 16 MiB; use a smaller --max-events');
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0 && events.length < limit) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const event: Record<string, unknown> = {}; const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':'); const name = colon < 0 ? line : line.slice(0, colon);
          const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (name === 'data') data.push(val);
          else if (['id', 'event', 'retry'].includes(name)) event[name] = val;
        }
        if (data.length) {
          const text = data.join('\n'); try { event.data = JSON.parse(text); } catch { event.data = text; }
          events.push(event);
        }
      }
    }
    return { events, stream: events.length >= limit ? 'sample_limit' : 'ended', help: ['Resume supported endpoints with --header Last-Event-ID=<id>. --max-events controls sample size.'] };
  } catch (e) {
    if (events.length && e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name)) return { events, stream: 'timeout', help: ['Partial SSE sample; resume with the last event ID.'] };
    throw e;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
