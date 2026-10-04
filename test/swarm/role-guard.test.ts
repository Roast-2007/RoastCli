import { describe, expect, it } from 'vitest';
import { isVerificationCommand } from '../../src/tools/permissions/bash-parse.js';
import { roleGuardHook } from '../../src/swarm/tools.js';
import { bashTool, writeTool } from '../../src/tools/index.js';
import { makeCtx } from '../tools/helpers.js';

describe('isVerificationCommand', () => {
  it('accepts test / typecheck / lint runners', () => {
    for (const cmd of ['pnpm test', 'npm run test -- --run', 'pnpm vitest run src', 'npx jest', 'pytest -q', 'python -m pytest tests', 'go test ./...', 'cargo clippy', 'pnpm exec tsc --noEmit', 'tsc -p . --noEmit', 'pnpm lint', 'eslint src']) {
      expect(isVerificationCommand(cmd), cmd).toBe(true);
    }
  });

  it('rejects auto-fix, snapshot updates, emitting builds and arbitrary commands', () => {
    for (const cmd of ['eslint --fix src', 'pnpm vitest -u', 'jest --updateSnapshot', 'prettier --write .', 'tsc', 'pnpm build', 'rm -rf dist', 'pnpm testing-tool']) {
      expect(isVerificationCommand(cmd), cmd).toBe(false);
    }
  });

  it('rejects output, trace, temporary-directory and installation flags', () => {
    for (const cmd of [
      'go test -o ../test.exe', 'go test -o../test.exe', 'pytest --basetemp=../src',
      'mypy --install-types', 'tsc --noEmit --generateTrace ../src',
      'jest --outputFile=../src/a.json', 'pnpm test --output ../src/a',
      'pnpm test "--outputFile=../src/a"', 'jest --json --output-file ../a',
      'tsc --noEmit false', 'tsc --noEmitOnError', 'tsc --noEmit=false', 'tsc --noEmit --incremental', 'tsc --noEmit --tsBuildInfoFile ../a',
      'go test -coverprofile=../a', 'pytest --junitxml=../a', 'eslint -f json -o ../a',
    ]) expect(isVerificationCommand(cmd), cmd).toBe(false);
    expect(isVerificationCommand('pnpm test tests/output.test.ts')).toBe(true);
  });
});

describe('roleGuardHook', () => {
  const ctx = makeCtx('/w');
  const judge = roleGuardHook('judge');

  it('lets read-only roles run verification inside a candidate worktree', async () => {
    expect(await judge(bashTool, { command: 'cd /wt/w1 && pnpm test' }, ctx)).toEqual({ action: 'allow' });
    expect(await judge(bashTool, { command: 'git diff && pnpm typecheck' }, ctx)).toEqual({ action: 'allow' });
  });

  it('still denies edits, writes via redirects and non-verification commands', async () => {
    expect((await judge(writeTool, { path: 'a.ts', content: 'x' }, ctx)).action).toBe('deny');
    expect((await judge(bashTool, { command: 'pnpm test > out.txt' }, ctx)).action).toBe('deny');
    expect((await judge(bashTool, { command: 'pnpm test && rm -rf src' }, ctx)).action).toBe('deny');
    expect((await judge(bashTool, { command: 'pnpm install' }, ctx)).action).toBe('deny');
  });

  it('denies output flags on otherwise read-only Git commands', async () => {
    for (const command of ['git diff --output=src/a.ts', 'git log --output src/a.ts', 'git show "--output=src/a.ts"']) {
      expect((await judge(bashTool, { command }, ctx)).action, command).toBe('deny');
    }
    expect((await judge(bashTool, { command: 'git diff -u' }, ctx)).action).toBe('allow');
  });

  it('does not restrict writer roles', async () => {
    expect(await roleGuardHook('worker')(bashTool, { command: 'pnpm install' }, ctx)).toEqual({ action: 'allow' });
  });
});

describe('cd is not globally read-only (M8 review H4)', () => {
  it('the permission engine still asks for cd-prefixed commands even with a matching allow rule', async () => {
    const { PermissionEngine } = await import('../../src/tools/permissions/engine.js');
    const engine = new PermissionEngine({ allow: ['bash(git checkout:*)'], ask: [], deny: [], mode: 'default' });
    const req = (command: string) => ({ tool: 'bash', kind: 'execute' as const, target: command, cwd: '/w', args: { command } });
    expect(engine.evaluate(req('cd ~/other-repo && git checkout .')).behavior).toBe('ask');
    expect(engine.evaluate(req('cd /tmp/x && git status')).behavior).toBe('ask');
    expect(engine.evaluate(req('git status')).behavior).toBe('allow');
  });
});
