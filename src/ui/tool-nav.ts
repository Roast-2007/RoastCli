import type { AgentView, ToolView } from './store/reducer.js';
/** 显示顺序稳定，同一个调用以最新状态为准。 */
export function toolsOf(view: AgentView): ToolView[] {
  const tools = new Map<string, ToolView>();
  for (const item of view.items)
    for (const tool of item.kind === 'tool' ? [item.tool] : item.kind === 'tool-group' ? item.tools : []) tools.set(tool.callId, tool);
  for (const tool of view.tools) tools.set(tool.callId, tool);
  return [...tools.values()];
}
export function latestTool(view: AgentView): ToolView | undefined {
  if (view.tools[0]) return view.tools[0];
  for (let i = view.items.length - 1; i >= 0; i--) {
    const item = view.items[i]!;
    if (item.kind === 'tool') return item.tool;
    if (item.kind === 'tool-group') return item.tools.at(-1);
  }
  return undefined;
}
