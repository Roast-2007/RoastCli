import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InteractionBroker } from '../../src/core/interaction.js';
import { executeTool } from '../../src/tools/executor.js';
import { askUserTool, BROKER_KEY, exitPlanModeTool, PERMISSIONS_KEY, TODOS_KEY, todoWriteTool } from '../../src/tools/interact/index.js';
import { PermissionEngine } from '../../src/tools/permissions/engine.js';
import { htmlToMarkdown, webFetchTool } from '../../src/tools/web/fetch.js';
import { makeCtx, textOf } from './helpers.js';

describe('todo_write', () => {
  it('整体替换清单并写入 services，多个 in_progress 时提示', async () => {
    const ctx = makeCtx('/p');
    const r = await executeTool(
      todoWriteTool,
      { todos: [{ content: '写测试', status: 'completed' }, { content: '实现', status: 'in_progress' }, { content: '重构', status: 'in_progress' }] },
      ctx,
    );
    expect(textOf(r)).toContain('1/3 完成');
    expect(textOf(r)).toContain('同时有 2 项');
    expect(ctx.services.get(TODOS_KEY)).toHaveLength(3);
    expect(r.metadata?.['todos']).toHaveLength(3);
  });
});

describe('ask_user', () => {
  it('经 broker 询问并返回答案', async () => {
    const ctx = makeCtx('/p');
    const broker = new InteractionBroker();
    broker.onRequest((req) => broker.respond(req.id, { kind: 'question', answer: 'B 方案' }));
    ctx.services.set(BROKER_KEY, broker);
    const r = await executeTool(askUserTool, { question: '选哪个？', options: ['A 方案', 'B 方案'] }, ctx);
    expect(textOf(r)).toBe('用户回答：B 方案');
  });

  it('非交互模式返回提示性错误', async () => {
    const r = await executeTool(askUserTool, { question: 'x' }, makeCtx('/p'));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('非交互');
  });
});

describe('exit_plan_mode', () => {
  function setup(answer: string) {
    const ctx = makeCtx('/p');
    const broker = new InteractionBroker();
    broker.onRequest((req) => broker.respond(req.id, { kind: 'question', answer }));
    const engine = new PermissionEngine({ allow: [], ask: [], deny: [], mode: 'plan' });
    const modes: string[] = [];
    engine.onModeChange((m) => modes.push(m));
    ctx.services.set(BROKER_KEY, broker);
    ctx.services.set(PERMISSIONS_KEY, engine);
    return { ctx, engine, modes };
  }

  it('批准后退出 plan 模式并触发模式变化回调', async () => {
    const { ctx, engine, modes } = setup('批准，开始执行');
    const r = await executeTool(exitPlanModeTool, { plan: '1. 改 a\n2. 改 b' }, ctx);
    expect(textOf(r)).toContain('已批准');
    expect(engine.mode).toBe('default');
    expect(modes).toEqual(['default']);
  });

  it('未批准时带回反馈，保持 plan 模式', async () => {
    const { ctx, engine } = setup('先别动数据库');
    const r = await executeTool(exitPlanModeTool, { plan: 'x' }, ctx);
    expect(textOf(r)).toContain('先别动数据库');
    expect(engine.mode).toBe('plan');
  });
});

describe('web_fetch', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><script>evil()</script></head><body><h1>标题</h1><p>正文 <b>粗体</b></p></body></html>');
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else if (req.url === '/bin') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50]));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('HTML 转 Markdown，去掉 script，结果包在 web_content 中', async () => {
    const r = await executeTool(webFetchTool, { url: `${base}/page` }, makeCtx('/p'));
    const text = textOf(r);
    expect(text).toContain('# 标题');
    expect(text).toContain('**粗体**');
    expect(text).not.toContain('evil');
    expect(text).toContain('<web_content>');
  });

  it('JSON 原样返回；非文本类型报错；404 为错误结果', async () => {
    expect(textOf(await executeTool(webFetchTool, { url: `${base}/json` }, makeCtx('/p')))).toContain('{"ok":true}');
    expect((await executeTool(webFetchTool, { url: `${base}/bin` }, makeCtx('/p'))).isError).toBe(true);
    expect((await executeTool(webFetchTool, { url: `${base}/nope` }, makeCtx('/p'))).isError).toBe(true);
  });

  it('htmlToMarkdown 压缩多余空行', () => {
    expect(htmlToMarkdown('<p>a</p><br><br><br><p>b</p>')).not.toMatch(/\n{3,}/);
  });
});
