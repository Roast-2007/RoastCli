import { writeFileSync, existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { readClipboardImage, writeClipboardText, type ClipboardExecutor } from '../../src/core/clipboard.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
describe('clipboard images', () => {
  it.each(['win32', 'darwin'] as const)('uses a temporary PNG and always deletes it on %s', async (platform) => {
    let target = '';
    const exec: ClipboardExecutor = vi.fn(async (_command, _args, opts) => {
      target = opts.env['ROAST_CLIPBOARD_IMAGE']!;
      writeFileSync(target, png);
      return Buffer.alloc(0);
    });
    expect(await readClipboardImage({ platform, env: {}, exec })).toMatchObject({ ok: true, image: { mediaType: 'image/png' } });
    expect(existsSync(target)).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      platform === 'win32' ? 'powershell.exe' : 'osascript',
      expect.any(Array),
      expect.objectContaining({ timeout: 5000, windowsHide: true }),
    );
    if (platform === 'win32')
      expect((exec as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual(
        expect.arrayContaining(['-STA', '-NoProfile', '-NonInteractive']),
      );
  });
  it('reads Windows file-drop output without evaluating the path as code', async () => {
    const file = tempWorkspace().file('a b.png', '');
    writeFileSync(file, png);
    expect(await readClipboardImage({ platform: 'win32', exec: async () => Buffer.from(file) })).toMatchObject({ ok: true, source: file });
  });
  it.each([true, false])('checks MIME types before reading Linux image data (Wayland=%s)', async (wayland) => {
    const exec = vi.fn<ClipboardExecutor>().mockResolvedValueOnce(Buffer.from('text/plain\nimage/png\n')).mockResolvedValueOnce(png);
    expect((await readClipboardImage({ platform: 'linux', env: wayland ? { WAYLAND_DISPLAY: 'wayland-0' } : {}, exec })).ok).toBe(true);
    expect(exec.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      wayland
        ? [
            ['wl-paste', ['--list-types']],
            ['wl-paste', ['--type', 'image/png']],
          ]
        : [
            ['xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']],
            ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
          ],
    );
  });
  it('reports missing dependencies, no image, invalid bytes, oversize and timeout', async () => {
    const opts = { platform: 'linux' as const, env: {} };
    expect(
      await readClipboardImage({
        ...opts,
        exec: async () => {
          throw Object.assign(new Error(), { code: 'ENOENT' });
        },
      }),
    ).toMatchObject({ reason: '需要安装 wl-clipboard 或 xclip' });
    expect(await readClipboardImage({ ...opts, exec: async () => Buffer.from('text/plain') })).toMatchObject({
      reason: '剪贴板中没有图片',
    });
    for (const bytes of [Buffer.from('bad'), Buffer.alloc(5 * 1024 * 1024 + 1)]) {
      const exec = vi.fn<ClipboardExecutor>().mockResolvedValueOnce(Buffer.from('image/png')).mockResolvedValueOnce(bytes);
      expect((await readClipboardImage({ ...opts, exec })).ok).toBe(false);
    }
    expect(
      await readClipboardImage({
        platform: 'win32',
        exec: async () => {
          throw { killed: true };
        },
      }),
    ).toMatchObject({ reason: '读取剪贴板超时' });
  });
});
describe('clipboard text', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('passes Chinese text via stdin on %s', async (platform) => {
    const exec = vi.fn<ClipboardExecutor>().mockResolvedValue(Buffer.alloc(0));
    expect(await writeClipboardText('中文\n$秘密', { platform, env: { WAYLAND_DISPLAY: 'w' }, exec })).toEqual({
      ok: true,
      method: '系统剪贴板',
    });
    expect(exec.mock.calls[0]![0]).toBe({ win32: 'powershell.exe', darwin: 'pbcopy', linux: 'wl-copy' }[platform]);
    expect(exec.mock.calls[0]![2]).toMatchObject({ input: '中文\n$秘密', env: { LANG: 'en_US.UTF-8' } });
    if (platform === 'win32') expect(exec.mock.calls[0]![1].join(' ')).toContain('UTF8Encoding');
  });
  it('falls back through Linux native commands', async () => {
    const exec = vi
      .fn<ClipboardExecutor>()
      .mockRejectedValueOnce(new Error())
      .mockRejectedValueOnce(new Error())
      .mockResolvedValueOnce(Buffer.alloc(0));
    expect((await writeClipboardText('text', { platform: 'linux', env: { WAYLAND_DISPLAY: 'w' }, exec })).ok).toBe(true);
    expect(exec.mock.calls.map((call) => call[0])).toEqual(['wl-copy', 'xclip', 'xsel']);
  });
  it('uses OSC 52 over SSH, wraps tmux, and refuses oversized or non-TTY output', async () => {
    let text = '';
    const stdout = {
        isTTY: true,
        write: (value: string) => {
          text += value;
        },
      },
      exec = vi.fn<ClipboardExecutor>();
    expect(await writeClipboardText('你好', { env: { SSH_CONNECTION: 'ssh', TMUX: 'tmux' }, stdout, exec })).toEqual({
      ok: true,
      method: '终端 OSC 52',
    });
    expect(exec).not.toHaveBeenCalled();
    expect(text).toBe(`\x1bPtmux;\x1b\x1b]52;c;${Buffer.from('你好').toString('base64')}\x07\x1b\\`);
    expect((await writeClipboardText('x'.repeat(100 * 1024), { env: { SSH_TTY: 'ssh' }, stdout })).ok).toBe(false);
    expect((await writeClipboardText('x', { env: { SSH_TTY: 'ssh' }, stdout: { ...stdout, isTTY: false } })).ok).toBe(false);
  });
});
