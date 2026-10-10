/**
 * 「帮我审批」按命令名匹配的高风险规则：git 丢弃 / 改写历史、对外推送与发布、
 * 安装依赖与系统软件、系统设置、结束进程、向外发送数据。
 * 输入是已经去掉包装命令和重定向的命令名与参数；返回高风险原因，低风险返回 null。
 */

type Rule = (args: string[]) => string | null;

const R = {
  discard: '丢弃工作区中未提交的改动',
  history: '改写提交历史',
  push: '推送到远端仓库',
  publish: '发布或撤回软件包',
  image: '推送容器镜像',
  github: '修改 GitHub 上的内容',
  cluster: '修改 Kubernetes 集群资源',
  infra: '变更云端基础设施',
  deploy: '部署到线上环境',
  dep: '新增依赖包',
  global: '全局安装软件包',
  system: '安装或卸载系统软件',
  remote: '下载并运行远程软件包',
  mode: '修改文件权限',
  owner: '修改文件所有者',
  registry: '修改注册表',
  envVar: '永久修改环境变量',
  service: '管理系统服务',
  schedule: '修改计划任务',
  kill: '强制结束进程',
  firewall: '修改网络或防火墙配置',
  disk: '修改磁盘或启动配置',
  upload: '向外部服务器发送数据',
  transfer: '通过网络传输文件',
  remoteShell: '连接远程主机',
  rawNet: '建立原始网络连接',
} as const;

const NO_VALUES: ReadonlySet<string> = new Set();
const isOption = (a: string) => a.startsWith('-') && a !== '-';
const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a));
const hasCi = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a.toLowerCase()));

/** 非选项参数；withValue 中的选项会吞掉下一个参数，`--` 之后全部算位置参数 */
export function positionals(args: string[], withValue: ReadonlySet<string> = NO_VALUES): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return [...out, ...args.slice(i + 1)];
    if (isOption(a)) {
      if (withValue.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `-X VALUE` / `-XVALUE` / `--request=VALUE` 形式的选项值 */
function optionValue(args: string[], short: string | null, long: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === long || a === short) return args[i + 1];
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
    if (short && a.startsWith(short) && a.length > short.length && !a.startsWith('--')) return a.slice(short.length);
  }
  return undefined;
}

/** 首个位置参数（小写）落在 subs 中即命中 */
function subcommand(table: [string[], string][], withValue: ReadonlySet<string> = NO_VALUES): Rule {
  return (args) => {
    const sub = positionals(args, withValue)[0]?.toLowerCase();
    if (!sub) return null;
    return table.find(([subs]) => subs.includes(sub))?.[1] ?? null;
  };
}

const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
/** 这些配置项能让 git 执行任意命令 */
const GIT_EXEC_CONFIG = /^(?:alias\.|core\.(?:hookspath|sshcommand|pager|editor|fsmonitor|askpass)|credential\.helper)/i;
/** 短选项簇中是否含某个字母，如 -fdx 含 f */
const shortFlag = (args: string[], letter: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));

