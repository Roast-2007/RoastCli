import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isPathInside, isUncPath, resolveUserPath } from '../../core/paths.js';
import { applyEdit, loadForWrite, makeDiff, type EditSpec } from '../file-ops.js';
import type { ToolContext } from '../tool.js';
import type { SwarmAccess } from '../../swarm/tools.js';
import { readDiff } from '../../swarm/diff.js';
import type { PermissionEngine } from './engine.js';
/** Previews are optional read-only facts, after the permission verdict and role guards. */
export async function approvalPreview(tool: string, args: unknown, ctx: ToolContext, engine: PermissionEngine): Promise<{ preview: string[]; fullDetail: string } | undefined> {
  try {
    const a = args as { path?: string; content?: string; edits?: EditSpec[]; agentId?: string; discard?: boolean } & EditSpec;
    if (tool === 'merge_worktree' && a.agentId && !a.discard) {
      const access = ctx.services.get<SwarmAccess>('swarm'), target = access?.supervisor.childDiffTarget(access.agentId, a.agentId);
      if (!target) return;
      const result = await readDiff(target, ctx.signal);
      return { preview: [`${result.files} 文件 · +${result.added} −${result.removed}`, ...result.stat.trim().split('\n')], fullDetail: result.stat };
    }
    if (!['edit', 'multi_edit', 'write'].includes(tool) || typeof a.path !== 'string' || isUncPath(a.path)) return;
    const abs = resolveUserPath(ctx.cwd, a.path);
    if (!isPathInside(ctx.cwd, abs) || engine.evaluate({ tool: 'read', kind: 'read', cwd: ctx.cwd, target: abs }).behavior !== 'allow') return;
    let before = '', after = '';
    if (existsSync(abs)) {
      if ((await stat(abs)).size > 2_000_000) return;
      const loaded = await loadForWrite(abs, ctx.services); if (!loaded.ok) return;
      before = loaded.file.content;
    }
    if (tool === 'write') { if (typeof a.content !== 'string') return; after = a.content.replace(/\r\n/g, '\n'); }
    else {
      after = before;
      for (const edit of tool === 'edit' ? [a] : a.edits ?? []) { const result = applyEdit(after, edit); if (!result.ok) return; after = result.content; }
    }
    const diff = makeDiff(a.path, before, after), lines = diff.hunks.flatMap((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines]);
    return { preview: lines, fullDetail: `${abs}\n+${diff.added} −${diff.removed}\n${lines.join('\n')}${diff.truncated ? '\n… diff 已截断' : ''}` };
  } catch { return; }
}
