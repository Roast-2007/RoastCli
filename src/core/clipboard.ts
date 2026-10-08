import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImageBlock } from './types.js';
import { MAX_IMAGE_BYTES, imageMediaType } from '../tools/read/image.js';

export type ClipboardImage = { ok: true; image: ImageBlock; source: string } | { ok: false; reason: string };
export interface ClipboardExecOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  windowsHide: true;
  input?: string;
}
export type ClipboardExecutor = (command: string, args: string[], opts: ClipboardExecOptions) => Promise<Buffer>;
export interface ClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ClipboardExecutor;
  stdout?: { isTTY?: boolean; write(text: string): unknown };
}

const execute: ClipboardExecutor = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...opts, encoding: 'buffer', maxBuffer: MAX_IMAGE_BYTES + 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });
const winImage = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [System.Windows.Forms.Clipboard]::GetImage()
  try { $image.Save($env:ROAST_CLIPBOARD_IMAGE, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }
} elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  foreach ($file in [System.Windows.Forms.Clipboard]::GetFileDropList()) {
    if ($file -match '\\.(png|jpe?g|gif|webp)$') { [Console]::Write($file); exit 0 }
  }
  exit 3
} else { exit 3 }`;
const macImage = `on run argv
try
set imageData to the clipboard as «class PNGf»
set imageFile to open for access POSIX file (item 1 of argv) with write permission
try
set eof imageFile to 0
write imageData to imageFile
on error messageText
close access imageFile
error messageText
end try
close access imageFile
on error
error "No clipboard image" number 3
end try
end run`;

async function readImageBytes(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('图片路径不是文件');
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

export async function readClipboardImage(opts: ClipboardOptions = {}): Promise<ClipboardImage> {
  const platform = opts.platform ?? process.platform,
    env = opts.env ?? process.env;
  const file = path.join(os.tmpdir(), `roast-clipboard-${randomUUID()}.png`);
  const run = (command: string, args: string[]) =>
    (opts.exec ?? execute)(command, args, { env: { ...env, ROAST_CLIPBOARD_IMAGE: file }, timeout: 5000, windowsHide: true });
  try {
    let bytes: Buffer,
      source = '剪贴板';
    if (platform === 'win32') {
      const output = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', winImage])).toString('utf8').trim();
      source = output || source;
      bytes = await readImageBytes(output || file);
    } else if (platform === 'darwin') {
      await run('osascript', ['-e', macImage, file]);
      bytes = await readImageBytes(file);
    } else {
      const wayland = !!env['WAYLAND_DISPLAY'];
      const types = await run(
        wayland ? 'wl-paste' : 'xclip',
        wayland ? ['--list-types'] : ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
      );
      if (!types.toString().split(/\s+/).includes('image/png')) return { ok: false, reason: '剪贴板中没有图片' };
      bytes = await run(
        wayland ? 'wl-paste' : 'xclip',
        wayland ? ['--type', 'image/png'] : ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      );
    }
    if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: '图片超过 5 MiB' };
    const mediaType = imageMediaType(bytes);
    return mediaType
      ? { ok: true, image: { type: 'image', mediaType, data: bytes.toString('base64') }, source }
      : { ok: false, reason: '不支持的图片格式；请使用 PNG/JPEG/GIF/WebP' };
  } catch (err) {
    const e = err as { code?: string | number; killed?: boolean; message?: string };
    return {
      ok: false,
      reason:
        e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? '图片超过 5 MiB'
          : e.code === 'ENOENT' && platform === 'linux'
            ? '需要安装 wl-clipboard 或 xclip'
            : e.killed
              ? '读取剪贴板超时'
              : e.code === 3 || platform === 'darwin'
                ? '剪贴板中没有图片'
                : `无法读取剪贴板图片：${e.message ?? String(err)}`,
    };
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

export async function writeClipboardText(
  text: string,
  opts: ClipboardOptions = {},
): Promise<{ ok: true; method: '系统剪贴板' | '终端 OSC 52' } | { ok: false; reason: string }> {
  const platform = opts.platform ?? process.platform,
    env = opts.env ?? process.env,
    stdout = opts.stdout ?? process.stdout;
  const run = (command: string, args: string[]) =>
    (opts.exec ?? execute)(command, args, { env: { ...env, LANG: 'en_US.UTF-8' }, input: text, timeout: 5000, windowsHide: true });
  if (!env['SSH_TTY'] && !env['SSH_CONNECTION']) {
    const commands: [string, string[]][] =
      platform === 'win32'
        ? [
            [
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text',
              ],
            ],
          ]
        : platform === 'darwin'
          ? [['pbcopy', []]]
          : [
              ...(env['WAYLAND_DISPLAY'] ? [['wl-copy', []] as [string, string[]]] : []),
              ['xclip', ['-selection', 'clipboard']],
              ['xsel', ['--clipboard', '--input']],
            ];
    for (const [command, args] of commands) {
      try {
        await run(command, args);
        return { ok: true, method: '系统剪贴板' };
      } catch {
        /* Try the next native clipboard. */
      }
    }
  }
  if (!stdout.isTTY) return { ok: false, reason: '剪贴板不可用；请改用 /export' };
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  if (base64.length > 100 * 1024) return { ok: false, reason: '复制内容超过 OSC 52 限制；请改用 /export' };
  const osc = `\x1b]52;c;${base64}\x07`;
  stdout.write(env['TMUX'] ? `\x1bPtmux;${osc.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : osc);
  return { ok: true, method: '终端 OSC 52' };
}