function git(args: string[]): string | null {
  let i = 0;
  while (i < args.length && isOption(args[i]!)) {
    const option = args[i]!;
    const value = option === '-c' ? args[i + 1] : option.startsWith('--config-env=') ? option.slice(13) : undefined;
    if (value !== undefined && GIT_EXEC_CONFIG.test(value)) return '通过 git 配置执行任意命令';
    i += GIT_VALUE.has(option) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  switch (sub) {
    case 'push':
      return R.push;
    case 'restore':
      return has(rest, '--staged', '-S') && !has(rest, '--worktree', '-W') ? null : R.discard;
    case 'checkout':
      // git checkout <ref> <路径> 用 ref 中的版本覆盖文件
      return has(rest, '--', '.', '-f', '--force') || positionals(rest, new Set(['-b', '-B', '--orphan'])).length >= 2 ? R.discard : null;
    case 'update-ref':
      return has(rest, '-d', '--delete') ? '删除 git 引用' : null;
    case 'switch':
      return has(rest, '-f', '--force', '--discard-changes') ? R.discard : null;
    case 'reset':
      return has(rest, '--hard', '--merge', '--keep') ? R.discard : null;
    case 'clean':
      return (has(rest, '--force') || shortFlag(rest, 'f')) && !(has(rest, '--dry-run') || shortFlag(rest, 'n'))
        ? '删除未跟踪的文件'
        : null;
    case 'stash':
      return has(rest.slice(0, 1), 'drop', 'clear') ? '删除 stash 中保存的改动' : null;
    case 'branch':
      return shortFlag(rest, 'D') || ((has(rest, '--delete') || shortFlag(rest, 'd')) && (has(rest, '--force') || shortFlag(rest, 'f')))
        ? '强制删除分支'
        : null;
    case 'rebase':
      return rest.some((a) => /^--(?:abort|continue|skip|quit|edit-todo|show-current-patch)$/.test(a)) ? null : R.history;
    case 'filter-branch':
    case 'filter-repo':
      return R.history;
    case 'reflog':
      return has(rest.slice(0, 1), 'expire', 'delete') ? '清理 reflog 中可恢复的记录' : null;
    case 'config': {
      if (rest.some((a) => /^(?:--get(?:-all|-regexp)?|--list|-l)$/.test(a))) return null;
      const [key, value] = positionals(rest);
      const writes = value !== undefined || has(rest, '--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e');
      if (key && writes && GIT_EXEC_CONFIG.test(key)) return '通过 git 配置执行任意命令';
      return writes && has(rest, '--global', '--system') ? '修改 git 全局配置' : null;
    }
    default:
      return null;
  }
}

const PUBLISH = new Set(['publish', 'unpublish']);
const isGlobal = (args: string[]) =>
  has(args, '-g', '--global', '--location=global') || args.some((a, i) => a === '--location' && args[i + 1] === 'global');
const NPM_INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);
const NPM_VALUE = new Set(['--prefix', '-w', '--workspace', '--registry', '--loglevel', '--userconfig', '--cache']);
const PNPM_VALUE = new Set([
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--workspace',
  '--reporter',
  '--loglevel',
  '--registry',
  '--store-dir',
]);

function npm(args: string[]): string | null {
  const [sub, ...rest] = positionals(args, NPM_VALUE);
  if (sub === undefined) return null;
  if (PUBLISH.has(sub) || sub === 'deprecate') return R.publish;
  const installs = NPM_INSTALL.has(sub) || ['update', 'up', 'upgrade', 'link', 'ln'].includes(sub);
  if (installs && isGlobal(args)) return R.global;
  if (NPM_INSTALL.has(sub) && rest.length > 0) return R.dep;
  return (sub === 'exec' || sub === 'x') && has(args, '-y', '--yes') ? R.remote : null;
}

function pnpm(args: string[]): string | null {
  const [sub, ...rest] = positionals(args, PNPM_VALUE);
  if (sub === undefined) return null;
  if (PUBLISH.has(sub)) return R.publish;
  if (sub === 'dlx') return R.remote;
  if (['add', 'install', 'i', 'update', 'up', 'upgrade', 'link', 'ln'].includes(sub) && isGlobal(args)) return R.global;
  return sub === 'add' || ((sub === 'install' || sub === 'i') && rest.length > 0) ? R.dep : null;
}

function yarn(args: string[]): string | null {
  const [sub, ...rest] = positionals(args, new Set(['--cwd', '--registry']));
  if (sub === undefined) return null;
  if (PUBLISH.has(sub) || (sub === 'npm' && rest[0] === 'publish')) return R.publish;
  if (sub === 'dlx') return R.remote;
  if (sub === 'global' && rest[0] === 'add') return R.global;
  return sub === 'add' ? R.dep : null;
}

