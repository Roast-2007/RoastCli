import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempWorkspace } from '../fixtures/workspace.js';

const entry = fileURLToPath(new URL('../../src/entrypoints/cli.ts', import.meta.url));
const loader = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
function cli(cwd: string, home: string, args: string[], input = ''): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    // Regular-file stdin behaves the same on every OS; pipe detection is covered by the readPipedStdin unit tests.
    const inputFile = path.join(cwd, 'piped-input.txt');
    writeFileSync(inputFile, input, 'utf8');
    const fd = openSync(inputFile, 'r');
    const child = spawn(process.execPath, ['--import', loader, entry, ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, ROAST_HOME: home, ROASTCLI_CONFIG: '', ROAST_DIAGNOSTICS: '0' },
      stdio: [fd, 'pipe', 'pipe'],
    });
    closeSync(fd);
    let out = '',
      err = '';
    child.stdout!.on('data', (data) => {
      out += data.toString();
    });
    child.stderr!.on('data', (data) => {
      err += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
describe('CLI 0.6 options', () => {
  it('accepts valueless -p, combines prompts, supports Hive stdin and exports actual logs', async () => {
    const requests: { messages: { content: unknown }[]; tools: { function: { name: string } }[] }[] = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      requests.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '中文回答' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const ws = tempWorkspace(),
      home = tempWorkspace();
    home.file(
      'config.json',
      JSON.stringify({
        providers: {
          mock: {
            driver: 'openai-compat',
            auth: 'none',
            baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            models: { m: { pricing: { input: 1, output: 1 } } },
          },
        },
        default: 'mock:m',
        swarm: { worktrees: false },
      }),
    );
    try {
      const result = await cli(
        ws.dir,
        home.dir,
        ['-p', '--output-format', 'json', '--allowed-tools', 'read,grep', '--disallowed-tools', 'web_*'],
        '\uFEFFdiff from stdin',
      );
      expect(result.code, result.err).toBe(0);
      const json = JSON.parse(result.out);
      expect(json).toMatchObject({ subtype: 'success', result: '中文回答' });
      expect(JSON.stringify(requests[0]!.messages)).toContain('diff from stdin');
      expect(requests[0]!.tools.some((tool) => tool.function.name === 'web_fetch')).toBe(false);
      const combined = await cli(ws.dir, home.dir, ['-p', 'review'], 'diff');
      expect(combined.code).toBe(0);
      expect(JSON.stringify(requests[1]!.messages)).toContain('review\\n\\n<stdin>\\ndiff\\n</stdin>');
      const hive = await cli(ws.dir, home.dir, ['hive', '--print', '--output-format', 'json'], 'hive goal');
      expect(hive.code).toBe(0);
      expect(JSON.stringify(requests[2]!.messages)).toContain('hive goal');
      const exported = await cli(ws.dir, home.dir, ['logs', 'export', json.runId]);
      expect(exported.code).toBe(0);
      expect(exported.out).toContain('## RoastCli\n\n中文回答');
      const saved = await cli(ws.dir, home.dir, ['logs', 'export', json.runId, 'saved.md']);
      expect(saved.code).toBe(0);
      expect(readFileSync(`${ws.dir}/saved.md`, 'utf8')).toContain('中文回答');
      const collision = await cli(ws.dir, home.dir, ['logs', 'export', json.runId, 'saved.md']);
      expect(collision.code).toBe(1);
      expect(collision.err).toContain('拒绝覆盖');
      const empty = await cli(ws.dir, home.dir, ['-p'], ' \n');
      expect(empty.code).toBe(1);
      expect(empty.err).toContain('请提供 -p');
      for (const args of [
        ['-p', 'hi', '--max-steps', '0'],
        ['--max-budget-usd', '1'],
        ['-p', 'hi', '--allowed-tools', 'bash('],
      ])
        expect((await cli(ws.dir, home.dir, args)).code).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 30000);
});
