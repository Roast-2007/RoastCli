import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, installRelease, isNewerVersion, latestRelease, manualUpdateCommand, runUpdate } from '../../src/cli/update.js';
import { VERSION } from '../../src/core/version.js';

vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn: vi.fn() }));

const nextVersion = VERSION.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));
const release = (version = nextVersion) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    { name: 'roastcli.tgz', browser_download_url: `https://github.com/Roast-2007/RoastCli/releases/download/v${version}/roastcli.tgz` },
  ],
});
let request: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(release()));
  vi.stubGlobal('fetch', request);
  vi.mocked(spawn).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('release update detection', () => {
  it('compares numeric versions, never downgrades and replaces prereleases with stable versions', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.4.1', '0.4.1')).toBe(false);
    expect(isNewerVersion('0.4.0', '0.4.1')).toBe(false);
    expect(isNewerVersion('0.4.1', '0.4.1-rc.1')).toBe(true);
    expect(isNewerVersion('0.4.1', '0.4.1+build.1')).toBe(false);
    expect(isNewerVersion('0.4.1', '0.4.1+build-alpha')).toBe(false);
    expect(isNewerVersion('0.4.2-rc.1', '0.4.1')).toBe(false);
    expect(isNewerVersion('0.04.2', '0.4.1')).toBe(false);
    expect(isNewerVersion('0.4.2', 'unknown')).toBe(false);
  });

  it('checks the fixed official endpoint on every launch without credentials or redirects', async () => {
    expect(await checkForUpdate()).toEqual({ version: nextVersion });
    expect(await checkForUpdate()).toEqual({ version: nextVersion });
    expect(request).toHaveBeenCalledTimes(2);
    const [url, options] = request.mock.calls[0]!;
    expect(String(url)).toBe('https://api.github.com/repos/Roast-2007/RoastCli/releases/latest');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { 'user-agent': `RoastCli/${VERSION}` } });
    expect(options?.headers).not.toHaveProperty('authorization');
    expect(options?.body).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('ignores equal and older versions and rejects drafts, prereleases and untrusted or missing packages', async () => {
    for (const version of [VERSION, '0.4.0']) {
      request.mockResolvedValueOnce(Response.json(release(version)));
      expect(await checkForUpdate()).toBeUndefined();
    }
    for (const payload of [
      { ...release(), draft: true },
      { ...release(), prerelease: true },
      { ...release(), tag_name: 'v0.4.2;echo bad' },
      { ...release(), assets: [] },
      { ...release(), assets: [{ name: 'roastcli.tgz', browser_download_url: 'https://example.com/roastcli.tgz' }] },
    ]) {
      request.mockResolvedValueOnce(Response.json(payload));
      expect(await checkForUpdate()).toBeUndefined();
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('silently skips network errors, rate limits and malformed responses', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    request.mockResolvedValueOnce(new Response('private error', { status: 429 }));
    request.mockResolvedValueOnce(new Response('invalid json'));
    for (let i = 0; i < 3; i++) expect(await checkForUpdate()).toBeUndefined();
  });

  it('bounds slow requests and cancels an in-flight startup check on exit', async () => {
    request.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    await expect(latestRelease({ timeoutMs: 10 })).rejects.toThrow('超时');
    const abort = new AbortController();
    const checking = checkForUpdate({ signal: abort.signal });
    abort.abort();
    expect(await checking).toBeUndefined();
  });
});

describe('explicit update command', () => {
  function installer(code: number | null, error = false) {
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit(error ? 'error' : 'close', error ? new Error('npm unavailable') : code));
      return child as ReturnType<typeof spawn>;
    });
  }

  it('only installs when explicitly requested and uses a pinned official package in an isolated directory', async () => {
    installer(0);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await runUpdate({ check: true })).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(await runUpdate()).toBe(0);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe(process.platform === 'win32' ? 'cmd.exe' : 'npm');
    expect(args).toContain(`https://github.com/Roast-2007/RoastCli/releases/download/v${nextVersion}/roastcli.tgz`);
    expect(args).toContain('--global');
    expect(args).toContain('--prefer-online');
    expect(options).toMatchObject({ stdio: 'inherit' });
    expect(options).not.toHaveProperty('shell');
    expect(options?.cwd).not.toBe(process.cwd());
    expect(existsSync(String(options?.cwd))).toBe(false);
    expect(out.mock.calls.flat().join('')).toContain(`已更新到 ${nextVersion}`);
  });

  it('does not reinstall or downgrade when already current', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    request.mockResolvedValueOnce(Response.json(release(VERSION)));
    expect(await runUpdate()).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a manual command when detection, npm lookup or installation fails', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    request.mockRejectedValueOnce(new Error('offline'));
    expect(await runUpdate()).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    installer(1);
    expect(await runUpdate()).toBe(1);
    installer(null, true);
    expect(await runUpdate()).toBe(1);
    expect(err.mock.calls.flat().join('')).toContain(manualUpdateCommand());
    expect(err.mock.calls.flat().join('')).toContain('写入权限');
  });

  it('rejects executable version text before starting npm', async () => {
    await expect(installRelease({ version: '0.4.2 & echo injected' })).rejects.toThrow('无效');
    expect(spawn).not.toHaveBeenCalled();
    expect(manualUpdateCommand('win32')).toMatch(/^npm\.cmd install/);
    expect(manualUpdateCommand('linux')).toMatch(/^npm install/);
  });
});
