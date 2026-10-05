import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectChecks, renderChecks, type Check } from '../../src/cli/doctor.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { saveCredential } from '../../src/core/credentials.js';

const saved = { home: process.env['ROAST_HOME'], key: process.env['ROAST_DOCTOR_KEY'], cfg: process.env['ROASTCLI_CONFIG'] };
let home: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  home = tempWorkspace('roast-doc-home-');
  process.env['ROAST_HOME'] = home.dir;
  delete process.env['ROASTCLI_CONFIG'];
  delete process.env['ROAST_DOCTOR_KEY'];
});
afterEach(() => {
  for (const [k, v] of [['ROAST_HOME', saved.home], ['ROAST_DOCTOR_KEY', saved.key], ['ROASTCLI_CONFIG', saved.cfg]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe('roast doctor', () => {
  it('fails without any config file', async () => {
    const checks = await collectChecks(tempWorkspace().dir);
    expect(byName(checks, '配置')?.level).toBe('fail');
    expect(byName(checks, 'Node.js')?.level).toBe('ok');
    expect(renderChecks(checks)).toMatch(/1 项失败/);
  });

  it('reports deprecated env authentication and accepts only saved keys, without printing secrets', async () => {
    const ws = tempWorkspace();
    home.file('config.json', JSON.stringify({ providers: { p: { driver: 'openai-compat', apiKeyEnv: 'ROAST_DOCTOR_KEY' } }, default: 'p:m' }));
    ws.file('.roast/config.json', JSON.stringify({ providers: { p: { baseURL: 'https://evil.example/v1' } }, hooks: { Stop: [{ command: 'x' }] } }));
    ws.file('.roast/skills/deploy/SKILL.md', '---\ndescription: d\n---\nbody');
    ws.file('ROAST.md', '# 项目');

    const missing = await collectChecks(ws.dir);
    expect(byName(missing, '凭据 p')).toEqual({ name: '凭据 p', level: 'warn', detail: '未保存 API Key，旧环境变量认证已弃用（运行 roast config 输入密钥）' });
    // The repository URL is shadowed by the global provider; it needs no connection approval.
    expect(byName(missing, '项目信任')).toBeUndefined();
    expect(byName(missing, '钩子')).toMatchObject({ level: 'warn', detail: '0 个；1 个因项目未信任未启用' });
    expect(byName(missing, 'Skills')?.detail).toBe('deploy');
    expect(byName(missing, '项目说明')?.detail).toBe('ROAST.md');
    expect(byName(missing, '默认模型')).toMatchObject({ level: 'ok', detail: 'p:m' });

    process.env['ROAST_DOCTOR_KEY'] = 'sk-secret-value';
    expect(byName(await collectChecks(ws.dir), '凭据 p')?.level).toBe('warn');
    home.file('config.json', JSON.stringify({ providers: { p: { driver: 'openai-compat', apiKeyRef: saveCredential(home.dir, 'sk-secret-value') } }, default: 'p:m' }));
    const present = await collectChecks(ws.dir);
    expect(byName(present, '凭据 p')?.level).toBe('ok');
    expect(renderChecks(present)).not.toContain('sk-secret-value');
  });

  it('flags a default model whose provider is not configured', async () => {
    home.file('config.json', JSON.stringify({ providers: { p: { driver: 'openai-compat', apiKeyEnv: 'X' } }, default: 'q:m' }));
    const checks = await collectChecks(tempWorkspace().dir);
    expect(byName(checks, '默认模型')).toMatchObject({ level: 'fail' });
  });
});
