import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readImageTool } from '../../src/tools/read/image.js';
import { executeTool } from '../../src/tools/executor.js';
import { mcpResultToToolResult } from '../../src/ext/mcp/tool.js';
import { buildMessages as openai } from '../../src/providers/openai-compat/request.js';
import { buildMessages as anthropic } from '../../src/providers/anthropic/request.js';
import { makeCtx, makeTmpDir } from './helpers.js';
import path from 'node:path';

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
describe('images reach model requests', () => {
  it('reads by signature, preserving the pixels through both provider tool-result translations', async () => {
    const cwd = await makeTmpDir();
    await writeFile(path.join(cwd, 'screenshot.bin'), Buffer.from(PNG, 'base64'));
    const result = await executeTool(readImageTool, { path: 'screenshot.bin' }, makeCtx(cwd));
    expect(result.isError).toBeUndefined();
    expect(result.content[1]).toEqual({ type: 'image', mediaType: 'image/png', data: PNG });
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'tool-result' as const, toolCallId: 'image', name: 'read_image', content: result.content }],
      },
    ];
    const wire = openai(messages);
    expect(wire[0]).toMatchObject({ role: 'tool', tool_call_id: 'image' });
    expect(wire[1]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] });
    expect(JSON.stringify(anthropic(messages))).toContain(`"data":"${PNG}"`);
    const parallel = openai([{ role: 'user', content: [messages[0]!.content[0]!, { type: 'tool-result', toolCallId: 'second', name: 'read_image', content: result.content }] }]);
    expect(parallel.map((message) => message.role)).toEqual(['tool', 'tool', 'user']);
    expect(parallel[1]!.tool_call_id).toBe('second');
    expect(parallel[2]!.content).toHaveLength(2);
  });
  it('preserves real MCP images and embedded image resources while rejecting unsupported or oversized files', async () => {
    const output = mcpResultToToolResult({
      content: [
        { type: 'image', mimeType: 'image/png', data: PNG },
        { type: 'resource', resource: { uri: 'image://test', mimeType: 'image/png', blob: PNG } },
      ],
    });
    expect(output.content.filter((b) => b.type === 'image')).toHaveLength(2);
    const cwd = await makeTmpDir();
    await writeFile(path.join(cwd, 'invalid.png'), 'not an image');
    await writeFile(path.join(cwd, 'huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    expect((await executeTool(readImageTool, { path: 'invalid.png' }, makeCtx(cwd))).isError).toBe(true);
    expect((await executeTool(readImageTool, { path: 'huge.png' }, makeCtx(cwd))).isError).toBe(true);
  });
});
