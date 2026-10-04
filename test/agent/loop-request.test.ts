/**
 * loop 构建请求：maxTokens 取自模型元数据；request/body 仅在 debugLog 时落盘。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentLoop, type AgentLoopDeps } from '../../src/agent/loop.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { RunLogWriter } from '../../src/session/log-writer.js';
import { loadRunLog } from '../../src/session/projection.js';
import { createDefaultToolRegistry, MapToolServices } from '../../src/tools/index.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';

async function run(extra: Partial<AgentLoopDeps> = {}) {
  const ws = tempWorkspace('roast-req-');
  const provider = new ScriptedProvider([textScript('ok')], { models: { m: { id: 'm', maxTokens: 4096 } } });
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const log = await RunLogWriter.create(path.join(ws.dir, 'logs'), { cwd: ws.dir, provider: 'p', model: 'm' });
  const loop = new AgentLoop({
    providers,
    modelRef: { provider: 'p', model: 'm' },
    tools: createDefaultToolRegistry(),
    systemPrompt: new SystemPromptAssembler(),
    log,
    cwd: ws.dir,
    services: new MapToolServices(),
    ...extra,
  });
  for await (const _ of loop.run('hi')) {
    // drain
  }
  return { provider, events: loadRunLog(log.path).events };
}

describe('AgentLoop 请求构建', () => {
  it('maxTokens 取自 provider.resolveModel', async () => {
    const { provider } = await run();
    expect(provider.requests[0]!.maxTokens).toBe(4096);
  });

  it('默认不落 request/body（只有 request/digest）', async () => {
    const { events } = await run();
    const types = events.map((e) => e.type);
    expect(types).toContain('request/digest');
    expect(types).not.toContain('request/body');
  });

  it('debugLog=true 时落 request/body', async () => {
    const { events } = await run({ debugLog: true });
    expect(events.map((e) => e.type)).toContain('request/body');
  });
});
