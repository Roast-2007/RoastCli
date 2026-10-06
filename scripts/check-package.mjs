import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Inspect npm's actual publish list; never read or print local credential values.
// npm 10 can run prepare during a dry run; keep lifecycle output away from JSON.
const npmArgs = ['pack', '--dry-run', '--json', '--ignore-scripts', '--foreground-scripts=false'];
const output = process.platform === 'win32'
  ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs], { encoding: 'utf8', windowsHide: true })
  : execFileSync('npm', npmArgs, { encoding: 'utf8' });
const [pack] = JSON.parse(output);
const paths = pack.files.map((file) => file.path);
const allowed = /^(dist\/|docs\/USAGE\.md$|README\.md$|LICENSE$|package\.json$)/;
assert.ok(paths.includes('dist/cli.js'), 'Missing compiled CLI');
assert.ok(paths.includes('LICENSE'), 'Missing license');
for (const path of paths) {
  assert.ok(allowed.test(path), `Unexpected package file: ${path}`);
  if (path.startsWith('dist/')) {
    const text = readFileSync(path, 'utf8');
    assert.ok(!/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+[\\/]|[A-Za-z]:[\\/]Personal Files[\\/]RoastCli|\/Users\/[^/\s"']+\//i.test(text), `Private build path in ${path}`);
  }
}
console.log(`Package check passed: ${pack.name}@${pack.version}, ${paths.length} approved files.`);
