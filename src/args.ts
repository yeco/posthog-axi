import { usage } from './errors.js';
const booleans = new Set(['help', 'full', 'json', 'all', 'confirm', 'offline', 'check', 'version']);
const repeated = new Set(['param', 'query', 'header', 'form', 'file-field']);
export class Args {
  readonly words: string[] = [];
  readonly flags = new Map<string, string[]>();
  constructor(argv: string[]) {
    for (let i = 0; i < argv.length; i++) {
      let word = argv[i]!;
      if (word === '--') { this.words.push(...argv.slice(i + 1)); break; }
      if (word === '-h') word = '--help';
      if (word === '-v' || word === '-V') word = '--version';
      if (!word.startsWith('--')) { if (word.startsWith('-')) usage('Unknown short option'); this.words.push(word); continue; }
      const equal = word.indexOf('=');
      const name = word.slice(2, equal < 0 ? undefined : equal);
      if (!/^[a-z][a-z0-9-]*$/.test(name)) usage('Invalid option name');
      let value = 'true';
      if (booleans.has(name)) { if (equal >= 0) usage('Boolean options do not accept values'); }
      else if (equal >= 0) value = word.slice(equal + 1);
      else { const next = argv[++i]; if (next === undefined || next.startsWith('--')) usage(`--${name} needs a value`); value = next; }
      if (this.flags.has(name) && !repeated.has(name)) usage(`--${name} may only be given once`);
      this.flags.set(name, [...(this.flags.get(name) ?? []), value]);
    }
  }
  get(name: string): string | undefined { return this.flags.get(name)?.[0]; }
  has(name: string): boolean { return this.flags.has(name); }
  many(name: string): string[] { return this.flags.get(name) ?? []; }
  allow(names: string[]) {
    const allowed = new Set(['host', 'project', 'full', 'json', 'help', 'timeout', ...names]);
    for (const name of this.flags.keys()) if (!allowed.has(name)) usage(`Unknown option --${name}`);
  }
  count(min: number, max = min) { if (this.words.length < min || this.words.length > max) usage('Unexpected or missing positional arguments'); }
}
export function pairs(values: string[]): [string, string][] {
  return values.map(value => { const i = value.indexOf('='); if (i < 1) usage('Expected name=value'); return [value.slice(0, i), value.slice(i + 1)]; });
}
export function uniquePairs(values: string[]): Record<string, string> {
  const entries = pairs(values); if (new Set(entries.map(([k]) => k)).size !== entries.length) usage('Duplicate parameter name');
  return Object.fromEntries(entries);
}
export function integer(value: string | undefined, fallback: number, min = 1, max = 1000): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) usage(`Expected an integer from ${min} to ${max}`);
  return Number(value);
}
