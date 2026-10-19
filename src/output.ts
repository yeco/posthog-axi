import { encode } from '@toon-format/toon';
const sensitive = /(^|[_-])(authorization|cookie|password|secret|token|api_key)([_-]|$)/i;
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let safe = value.replace(/phx_[A-Za-z0-9_-]+/g, '[redacted]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join('[redacted]');
    return safe;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [String(redact(k, secrets)), sensitive.test(k.replace(/([a-z0-9])([A-Z])/g, '$1_$2')) ? '[redacted]' : redact(v, secrets)]));
  return value;
}
export function render(value: unknown, options: { full?: boolean; json?: boolean; secrets?: string[] } = {}): string {
  let safe = redact(value, options.secrets);
  const omitted: string[] = [];
  function compact(v: unknown, path: string, depth: number): unknown {
    if (typeof v === 'string' && v.length > 240) { omitted.push(path); return v.slice(0, 240) + '...'; }
    if (Array.isArray(v)) {
      if (v.length > 20) omitted.push(`${path}: ${v.length - 20} more items`);
      return v.slice(0, 20).map((item, i) => compact(item, `${path}[${i}]`, depth + 1));
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v);
      if (depth > 5) { omitted.push(path); return '[nested object; use --full]'; }
      if (entries.length > 16) omitted.push(`${path}: ${entries.length - 16} more fields`);
      return Object.fromEntries(entries.slice(0, 16).map(([k, item]) => [k, compact(item, path ? `${path}.${k}` : k, depth + 1)]));
    }
    return v;
  }
  if (!options.full && !options.json) {
    safe = compact(safe, '', 0);
    if (omitted.length) safe = { data: safe, truncated: omitted.slice(0, 20), help: ['Use --full for all returned fields and rows; --all fetches every page.'] };
  }
  return (options.json ? JSON.stringify(safe, null, 2) : encode(safe)) + '\n';
}
