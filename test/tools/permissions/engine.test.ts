import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionEngine, type PermissionRequest } from '../../../src/tools/permissions/engine.js';
import { matchesRule, parseRule, suggestRule } from '../../../src/tools/permissions/rules.js';

const cwd = path.resolve('/proj');
const at = (rel: string) => path.join(cwd, rel);

const bash = (command: string): PermissionRequest => ({ tool: 'bash', kind: 'execute', target: command, cwd });
const edit = (file: string, tool = 'edit'): PermissionRequest => ({ tool, kind: 'edit', target: file, cwd });
const read = (file: string): PermissionRequest => ({ tool: 'read', kind: 'read', target: file, cwd });

describe('parseRule / matchesRule', () => {
  it('解析 Tool 与 Tool(pattern)', () => {
    expect(parseRule('bash(git status:*)')).toEqual({ tool: 'bash', pattern: 'git status:*' });
    expect(parseRule('read')).toEqual({ tool: 'read' });
    expect(parseRule('mcp__github__*')).toEqual({ tool: 'mcp__github__*' });
  });

  it('bash 前缀 / 精确 / 通配', () => {
    expect(matchesRule(parseRule('bash(git status:*)'), bash('git status -s'))).toBe(true);
    expect(matchesRule(parseRule('bash(git status:*)'), bash('git statusx'))).toBe(false);
    expect(matchesRule(parseRule('bash(npm test)'), bash('npm test'))).toBe(true);
    expect(matchesRule(parseRule('bash(npm run *)'), bash('npm run build'))).toBe(true);
  });

  it('路径规则按 cwd 相对 glob 匹配', () => {
    expect(matchesRule(parseRule('edit(src/**)'), edit(at('src/a/b.ts')))).toBe(true);
    expect(matchesRule(parseRule('edit(src/**)'), edit(at('test/a.ts')))).toBe(false);
    expect(matchesRule(parseRule('edit(*.md)'), edit(at('README.md')))).toBe(true);
  });

  it('web_fetch 按域名（含子域）', () => {
    const req: PermissionRequest = { tool: 'web_fetch', kind: 'network', target: 'https://docs.example.com/x', cwd };
    expect(matchesRule(parseRule('web_fetch(domain:example.com)'), req)).toBe(true);
    expect(matchesRule(parseRule('web_fetch(domain:other.com)'), req)).toBe(false);
  });

  it('工具名通配', () => {
    const req: PermissionRequest = { tool: 'mcp__github__create_issue', kind: 'execute', cwd };
    expect(matchesRule(parseRule('mcp__github__*'), req)).toBe(true);
  });

  it('建议规则：bash 取前两个词，路径取顶层目录，网络取域名', () => {
    expect(suggestRule(bash('npm run build --watch'))).toBe('bash(npm run:*)');
    expect(suggestRule(bash('ls'))).toBe('bash(ls:*)');
    expect(suggestRule(edit(at('src/ui/App.tsx')))).toBe('edit(src/**)');
    expect(suggestRule({ tool: 'web_fetch', kind: 'network', target: 'https://a.b.com/x', cwd })).toBe('web_fetch(domain:a.b.com)');
  });
});

