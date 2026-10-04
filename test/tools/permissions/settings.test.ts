import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trustProject } from '../../../src/core/config.js';
import { addProjectGrant, foldPermissionEvents, loadPermissionRules, projectSettingsPath } from '../../../src/tools/permissions/settings.js';
import type { SessionEvent } from '../../../src/session/events.js';
import { tempWorkspace } from '../../fixtures/workspace.js';

let home: string;
let cwd: string;
const saved = process.env['ROAST_HOME'];

beforeEach(() => {
  home = tempWorkspace('roast-ph-').dir;
  cwd = tempWorkspace('roast-pp-').dir;
  process.env['ROAST_HOME'] = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ROAST_HOME'];
  else process.env['ROAST_HOME'] = saved;
});

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), 'utf8');
}

describe('loadPermissionRules', () => {
  it('合并用户级、项目授权与仓库配置；仓库 allow 规则未信任时忽略，deny/ask 始终生效', () => {
    writeJson(path.join(home, 'config.json'), { permissions: { allow: ['bash(npm test:*)'], defaultMode: 'acceptEdits' } });
    writeJson(path.join(cwd, '.roast', 'config.json'), { permissions: { allow: ['bash'], deny: ['bash(rm:*)'], ask: ['read(secrets/**)'] } });
    const r = loadPermissionRules(cwd);
    expect(r.allow).toEqual(['bash(npm test:*)']);
    expect(r.deny).toEqual(['bash(rm:*)']);
    expect(r.ask).toEqual(['read(secrets/**)']);
    expect(r.ignoredRepoAllow).toEqual(['bash']);
    expect(r.defaultMode).toBe('acceptEdits');
  });

  it('信任项目后仓库 allow 规则生效', () => {
    writeJson(path.join(cwd, '.roast', 'config.json'), { permissions: { allow: ['edit(src/**)'] } });
    trustProject(cwd);
    expect(loadPermissionRules(cwd).allow).toEqual(['edit(src/**)']);
  });

  it('项目级授权写入用户目录下的项目设置，而不是仓库内', () => {
    addProjectGrant(cwd, 'bash(pnpm build:*)');
    addProjectGrant(cwd, 'bash(pnpm build:*)');
    expect(projectSettingsPath(cwd).startsWith(home)).toBe(true);
    expect(loadPermissionRules(cwd).allow).toEqual(['bash(pnpm build:*)']);
  });
});

describe('foldPermissionEvents', () => {
  it('从日志恢复会话授权与当前模式', () => {
    const at = 't';
    const events = [
      { type: 'permission/grant', at, rule: 'bash(npm run:*)', scope: 'session' },
      { type: 'mode/change', at, mode: 'plan' },
      { type: 'permission/grant', at, rule: 'edit(src/**)', scope: 'project' },
      { type: 'mode/change', at, mode: 'acceptEdits' },
    ] as SessionEvent[];
    expect(foldPermissionEvents(events)).toEqual({ grants: ['bash(npm run:*)', 'edit(src/**)'], mode: 'acceptEdits' });
  });
});
