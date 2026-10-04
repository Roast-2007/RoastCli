import { describe, expect, it } from 'vitest';
import { isReadOnlyRoleCommand, isVerificationCommand } from '../../src/tools/permissions/bash-parse.js';
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

  it('denies direct edits and delegates shell execution to the permission engine', async () => {
    expect((await judge(writeTool, { path: 'a.ts', content: 'x' }, ctx)).action).toBe('deny');
    for (const command of ['pnpm test > out.txt', 'pnpm test && rm -rf src', 'pnpm install']) {
      expect(isReadOnlyRoleCommand(command)).toBe(false);
      expect((await judge(bashTool, { command }, ctx)).action).toBe('allow');
    }
  });

  it('requires approval for output flags on otherwise read-only Git commands', async () => {
    for (const command of ['git diff --output=src/a.ts', 'git log --output src/a.ts', 'git show "--output=src/a.ts"']) {
      expect(isReadOnlyRoleCommand(command), command).toBe(false);
    }
    expect((await judge(bashTool, { command: 'git diff -u' }, ctx)).action).toBe('allow');
  });

  it('does not restrict writer roles', async () => {
    expect(await roleGuardHook('worker')(bashTool, { command: 'pnpm install' }, ctx)).toEqual({ action: 'allow' });
  });
});

describe('research shell classification', () => {
  it('recognizes listings and read-only pipelines from a research task', () => {
    for (const command of [
      'cd /project && git ls-files src | cat',
      'cd /project && git branch -a && git stash list; git status --short | head -20; git log --all --oneline | wc -l',
      'cd /project && wc -l src/*.ts 2>/dev/null | sort -rn | head -40',
      'git tag', 'git tag -l', 'tail -c 300 README.md | od -c | tail -5',
    ]) expect(isReadOnlyRoleCommand(command), command).toBe(true);
  });
  it('keeps writes, arbitrary xargs and tag creation out of automatic read-only execution', () => {
    for (const command of ['sort -o src/out.txt src/a.txt', 'sort --output=out.txt a.txt', 'git tag v1', 'git tag -d v1', 'git branch feature', 'git branch -D feature', 'git stash list --output=out.txt', 'find src | xargs rm', 'node -e "process.exit(0)"']) {
      expect(isReadOnlyRoleCommand(command), command).toBe(false);
    }
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