describe('PermissionEngine 决策表', () => {
  const engine = (opts: Partial<ConstructorParameters<typeof PermissionEngine>[0]> = {}) =>
    new PermissionEngine({ allow: [], ask: [], deny: [], mode: 'default', ...opts });

  it('deny 逐段检查，环境变量和 cd 不能绕过拒绝规则', () => {
    expect(engine({ mode: 'yolo', deny: ['bash(npm install:*)'] }).evaluate(bash('cd "a b" && CI=true npm install')).behavior).toBe('deny');
    expect(engine({ ask: ['bash(git status:*)'] }).evaluate(bash('cd "a b" && git status')).behavior).toBe('ask');
  });

  it('带重定向的复合命令仍跳过只读 cd 段，写入段需要授权', () => {
    const e = engine(),
      req = bash('cd "a b" && printf hi > out');
    expect(e.evaluate(req)).toMatchObject({ behavior: 'ask', suggestedRules: ['bash(printf hi:*)'] });
    e.grant('bash(printf hi:*)', 'session');
    expect(e.evaluate(req).behavior).toBe('allow');
    expect(engine().evaluate(bash('cd x > out')).behavior).toBe('ask');
  });

  it('worktree 使用同样决策链，保留高危和只读角色限制', () => {
    const req = { ...bash('npm install'), executionRoot: '/worktree' };
    expect(engine({ mode: 'yolo' }).evaluate(req).behavior).toBe('allow');
    expect(engine({ mode: 'yolo' }).evaluate({ ...req, target: 'git reset --hard' }).forced).toBe(true);
    expect(engine({ mode: 'yolo' }).evaluate({ ...req, readOnlyRole: 'scout' }).forced).toBe(true);
    expect(engine().evaluate({ ...req, target: 'git status' }).behavior).toBe('allow');
    expect(engine().evaluate(req)).toMatchObject({ behavior: 'ask', suggestedRules: ['bash(npm install:*)'] });
    expect(engine().evaluate(req).forced).toBeUndefined();
    expect(engine().evaluate(req).reason).toContain('在 worktree /worktree 中执行命令');
  });

  it('引号路径、环境变量和逐段建议可重复匹配', () => {
    const e = engine();
    const req = bash(
      'cd "D:\\Personal Files\\RoastCli" && git status --short && git branch --show-current && sed -n 280,300p src/ui/FullScreen.tsx',
    );
    expect(e.evaluate(req).suggestedRules).toEqual(['bash(sed:*)']);
    e.grant('bash(sed:*)', 'session');
    expect(e.evaluate(req).behavior).toBe('allow');
    expect(e.evaluate(bash('CI=true pnpm.cmd vitest run test/x')).suggestedRules).toEqual(['bash(pnpm.cmd vitest:*)']);
    e.grant('bash(pnpm.cmd vitest:*)', 'session');
    expect(e.evaluate(bash('CI="a b" OTHER=\'x\' pnpm.cmd vitest run test/y')).behavior).toBe('allow');
    expect(e.evaluate(bash('cd "a b" && npm test')).suggestedRules).toEqual(['bash(npm test:*)']);
    expect(e.evaluate(bash('echo $(npm test)')).suggestedRules).toEqual([]);
  });

  it('主工作区只扩展读取权限', () => {
    const e = engine({ readRoots: [path.resolve('/main')] });
    expect(e.evaluate({ ...read(path.resolve('/main/a.ts')), cwd: path.resolve('/worktree') }).behavior).toBe('allow');
    expect(e.evaluate({ ...edit(path.resolve('/main/a.ts')), cwd: path.resolve('/worktree') }).behavior).toBe('ask');
  });

  it.each<[string, PermissionRequest, string]>([
    ['工作区内读取', read(at('src/a.ts')), 'allow'],
    ['工作区外读取', read(path.resolve('/etc/hosts')), 'ask'],
    ['只读 bash', bash('git status'), 'allow'],
    ['只读 bash 但写文件', bash('ls > files.txt'), 'ask'],
    ['写 bash', bash('npm install'), 'ask'],
    ['复合命令含写', bash('git status; rm -rf x'), 'ask'],
    ['命令替换', bash('echo $(cat a)'), 'ask'],
    ['编辑', edit(at('src/a.ts')), 'ask'],
    ['交互类工具', { tool: 'todo_write', kind: 'interact', cwd }, 'allow'],
  ])('default 模式：%s → %s', (_n, req, expected) => {
    expect(engine().evaluate(req).behavior).toBe(expected);
  });

  it('acceptEdits：工作区内编辑放行，工作区外仍询问', () => {
    const e = engine({ mode: 'acceptEdits' });
    expect(e.evaluate(edit(at('src/a.ts'))).behavior).toBe('allow');
    expect(e.evaluate(edit(path.resolve('/other/a.ts'))).behavior).toBe('ask');
    expect(e.evaluate(bash('npm install')).behavior).toBe('ask');
  });

  it('plan 模式：拒绝写操作与非只读 bash，放行读与交互', () => {
    const e = engine({ mode: 'plan' });
    expect(e.evaluate(edit(at('a.ts'))).behavior).toBe('deny');
    expect(e.evaluate(bash('npm install')).behavior).toBe('deny');
    expect(e.evaluate(bash('git log')).behavior).toBe('allow');
    expect(e.evaluate(read(at('a.ts'))).behavior).toBe('allow');
    expect(e.evaluate({ tool: 'exit_plan_mode', kind: 'interact', cwd }).behavior).toBe('allow');
  });

  it('yolo：全部放行，但高危命令强制询问', () => {
    const e = engine({ mode: 'yolo' });
    expect(e.evaluate(bash('npm install')).behavior).toBe('allow');
    const danger = e.evaluate(bash('git push --force'));
    expect(danger.behavior).toBe('ask');
    expect(danger.forced).toBe(true);
  });

  it('deny 规则优先于一切', () => {
    const e = engine({ deny: ['bash(npm publish:*)'], allow: ['bash'], mode: 'yolo' });
    expect(e.evaluate(bash('npm publish --tag x')).behavior).toBe('deny');
  });

  it('allow 规则：复合命令每段都需命中（或只读）', () => {
    const e = engine({ allow: ['bash(npm test:*)'] });
    expect(e.evaluate(bash('npm test -- --watch')).behavior).toBe('allow');
    expect(e.evaluate(bash('git status && npm test')).behavior).toBe('allow');
    expect(e.evaluate(bash('npm test && npm publish')).behavior).toBe('ask');
  });

  it('allow 规则不能放行高危命令', () => {
    const e = engine({ allow: ['bash(git push:*)'] });
    expect(e.evaluate(bash('git push origin main')).behavior).toBe('allow');
    expect(e.evaluate(bash('git push -f origin main')).behavior).toBe('ask');
  });

  it('编辑 .git 内部或 shadow 检查点仓库强制询问', () => {
    const e = engine({ mode: 'yolo' });
    expect(e.evaluate(edit(at('.git/config'))).behavior).toBe('ask');
    expect(e.evaluate(edit(at('.roast/shadow.git/HEAD'))).behavior).toBe('ask');
  });

  it('会话授权：grant 后同类请求放行', () => {
    const e = engine();
    expect(e.evaluate(bash('npm run build')).behavior).toBe('ask');
    e.grant('bash(npm run:*)', 'session');
    expect(e.evaluate(bash('npm run lint')).behavior).toBe('allow');
  });

  it('模式切换与轮换顺序', () => {
    const e = engine();
    expect(e.cycleMode()).toBe('acceptEdits');
    expect(e.cycleMode()).toBe('auto');
    expect(e.cycleMode()).toBe('plan');
    expect(e.cycleMode()).toBe('yolo');
    expect(e.cycleMode()).toBe('default');
  });
});

