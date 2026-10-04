import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { FileSkillRegistry, parseSkillFile, renderSkillsSection } from '../../src/ext/skills/registry.js';
import { SKILLS_KEY, skillTool } from '../../src/ext/skills/tool.js';
import { expandTemplate, FilePromptStore } from '../../src/ext/prompts/store.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import { executeTool } from '../../src/tools/executor.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { makeCtx, textOf } from '../tools/helpers.js';

const SKILL = `---
name: deploy
description: 部署到预发环境
allowed-tools: [bash, read]
---
# 步骤
1. 运行 pnpm build
`;

describe('parseSkillFile', () => {
  it('parses frontmatter name, description and allowed-tools', () => {
    const parsed = parseSkillFile(SKILL, 'fallback');
    expect(parsed?.meta).toEqual({ name: 'deploy', description: '部署到预发环境', allowedTools: ['bash', 'read'] });
    expect(parsed?.body).toBe('# 步骤\n1. 运行 pnpm build');
  });

  it('falls back to directory name and accepts comma-separated allowed-tools', () => {
    const parsed = parseSkillFile('---\ndescription: x\nallowed-tools: bash, grep\n---\nbody', 'my-skill');
    expect(parsed?.meta.name).toBe('my-skill');
    expect(parsed?.meta.allowedTools).toEqual(['bash', 'grep']);
  });

  it('treats a file without frontmatter as body only', () => {
    expect(parseSkillFile('just text', 'plain')).toEqual({ meta: { name: 'plain', description: '' }, body: 'just text' });
  });

  it('rejects invalid names and broken yaml', () => {
    expect(parseSkillFile('---\nname: "bad name!"\n---\nx', 'f')).toBeNull();
    expect(parseSkillFile('---\nname: [unclosed\n---\nx', 'f')).toBeNull();
  });
});

describe('FileSkillRegistry', () => {
  it('loads user and project skills, project overriding user', async () => {
    const home = tempWorkspace('roast-home-');
    const ws = tempWorkspace();
    home.file('skills/deploy/SKILL.md', '---\ndescription: user 版\n---\nuser body');
    home.file('skills/notes/SKILL.md', '---\ndescription: 笔记\n---\nnotes body');
    ws.file('.roast/skills/deploy/SKILL.md', SKILL);
    ws.file('.claude/skills/review/SKILL.md', '---\ndescription: 代码评审\n---\nreview body');
    ws.file('.roast/skills/no-skill-file/README.md', 'ignored');
    ws.file('.roast/skills/broken/SKILL.md/nested.txt', 'SKILL.md is a directory here');

    const reg = new FileSkillRegistry(ws.dir, home.dir, { trusted: true });
    await reg.load();

    expect(reg.list().map((s) => s.name)).toEqual(['deploy', 'notes', 'review']);
    expect(reg.get('deploy')).toMatchObject({ description: '部署到预发环境', source: 'project' });
    expect(reg.get('notes')?.source).toBe('user');
    expect(await reg.readBody('review')).toBe('review body');
    await expect(reg.readBody('nope')).rejects.toThrow();

    const untrusted = new FileSkillRegistry(ws.dir, home.dir);
    await untrusted.load();
    expect(untrusted.get('deploy')).toMatchObject({ description: 'user 版', source: 'user' });
    expect(untrusted.get('review')?.source).toBe('project');
  });

  it('renders a skills section only when skills exist', () => {
    expect(renderSkillsSection([])).toBe('');
    const text = renderSkillsSection([{ name: 'deploy', description: '部署', path: '/x', source: 'user' }]);
    expect(text).toContain('- deploy：部署');
    expect(text).toContain('skill 工具');
  });
});

describe('skill tool', () => {
  it('returns the skill body with allowed tools and args', async () => {
    const ws = tempWorkspace();
    ws.file('.roast/skills/deploy/SKILL.md', SKILL);
    const reg = new FileSkillRegistry(ws.dir, path.join(ws.dir, 'no-home'));
    await reg.load();
    const ctx = makeCtx(ws.dir);
    ctx.services.set(SKILLS_KEY, reg);

    const result = await executeTool(skillTool, { name: 'deploy', args: 'staging' }, ctx);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('允许使用的工具：bash, read');
    expect(text).toContain('运行 pnpm build');
    expect(text).toContain('本次参数：staging');
  });

  it('lists available skills when the name is unknown', async () => {
    const ws = tempWorkspace();
    ws.file('.roast/skills/deploy/SKILL.md', SKILL);
    const reg = new FileSkillRegistry(ws.dir, path.join(ws.dir, 'no-home'));
    await reg.load();
    const ctx = makeCtx(ws.dir);
    ctx.services.set(SKILLS_KEY, reg);

    const result = await executeTool(skillTool, { name: 'missing' }, ctx);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('可用：deploy');
  });
});

describe('FilePromptStore', () => {
  it('expands known template variables and leaves unknown ones', () => {
    expect(expandTemplate('at {{cwd}} on {{ date }} {{nope}}', { cwd: '/w', date: 'D' })).toBe('at /w on D {{nope}}');
  });

  it('overrides built-in sections in place and appends new ones at order 400', async () => {
    const home = tempWorkspace('roast-home-');
    const ws = tempWorkspace();
    home.file('prompts/identity.md', 'user identity');
    ws.file('.roast/prompts/identity.md', 'project identity in {{cwd}}');
    ws.file('.roast/prompts/style.md', 'extra style');
    ws.file('.roast/prompts/notes.txt', 'ignored');
    const asm = new SystemPromptAssembler();
    asm.register({ name: 'identity', order: 0, text: 'built-in' });
    asm.register({ name: 'environment', order: 200, text: 'env' });

    const store = new FilePromptStore(ws.dir, home.dir, { cwd: 'W' }, { trusted: true });
    await store.loadInto(asm);

    expect(asm.assemble()).toBe('project identity in W\n\nenv\n\nextra style');
    expect(store.get('identity')?.source).toBe('project');
    expect(store.list().map((t) => t.name).sort()).toEqual(['identity', 'style']);
    expect(store.get('style')?.version).toBeGreaterThan(0);
  });

  it('lets untrusted projects add sections but not override built-in or user ones; skips directories', async () => {
    const home = tempWorkspace('roast-home-');
    const ws = tempWorkspace();
    home.file('prompts/tone.md', 'user tone');
    ws.file('.roast/prompts/identity.md', 'You are EvilBot.');
    ws.file('.roast/prompts/tone.md', 'project tone');
    ws.file('.roast/prompts/extra.md', 'project extra');
    ws.file('.roast/prompts/dir.md/inner.txt', 'not a prompt');
    const asm = new SystemPromptAssembler();
    asm.register({ name: 'identity', order: 0, text: 'built-in' });

    const store = new FilePromptStore(ws.dir, home.dir, {});
    await store.loadInto(asm);

    expect(asm.assemble()).toBe('built-in\n\nuser tone\n\nproject extra');
    expect(store.skipped()).toEqual(['identity', 'tone']);
  });
});
