import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VERSION } from '../core/version.js';
import { object, remoteJson } from '../ext/http-json.js';

const RELEASES = 'https://github.com/Roast-2007/RoastCli/releases';
const LATEST_API = 'https://api.github.com/repos/Roast-2007/RoastCli/releases/latest';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface LatestRelease {
  version: string;
}

export function isNewerVersion(latest: string, current: string): boolean {
  if (!STABLE_VERSION.test(latest)) return false;
  const base = current.split(/[+-]/)[0]!;
  if (!STABLE_VERSION.test(base)) return false;
  const left = latest.split('.').map(BigInt),
    right = base.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }
  return current.slice(base.length).startsWith('-');
}

export function manualUpdateCommand(platform = process.platform): string {
  return `${platform === 'win32' ? 'npm.cmd' : 'npm'} install -g --prefer-online ${RELEASES}/latest/download/roastcli.tgz`;
}

export function updateNotice(release: LatestRelease): string {
  return `发现 RoastCli 新版本 ${release.version}（当前 ${VERSION}）。可继续使用；退出后运行 roast update 更新。\n手动更新：${manualUpdateCommand()}`;
}

/** Fixed public endpoint: never use project URLs, credentials, hooks or provider configuration. */
export async function latestRelease(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LatestRelease> {
  const payload = object(
    await remoteJson(LATEST_API, '', {
      label: 'RoastCli 更新检测',
      method: 'GET',
      timeoutMs: opts.timeoutMs ?? 3000,
      signal: opts.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': `RoastCli/${VERSION}` },
    }),
  );
  const tag = payload['tag_name'];
  if (
    payload['draft'] !== false ||
    payload['prerelease'] !== false ||
    typeof tag !== 'string' ||
    tag.length > 64 ||
    !tag.startsWith('v') ||
    !STABLE_VERSION.test(tag.slice(1))
  ) {
    throw new Error('未找到有效的正式版本');
  }
  const assets = payload['assets'];
  const url = `${RELEASES}/download/${tag}/roastcli.tgz`;
  if (
    !Array.isArray(assets) ||
    !assets.some((asset) => object(asset)['name'] === 'roastcli.tgz' && object(asset)['browser_download_url'] === url)
  ) {
    throw new Error('正式版本缺少官方安装包');
  }
  return { version: tag.slice(1) };
}

/** Each interactive launch checks once; offline, timeout and rate limits stay silent. */
export async function checkForUpdate(opts: { signal?: AbortSignal } = {}): Promise<LatestRelease | undefined> {
  try {
    const release = await latestRelease(opts);
    return isNewerVersion(release.version, VERSION) ? release : undefined;
  } catch {
    return undefined;
  }
}

/** Called only by an explicit `roast update`; remote metadata never supplies executable text. */
export async function installRelease(release: LatestRelease): Promise<boolean> {
  if (!STABLE_VERSION.test(release.version)) throw new Error('无效的更新版本');
  const cwd = mkdtempSync(path.join(tmpdir(), 'roast-update-'));
  const args = ['install', '--global', '--prefer-online', `${RELEASES}/download/v${release.version}/roastcli.tgz`];
  try {
    return await new Promise<boolean>((resolve) => {
      // npm.cmd is a batch file, so Windows needs cmd.exe; all arguments are fixed or validated digits.
      const child =
        process.platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], { cwd, stdio: 'inherit', windowsHide: true })
          : spawn('npm', args, { cwd, stdio: 'inherit' });
      child.once('error', () => resolve(false));
      child.once('close', (code) => resolve(code === 0));
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export async function runUpdate(opts: { check?: boolean } = {}): Promise<number> {
  let release: LatestRelease;
  try {
    release = await latestRelease({ timeoutMs: 10_000 });
  } catch {
    process.stderr.write(`更新检测失败，请稍后重试，或手动更新：\n${manualUpdateCommand()}\n`);
    return 1;
  }
  if (!isNewerVersion(release.version, VERSION)) {
    process.stdout.write(`当前版本 ${VERSION}，无需更新（最新正式版本 ${release.version}）。\n`);
    return 0;
  }
  if (opts.check) {
    process.stdout.write(updateNotice(release) + '\n');
    return 0;
  }
  process.stdout.write(`正在安装 RoastCli ${release.version}…\n`);
  let installed = false;
  try {
    installed = await installRelease(release);
  } catch {
    /* Report the manual fallback below. */
  }
  if (!installed) {
    process.stderr.write(`更新失败；请检查网络和 npm 全局目录的写入权限，再运行：\n${manualUpdateCommand()}\n`);
    return 1;
  }
  process.stdout.write(`已更新到 ${release.version}。重新运行 roast；用 roast --version 确认版本。\n`);
  return 0;
}