describe('PermissionEngine 帮我审批（auto）', () => {
  const engine = (opts: Partial<ConstructorParameters<typeof PermissionEngine>[0]> = {}) =>
    new PermissionEngine({ allow: [], ask: [], deny: [], mode: 'auto', ...opts });

  it('低风险自动放行，高风险询问并带拒绝记忆身份与可记住的规则', () => {
    const e = engine();
    expect(e.evaluate(bash('pnpm test && rm -rf dist')).behavior).toBe('allow');
    expect(e.evaluate(edit(at('src/a.ts'))).behavior).toBe('allow');
    expect(e.evaluate(read(path.resolve('/usr/share/doc/a.txt'))).behavior).toBe('allow');
    expect(e.evaluate({ tool: 'web_fetch', kind: 'network', target: 'https://example.com', cwd }).behavior).toBe('allow');
    const push = e.evaluate(bash('git push origin main'));
    expect(push).toMatchObject({ behavior: 'ask', reason: '高风险操作：推送到远端仓库', suggestedRule: 'bash(git push:*)' });
    expect(push.denialKey).toBeDefined();
    expect(push.forced).toBeUndefined();
    expect(e.evaluate(edit(at('.github/workflows/ci.yml')))).toMatchObject({ behavior: 'ask', reason: '高风险操作：修改 CI 配置' });
  });

  it('强制高危仍然只能单次批准；allow 规则只豁免扩展清单，ask / deny 规则照常生效', () => {
    const e = engine({ allow: ['bash(git push:*)', 'bash(git reset:*)'], ask: ['bash(pnpm test:*)'], deny: ['bash(npm publish:*)'] });
    expect(e.evaluate(bash('git push origin main')).behavior).toBe('allow');
    expect(e.evaluate(bash('git reset --hard'))).toMatchObject({ behavior: 'ask', forced: true });
    expect(e.evaluate(bash('git reset --hard')).denialKey).toBeDefined();
    expect(e.evaluate(bash('pnpm test'))).toMatchObject({ behavior: 'ask', reason: '命中 ask 规则' });
    expect(e.evaluate(bash('npm publish')).behavior).toBe('deny');
    e.setMode('plan');
    expect(e.evaluate(bash('pnpm build')).behavior).toBe('deny');
  });

  it('用户拒绝后只自动拒绝完全相同的操作，且只在 auto 模式生效', () => {
    const e = engine();
    const first = e.evaluate(bash('git push origin main'));
    e.rememberDenial(first.denialKey!);
    expect(e.evaluate(bash('CI=1 git  push origin main'))).toMatchObject({ behavior: 'deny', reason: expect.stringContaining('已拒绝过') });
    expect(e.evaluate(bash('git push origin dev')).behavior).toBe('ask');
    expect(e.evaluate(bash('pnpm test')).behavior).toBe('allow');
    e.setMode('default');
    const manual = e.evaluate(bash('git push origin main'));
    expect(manual.behavior).toBe('ask');
    expect(manual.denialKey).toBeUndefined();
  });
});
