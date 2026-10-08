import { describe, expect, it } from 'vitest';
import { loadProfiles, parseProfile, profilesSection, profileGuard } from '../../src/swarm/profiles.js';
import { roleCard } from '../../src/swarm/roles.js';
import { readTool, editTool, createDefaultToolRegistry } from '../../src/tools/index.js';
import { makeCtx } from '../tools/helpers.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import path from 'node:path';

describe('agent profiles', () => {
  it('parses Claude tool aliases and infers read-only roles, preserving explicit roles', () => {
    const parsed = parseProfile(
      '---\nname: reviewer\ndescription: 审查\ntools: [Read, Grep, WebFetch, Bogus]\nmodel: sonnet\n---\nInspect evidence',
      'fallback',
    );
    expect(parsed.profile).toMatchObject({
      name: 'reviewer',
      role: 'scout',
      tools: ['read', 'grep', 'web_fetch'],
      body: 'Inspect evidence',
    });
    expect(parsed.profile?.model).toBeUndefined();
    expect(parsed.warnings).toHaveLength(2);
    const worker = parseProfile(
      '---\ntools: Read, MultiEdit, TodoWrite, LS, Bash\nmodel: p:m\nrole: critic\nreasoning_effort: high\n---\nDuty',
      'worker',
    );
    expect(worker.profile).toMatchObject({
      role: 'critic',
      model: 'p:m',
      reasoningEffort: 'high',
      tools: ['read', 'multi_edit', 'todo_write', 'ls', 'bash'],
    });
    expect(parseProfile('---\ndescription: default\n---\nbody', 'default').profile?.role).toBe('worker');
  });
  it('rejects malformed files and invalid names, truncating oversized bodies with a warning', () => {
    for (const text of [
      'no header',
      '---\nname: Bad_Name\n---\nbody',
      '---\nrole: queen\n---\nbody',
      '---\ntools: 42\n---\nbody',
      '---\n[broken\n---\nbody',
    ])
      expect(parseProfile(text, 'valid').profile).toBeUndefined();
    const result = parseProfile(`---\nmodel: inherit\n---\n${'x'.repeat(9000)}`, 'long');
    expect(result.profile?.body).toHaveLength(8000);
    expect(result.warnings.join()).toContain('截断');
  });
  it('loads in precedence order and ignores every project profile before trust', () => {
    const root = tempWorkspace(),
      home = path.join(root.dir, '.roast'),
      cwd = path.join(root.dir, 'project');
    for (const [dir, description] of [
      ['.claude/agents', 'claude'],
      ['.roast/agents', 'roast'],
      ['project/.claude/agents', 'project-claude'],
      ['project/.roast/agents', 'project-roast'],
    ])
      root.file(`${dir}/same.md`, `---\ndescription: ${description}\n---\nbody`);
    root.file('project/.roast/agents/extra.md', '---\nrole: critic\n---\nbody');
    root.file('.claude/agents/claude-only.md', '---\ndescription: user claude\n---\nbody');
    const untrusted = loadProfiles(cwd, home);
    expect(untrusted.profiles.get('same')?.description).toBe('roast');
    // 与 skills 一致，用户级 ~/.claude/agents 不读取
    expect(untrusted.profiles.has('claude-only')).toBe(false);
    expect(untrusted.profiles.has('extra')).toBe(false);
    expect(untrusted.warnings.join()).toContain('3 个项目级');
    const trusted = loadProfiles(cwd, home, { trusted: true });
    expect(trusted.profiles.get('same')?.description).toBe('project-roast');
    expect(profilesSection(trusted.profiles)).toContain('- extra (critic, read-only)');
  });
  it('appends profile duties and enforces tool allowlists while permitting protocol tools', async () => {
    const profile = parseProfile('---\ntools: Read\n---\nEvidence only', 'reviewer').profile!;
    const card = roleCard({ id: 's1', role: 'scout', parentId: 'main', task: 'review', refs: [], profile });
    expect(card.indexOf('Read-only investigation')).toBeLessThan(card.indexOf('Profile reviewer:'));
    const guard = profileGuard('s1', profile),
      ctx = makeCtx(tempWorkspace().dir);
    expect(await guard(readTool, {}, ctx)).toMatchObject({ action: 'allow' });
    expect(await guard(editTool, {}, ctx)).toMatchObject({ action: 'deny', reason: '成员 s1（reviewer）不允许使用 edit' });
    for (const name of ['report', 'task', 'recall', 'todo_write', 'board_write', 'send_message', 'await_agents'])
      expect(await guard(createDefaultToolRegistry().get(name), {}, ctx)).toMatchObject({ action: 'allow' });
  });
  it('accepts MCP tools by name or prefix and keeps .claude profiles quiet about Claude-only fields', async () => {
    const parsed = parseProfile('---\ntools: Read, mcp__github__*, mcp__docs__search, NotebookEdit\nmodel: opus\n---\nbody', 'gh', '', {
      lenient: true,
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.profile?.tools).toEqual(['read', 'mcp__github__*', 'mcp__docs__search']);
    const guard = profileGuard('s2', parsed.profile),
      ctx = makeCtx(tempWorkspace().dir),
      tool = (name: string) => ({ ...readTool, name });
    expect(await guard(tool('mcp__github__create_issue'), {}, ctx)).toMatchObject({ action: 'allow' });
    expect(await guard(tool('mcp__docs__search'), {}, ctx)).toMatchObject({ action: 'allow' });
    expect(await guard(tool('mcp__docs__fetch'), {}, ctx)).toMatchObject({ action: 'deny' });
    expect(parseProfile('---\nmodel: opus\n---\nbody', 'strict').warnings).toHaveLength(1);
  });
});