function bun(args: string[]): string | null {
  const [sub, ...rest] = positionals(args);
  if (sub === undefined) return null;
  if (PUBLISH.has(sub)) return R.publish;
  const adds = sub === 'add' || sub === 'a' || ((sub === 'install' || sub === 'i') && rest.length > 0);
  if ((adds || ['install', 'i', 'update'].includes(sub)) && isGlobal(args)) return R.global;
  return adds ? R.dep : null;
}

const PIP_VALUE = new Set([
  ...['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-t', '--target', '--prefix', '--root', '--src'],
  ...['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--platform', '--python-version', '--implementation', '--abi'],
  ...['--cache-dir', '--log', '--python', '--report', '--progress-bar', '--trusted-host', '--proxy', '--timeout', '--retries'],
  ...['--exists-action', '--cert', '--client-cert', '--upgrade-strategy', '--config-settings', '-C'],
]);

/** pip install：-r / -e 与本地路径（./、../）之外的包名都算新增依赖 */
export function pipInstall(args: string[]): string | null {
  const [sub, ...rest] = positionals(args, PIP_VALUE);
  if (sub !== 'install') return null;
  // 本地路径与升级打包工具本身不算新增依赖
  return rest.some((a) => !/^\.{1,2}(?:[\\/]|$)/.test(a) && !/^(?:pip|setuptools|wheel)$/i.test(a)) ? R.dep : null;
}

function uv(args: string[]): string | null {
  const [sub, next] = positionals(args, new Set(['--directory', '--project', '-p', '--python']));
  if (sub === 'add') return R.dep;
  if (sub === 'publish') return R.publish;
  if (sub === 'pip' && next === 'install') return pipInstall(args.slice(args.indexOf('pip') + 1));
  return sub === 'tool' && next === 'install' ? R.global : null;
}

function python(args: string[]): string | null {
  const m = args.indexOf('-m');
  if (m < 0) return null;
  const module = args[m + 1] ?? '';
  if (/^pip3?$/.test(module)) return pipInstall(args.slice(m + 2));
  return module === 'twine' && args[m + 2] === 'upload' ? R.publish : null;
}

const GH_WRITES: Record<string, string[]> = {
  release: ['create', 'delete', 'edit', 'upload', 'delete-asset'],
  pr: ['create', 'merge', 'close', 'reopen', 'comment', 'review', 'edit', 'ready', 'lock', 'unlock'],
  issue: ['create', 'close', 'reopen', 'delete', 'comment', 'edit', 'transfer', 'lock', 'unlock', 'pin', 'unpin'],
  repo: ['create', 'delete', 'edit', 'rename', 'archive', 'unarchive', 'fork', 'sync'],
  workflow: ['run', 'enable', 'disable'],
  run: ['cancel', 'rerun', 'delete'],
  secret: ['set', 'delete', 'remove'],
  variable: ['set', 'delete'],
  gist: ['create', 'delete', 'edit'],
  label: ['create', 'delete', 'edit', 'clone'],
  cache: ['delete'],
};

function gh(args: string[]): string | null {
  const [group, action] = positionals(args, new Set(['-R', '--repo', '--hostname']));
  if (group === 'api') {
    const method = optionValue(args, '-X', '--method');
    if (method) return method.toUpperCase() === 'GET' ? null : R.github;
    return args.some((a) => /^(?:-f|-F|--field|--raw-field|--input)$/.test(a) || /^--(?:field|raw-field|input)=/.test(a)) ? R.github : null;
  }
  return group && action && GH_WRITES[group]?.includes(action) ? R.github : null;
}

