import type { TodoItem } from '../tools/interact/index.js';

/** 自动报告保留可审阅的信息，避免把步数耗尽误报为失败。 */
export function autoReportSummary(opts: {
  reason: string;
  maxSteps: number;
  error?: string;
  text: string;
  todos: readonly TodoItem[];
  files?: string[];
  worktree?: boolean;
}): string {
  const cause =
    opts.reason === 'max-steps'
      ? `未提交 report：达到步数上限（${opts.maxSteps}）后停止。`
      : opts.reason === 'error'
        ? `出错停止：${opts.error ?? '未知错误'}`
        : opts.reason === 'aborted'
          ? '未提交 report：运行已取消。'
          : '结束但没有调用 report。';
  const lines = [cause];
  if (opts.text.trim()) lines.push(`最后的说明：${opts.text.trim().slice(0, 1500)}`);
  const todos = opts.todos.filter((t) => t.status !== 'completed');
  if (todos.length) lines.push('待办：', ...todos.map((t) => `- ${t.content}（${t.status}）`));
  if (opts.files?.length) {
    lines.push('worktree 改动文件：', ...opts.files.slice(0, 30).map((f) => `- ${f}`));
    if (opts.files.length > 30) lines.push(`共 ${opts.files.length} 个文件，仅列出前 30 个。`);
  }
  lines.push(
    opts.worktree
      ? '改动保留在 worktree，可审阅后 merge_worktree 合并，或派新的 worker 继续剩余部分。'
      : '可审阅当前成果，或派新的 agent 继续剩余部分。',
  );
  return lines.join('\n');
}
