import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = pack.files.map(file => file.path);
for (const file of files) assert.ok(/^(dist\/[^/]+\.(js|d\.ts)|schema\/(openapi\.json\.gz|metadata\.json|coverage\.json)|skills\/posthog-axi\/SKILL\.md|package\.json|README\.md|LICENSE)$/.test(file), `Unexpected packed file: ${file}`);
for (const file of ['dist/bin.js', 'schema/openapi.json.gz', 'schema/metadata.json', 'schema/coverage.json', 'skills/posthog-axi/SKILL.md', 'LICENSE']) assert.ok(files.includes(file), `Missing packed file: ${file}`);
console.log(`package: ${pack.name}@${pack.version}; ${files.length} intended files; ${pack.size} bytes packed`);