const KUBE_VALUE = new Set(['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '-l', '--selector', '-o', '--output']);
const KUBE_WRITES = [
  ...['apply', 'create', 'replace', 'patch', 'delete', 'edit', 'scale', 'autoscale', 'drain', 'cordon', 'uncordon', 'taint'],
  ...['label', 'annotate', 'set', 'exec', 'cp', 'run', 'expose', 'attach', 'debug'],
];

function kubectl(args: string[]): string | null {
  const [sub, next] = positionals(args, KUBE_VALUE);
  if (!sub) return null;
  if (KUBE_WRITES.includes(sub)) return R.cluster;
  return sub === 'rollout' && ['restart', 'undo', 'pause', 'resume'].includes(next ?? '') ? R.cluster : null;
}

function terraform(args: string[]): string | null {
  const [sub, next] = positionals(args);
  if (['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock'].includes(sub ?? '')) return R.infra;
  return sub === 'state' && ['rm', 'mv', 'push', 'replace-provider'].includes(next ?? '') ? R.infra : null;
}

function vercel(args: string[]): string | null {
  if (has(args, '--prod', '--production')) return R.deploy;
  const [sub] = positionals(args, new Set(['--scope', '--token', '-t', '--cwd', '-A', '--local-config']));
  if (sub === undefined) return has(args, '--help', '-h', '--version', '-v') ? null : R.deploy;
  return ['deploy', 'remove', 'rm', 'promote', 'rollback', 'redeploy'].includes(sub) ? R.deploy : null;
}

function docker(args: string[]): string | null {
  const [sub, next] = positionals(args, new Set(['-H', '--host', '--context', '--config', '-c']));
  const pushes = sub === 'push' || ((sub === 'image' || sub === 'compose') && next === 'push');
  return pushes || (sub === 'buildx' && next === 'build' && has(args, '--push')) ? R.image : null;
}

function chmod(args: string[]): string | null {
  if (args.some((a) => /^-[a-zA-Z]*R/.test(a) || a === '--recursive')) return R.mode;
  const mode = positionals(args)[0] ?? '';
  const worldWritable = /^[0-7]{3,4}$/.test(mode) ? (Number(mode.at(-1)) & 2) !== 0 : /(?:^|,)[ugo]*[ao][ugo]*[+=][rwxXst]*w/.test(mode);
  return worldWritable ? R.mode : null;
}

function kill(args: string[]): string | null {
  const after = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const signal = optionValue(args, null, '--signal') ?? after('-s') ?? after('-n');
  return args.some((a) => /^-(?:9|KILL|SIGKILL)$/i.test(a)) || /^(?:9|KILL|SIGKILL)$/i.test(signal ?? '') ? R.kill : null;
}

const LOOPBACK = /^(?:https?:\/\/)?(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i;
const SAFE_METHOD = /^(?:GET|HEAD|OPTIONS)$/i;

/** 只发往本机（本地开发服务器）的请求不算外传 */
function upload(args: string[], sends: boolean): string | null {
  const urls = args.filter((a) => /^https?:\/\//i.test(a) || LOOPBACK.test(a));
  return sends && !(urls.length > 0 && urls.every((u) => LOOPBACK.test(u))) ? R.upload : null;
}

function curl(args: string[]): string | null {
  const method = optionValue(args, '-X', '--request');
  const sends = args.some(
    (a) => /^--(?:data(?:-\w+)?|form(?:-string)?|upload-file|json)(?:=|$)/.test(a) || (!a.startsWith('-X') && /^-[a-zA-Z]*[dFT]/.test(a)),
  );
  return upload(args, (method !== undefined && !SAFE_METHOD.test(method)) || sends);
}

function wget(args: string[]): string | null {
  const method = optionValue(args, null, '--method');
  const sends = args.some((a) => /^--(?:post-(?:data|file)|body-(?:data|file))(?:=|$)/.test(a));
  return upload(args, (method !== undefined && !SAFE_METHOD.test(method)) || sends);
}

function invokeWeb(args: string[]): string | null {
  const lower = args.map((a) => a.toLowerCase());
  const i = lower.indexOf('-method');
  const method = i >= 0 ? lower[i + 1] : lower.find((a) => a.startsWith('-method:'))?.slice(8);
  return upload(args, (method !== undefined && !SAFE_METHOD.test(method)) || hasCi(args, '-body', '-infile'));
}

function rsync(args: string[]): string | null {
  return positionals(args, new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f'])).some(
    (a) => /^[^/\\]{2,}:/.test(a) || a.startsWith('rsync://'),
  )
    ? R.transfer
    : null;
}

const CLOUD_VALUE = new Set(['--profile', '--region', '--project', '--output', '-o', '--subscription', '--resource-group', '-g']);

/** aws / gcloud / az：部署、创建、删除、更新类子命令与 s3 写操作 */
function cloud(args: string[]): string | null {
  const subs = positionals(args, CLOUD_VALUE);
  if (subs[0] === 's3') return ['cp', 'sync', 'mv', 'rm', 'rb', 'mb'].includes(subs[1] ?? '') ? R.infra : null;
  const writes = /^(?:deploy|create|delete|update|put|remove|set|start|stop|restart|rollback|terminate|destroy)(?:-|$)/;
  return subs.some((s) => writes.test(s)) ? R.infra : null;
}

/** Windows net：启停服务、改账户与共享 */
function net(args: string[]): string | null {
  const [sub = '', ...rest] = positionals(args).map((a) => a.toLowerCase());
  if (['start', 'stop', 'pause', 'continue'].includes(sub) && rest.length > 0) return R.service;
  const changes = args.some((a) => /^\/(?:add|delete|del|active)\b/i.test(a));
  return ['user', 'localgroup', 'group', 'accounts', 'share', 'use'].includes(sub) && (changes || rest.length > 1)
    ? '修改系统账户或共享'
    : null;
}

function startProcess(args: string[]): string | null {
  const lower = args.map((a) => a.toLowerCase());
  return lower.some((a, i) => (a === '-verb' && lower[i + 1] === 'runas') || a === '-verb:runas') ? '以管理员或其他用户身份执行' : null;
}

function always(reason: string): Rule {
  return () => reason;
}

/** 出现任一只读参数时放行，否则命中 */
function unlessAny(reason: string, ...reads: RegExp[]): Rule {
  return (args) => (args.some((a) => reads.some((re) => re.test(a))) ? null : reason);
}

/** 出现任一写入参数时命中 */
function withAny(reason: string, ...writes: RegExp[]): Rule {
  return (args) => (args.some((a) => writes.some((re) => re.test(a))) ? reason : null);
}

const SYSTEM_PACKAGES: [string, string[]][] = [
  ['brew', ['install', 'reinstall', 'upgrade', 'uninstall', 'remove', 'rm', 'tap', 'untap']],
  ['apt', ['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'full-upgrade', 'autoremove']],
  ['apt-get', ['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'autoremove']],
  ['aptitude', ['install', 'remove', 'purge', 'upgrade']],
  ['yum', ['install', 'remove', 'erase', 'update', 'upgrade']],
  ['dnf', ['install', 'remove', 'erase', 'update', 'upgrade']],
  ['zypper', ['install', 'in', 'remove', 'rm', 'update', 'up']],
  ['apk', ['add', 'del']],
  ['snap', ['install', 'remove', 'refresh']],
  ['port', ['install', 'uninstall', 'upgrade']],
  ['winget', ['install', 'uninstall', 'upgrade', 'add', 'remove']],
  ['choco', ['install', 'uninstall', 'upgrade']],
  ['scoop', ['install', 'uninstall', 'update']],
  ['conda', ['install', 'update', 'remove', 'uninstall']],
  ['mamba', ['install', 'update', 'remove', 'uninstall']],
  ['micromamba', ['install', 'update', 'remove']],
];

const SERVICE_CMDLETS = [
  'start-service',
  'stop-service',
  'restart-service',
  'set-service',
  'new-service',
  'remove-service',
  'suspend-service',
];
const TASK_CMDLETS = [
  'register-scheduledtask',
  'unregister-scheduledtask',
  'set-scheduledtask',
  'disable-scheduledtask',
  'start-scheduledtask',
];
const SYSTEMCTL_READS = [
  'status',
  'show',
  'cat',
  'help',
  'list-units',
  'list-unit-files',
  'list-timers',
  'list-sockets',
  'list-dependencies',
];

const RULES: Record<string, Rule> = {
  git,
  npm,
  pnpm,
  yarn,
  bun,
  npx: (args) => (has(args, '-y', '--yes') ? R.remote : null),
  pip: pipInstall,
  uv,
  python,
  py: python,
  gh,
  kubectl,
  kubecolor: kubectl,
  oc: kubectl,
  terraform,
  tofu: terraform,
  terragrunt: terraform,
  vercel,
  docker,
  podman: docker,
  buildah: subcommand([[['push'], R.image]]),
  chmod,
  kill,
  curl,
  wget,
  'invoke-webrequest': invokeWeb,
  iwr: invokeWeb,
  'invoke-restmethod': invokeWeb,
  irm: invokeWeb,
  rsync,
  poetry: subcommand([
    [['add'], R.dep],
    [['publish'], R.publish],
  ]),
  pdm: subcommand([
    [['add'], R.dep],
    [['publish'], R.publish],
  ]),
  pipenv: (args) => {
    const [sub, ...rest] = positionals(args);
    return sub === 'install' && rest.length > 0 ? R.dep : null;
  },
  // cargo +nightly publish：+toolchain 不是子命令
  cargo: (args) =>
    subcommand([
      [['add'], R.dep],
      [['install'], R.global],
      [['publish', 'yank'], R.publish],
    ])(args.filter((a) => !a.startsWith('+'))),
  aws: cloud,
  gcloud: cloud,
  az: cloud,
  net,
  'start-process': startProcess,
  saps: startProcess,
  start: startProcess,
  uvx: always(R.remote),
  go: subcommand([
    [['get'], R.dep],
    [['install'], R.global],
  ]),
  gem: subcommand([
    [['install', 'uninstall', 'update'], R.global],
    [['push', 'yank'], R.publish],
  ]),
  composer: subcommand([
    [['require'], R.dep],
    [['global'], R.global],
  ]),
  dotnet: (args) => {
    const [sub, next] = positionals(args);
    if (sub === 'add' && next === 'package') return R.dep;
    if (sub === 'tool' && next === 'install') return isGlobal(args) ? R.global : R.dep;
    return sub === 'nuget' && next === 'push' ? R.publish : null;
  },
  pipx: subcommand([
    [['install', 'inject', 'upgrade', 'upgrade-all'], R.global],
    [['run'], R.remote],
  ]),
  twine: subcommand([[['upload'], R.publish]]),
  changeset: subcommand([[['publish'], R.publish]]),
  flit: subcommand([[['publish'], R.publish]]),
  hatch: subcommand([[['publish'], R.publish]]),
  vsce: subcommand([[['publish', 'unpublish'], R.publish]]),
  ovsx: subcommand([[['publish'], R.publish]]),
  nuget: subcommand([[['push', 'delete'], R.publish]]),
  helm: subcommand(
    [[['install', 'upgrade', 'uninstall', 'delete', 'rollback'], R.cluster]],
    new Set(['--kube-context', '--namespace', '-n', '--kubeconfig', '--repository-config']),
  ),
  lerna: subcommand([[['publish'], R.publish]]),
  wmic: withAny('通过 WMIC 修改系统', /^(?:delete|call|set|create)$/i),
  netlify: subcommand([[['deploy'], R.deploy]]),
  firebase: subcommand([[['deploy'], R.deploy]]),
  fly: subcommand([[['deploy', 'destroy'], R.deploy]]),
  flyctl: subcommand([[['deploy', 'destroy'], R.deploy]]),
  wrangler: subcommand([[['deploy', 'publish', 'delete'], R.deploy]]),
  serverless: subcommand([[['deploy', 'remove'], R.deploy]]),
  sls: subcommand([[['deploy', 'remove'], R.deploy]]),
  cdk: subcommand([[['deploy', 'destroy'], R.deploy]]),
  sam: subcommand([[['deploy', 'delete'], R.deploy]]),
  railway: subcommand([[['up', 'down', 'redeploy'], R.deploy]]),
  ...Object.fromEntries(SYSTEM_PACKAGES.map(([name, subs]) => [name, subcommand([[subs, R.system]])])),
  pacman: withAny(R.system, /^-[SRU]/),
  chown: always(R.owner),
  chgrp: always(R.owner),
  icacls: withAny(R.mode, /^\/(?:grant|deny|remove|reset|setowner|inheritance|restore|setintegritylevel)/i),
  takeown: always('获取文件所有权'),
  reg: subcommand([[['add', 'delete', 'import', 'copy', 'restore', 'load', 'unload'], R.registry]]),
  regedit: always(R.registry),
  setx: always(R.envVar),
  'set-executionpolicy': always('修改 PowerShell 执行策略'),
  ...Object.fromEntries(
    [
      'new-netfirewallrule',
      'set-netfirewallrule',
      'remove-netfirewallrule',
      'enable-netfirewallrule',
      'disable-netfirewallrule',
      'set-netfirewallprofile',
    ].map((name) => [name, always(R.firewall)]),
  ),
  ...Object.fromEntries(['set-mppreference', 'add-mppreference', 'remove-mppreference'].map((name) => [name, always('修改系统安全设置')])),
  systemctl: (args) => {
    const sub = positionals(args)[0];
    return sub === undefined || SYSTEMCTL_READS.includes(sub) || sub.startsWith('is-') ? null : R.service;
  },
  service: withAny(R.service, /^(?:start|stop|restart|reload|force-reload)$/),
  sc: subcommand([[['create', 'delete', 'config', 'start', 'stop', 'pause', 'continue', 'failure', 'description', 'sdset'], R.service]]),
  launchctl: subcommand([
    [['load', 'unload', 'bootstrap', 'bootout', 'remove', 'kickstart', 'enable', 'disable', 'kill', 'submit', 'start', 'stop'], R.service],
  ]),
  ...Object.fromEntries(SERVICE_CMDLETS.map((name) => [name, always(R.service)])),
  crontab: (args) => (has(args, '-l') ? null : R.schedule),
  schtasks: withAny(R.schedule, /^\/(?:create|delete|change|run|end)$/i),
  ...Object.fromEntries(TASK_CMDLETS.map((name) => [name, always(R.schedule)])),
  pkill: always('按名称结束进程'),
  killall: always('按名称结束进程'),
  taskkill: withAny(R.kill, /^\/(?:f|im)$/i),
  'stop-process': always(R.kill),
  spps: always(R.kill),
  netsh: unlessAny(R.firewall, /^(?:show|\?|help|dump)$/i),
  iptables: unlessAny(R.firewall, /^(?:-L|-S|--list\S*)$/),
  ip6tables: unlessAny(R.firewall, /^(?:-L|-S|--list\S*)$/),
  nft: unlessAny(R.firewall, /^list$/),
  ufw: unlessAny(R.firewall, /^(?:status|show)$/),
  'firewall-cmd': unlessAny(R.firewall, /^--(?:list\S*|state|get\S*|query\S*)$/),
  diskpart: always(R.disk),
  bcdedit: (args) => (args.length === 0 || hasCi(args, '/enum') ? null : R.disk),
  fdisk: always(R.disk),
  parted: always(R.disk),
  sfdisk: always(R.disk),
  mount: (args) => (positionals(args).length ? R.disk : null),
  umount: (args) => (positionals(args).length ? R.disk : null),
  scp: always(R.transfer),
  sftp: always(R.transfer),
  ftp: always(R.transfer),
  tftp: always(R.transfer),
  pscp: always(R.transfer),
  ssh: always(R.remoteShell),
  mosh: always(R.remoteShell),
  nc: always(R.rawNet),
  ncat: always(R.rawNet),
  netcat: always(R.rawNet),
  socat: always(R.rawNet),
  telnet: always(R.rawNet),
};

/** 命令名统一为小写，并把 pip3.12、python3 一类带版本号的名字归一 */
export function commandRule(name: string, args: string[]): string | null {
  const key = name.replace(/^(pip|python)\d+(?:\.\d+)?$/, '$1');
  return RULES[key]?.(args) ?? null;
}
