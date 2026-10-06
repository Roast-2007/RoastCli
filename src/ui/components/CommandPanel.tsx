import { useEffect, useMemo, useState } from 'react';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../../agent/session.js';
import { isProjectTrusted, roastHome } from '../../core/config.js';
import { saveConfigPatch } from '../../cli/provider-settings.js';
import { missionInput, loadStrategies } from '../../swarm/strategies.js';
import { MODE_CYCLE, type PermissionMode } from '../../tools/permissions/engine.js';
import { renderTodos } from '../../tools/interact/index.js';
import type { UiController } from '../controller.js';
import type { OverlayKind, UiStore } from '../store/store.js';
import { INIT_TEMPLATE, skillPrompt } from '../commands.js';
import { formatCost } from '../status-info.js';
import { formatUsageBreakdown } from '../../core/usage-cost.js';
import { THEMES } from '../theme.js';
import { SelectPanel, type SelectEntry } from './SelectPanel.js';
import { ModelPanel } from './ModelPanel.js';
import { MessagePanel, PromptPanel } from './MessagePanel.js';

export function CommandPanel({ kind, session, store, controller, height }: { kind: OverlayKind; session: Session; store: UiStore; controller: UiController; height: number }) {
  const [selected, setSelected] = useState<SelectEntry | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(false);
  const [memory, setMemory] = useState('读取记忆…');
  const [agent, setAgent] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const close = () => store.setMeta({ overlay: null });
  const cwd = session.log.header.cwd;
  const templates = useMemo(() => kind === 'swarm' ? loadStrategies(cwd, roastHome(), { trusted: isProjectTrusted(cwd) }) : new Map(), [kind, cwd]);
  useEffect(() => {
    if (kind !== 'memory') return;
    let cancelled = false;
    void (session.memory.list?.({ limit: 30 }) ?? Promise.resolve([])).then((facts) => { if (!cancelled) setMemory(facts.map((fact) => `[${fact.id}] ${fact.content}`).join('\n') || '没有记忆；输入 # 内容 保存项目说明'); }).catch((err) => { if (!cancelled) setMemory(err instanceof Error ? err.message : '读取失败'); });
    return () => { cancelled = true; };
  }, [kind, session]);
  if (kind === 'model' || kind === 'hive-models') return <ModelPanel session={session} store={store} height={height} hive={kind === 'hive-models'} />;
  if (body !== null) return <MessagePanel title={selected?.label ?? kind} text={body} height={height} onClose={() => setBody(null)} />;
  if (kind === 'theme') return <SelectPanel title="主题 · Enter 应用并保存" height={height} entries={Object.keys(THEMES).map((name) => ({ id: name, label: `${name} · ${{ ember: '余烬橙', aurora: '极光青紫', daylight: '浅色终端', mono: '单色' }[name]}` }))} initialId={store.getState().meta.theme ?? session.config.ui?.theme ?? 'ember'} onClose={close} onSelect={(entry) => {
    saveConfigPatch(cwd, { ui: { theme: entry.id } });
    session.config.ui = { ...session.config.ui, theme: entry.id };
    store.setMeta({ theme: entry.id, overlay: null });
    store.addNotice('main', `主题 → ${entry.id}`, 'success');
  }} message="NO_COLOR / ROAST_THEME 等环境变量优先" />;
  if (kind === 'mode') return <SelectPanel title="权限模式" height={height} initialId={session.permissions.mode} onClose={close} entries={MODE_CYCLE.map((mode) => ({ id: mode, label: `${mode} · ${{ default: '标准审批', acceptEdits: '自动批准工作区编辑', plan: '仅规划与读取', yolo: '自动批准常规操作' }[mode]}` }))} onSelect={(entry) => { session.permissions.setMode(entry.id as PermissionMode); close(); }} />;
  if (kind === 'compact') return <PromptPanel title="压缩上下文" label="关注点（可留空）" optional height={height} onClose={close} onSubmit={async (focus) => { const saved = await session.compact(focus || undefined); store.addNotice('main', saved > 0 ? `已压缩上下文，约节省 ${saved} tokens` : '暂无可压缩的内容（历史轮次太少）'); close(); }} />;
  if (kind === 'init') return <SelectPanel title="创建 ROAST.md 项目说明" height={height} onClose={close} entries={[{ id: 'create', label: '创建项目说明模板' }, { id: 'cancel', label: '返回' }]} message={existsSync(join(cwd, 'ROAST.md')) ? 'ROAST.md 已存在' : '写入项目约定、常用命令和记忆'} onSelect={(entry) => {
    if (entry.id === 'cancel') return close();
    const file = join(cwd, 'ROAST.md');
    if (existsSync(file)) throw new Error(`ROAST.md 已存在：${file}`);
    writeFileSync(file, INIT_TEMPLATE, { encoding: 'utf8', flag: 'wx' }); store.addNotice('main', `已创建 ${file}（下次会话生效）`, 'success'); close();
  }} />;
  if (kind === 'swarm' || kind === 'skills') {
    if (selected && prompt) return <PromptPanel title={selected.label} label={kind === 'swarm' ? '任务目标' : '技能参数（可留空）'} optional={kind === 'skills'} height={height} onClose={() => setPrompt(false)} onSubmit={(text) => {
      const result = kind === 'swarm' ? missionInput(templates, text, selected.id, session.config.swarm.n) : skillPrompt(selected.id, text);
      close(); controller.submit(result, kind === 'swarm' ? `/swarm ${selected.id} ${text}` : `/${selected.id} ${text}`);
    }} />;
    const entries = kind === 'swarm' ? [{ id: 'models', label: '配置各角色模型与 effort' }, ...[...templates.values()].map((template) => ({ id: template.name, label: `${template.name} · ${template.description}` }))] : session.skills.list().map((skill) => ({ id: skill.name, label: `${skill.name} · ${skill.description}` }));
    return <SelectPanel key={prompt ? 'prompt-back' : kind} title={kind === 'swarm' ? 'Hive · 策略与模型' : '技能 · 选择并运行'} height={height} entries={entries} searchable onClose={close} onSelect={(entry) => { if (kind === 'swarm' && entry.id === 'models') return store.setMeta({ overlay: 'hive-models' }); setSelected(entry); setPrompt(true); }} />;
  }
  if (kind === 'agents') {
    if (confirmCancel && agent) return <SelectPanel key="cancel" title={`确认取消 ${agent} 子树？`} height={height} entries={[{ id: 'back', label: '返回' }, { id: 'confirm', label: '确认取消' }]} onClose={() => setConfirmCancel(false)} onSelect={(entry) => { if (entry.id === 'confirm') controller.cancelAgent(agent); setConfirmCancel(false); }} />;
    if (agent && prompt) return <PromptPanel title={`发送指示 · ${agent}`} label="指示内容" height={height} onClose={() => setPrompt(false)} onSubmit={(text) => { store.addNotice('main', controller.steerAgent(agent, text)); setPrompt(false); }} />;
    if (agent) return <SelectPanel key={`agent:${agent}`} title={`管理 · ${agent}`} height={height} onClose={() => setAgent(null)} entries={[{ id: 'detail', label: '查看完整任务与报告' }, { id: 'steer', label: '发送指示' }, { id: 'pause', label: '暂停 / 恢复' }, { id: 'cancel', label: '取消子树（需确认）' }]} onSelect={(entry) => {
      if (entry.id === 'steer') return setPrompt(true);
      if (entry.id === 'pause') { store.addNotice('main', controller.togglePause(agent)); return; }
      if (entry.id === 'cancel') return setConfirmCancel(true);
      const info = session.swarm.info(agent); setSelected(entry); setBody(info ? `${info.model} · ${info.state}\n\n${info.brief}\n\n${info.report?.summary ?? '尚无报告'}` : '成员已结束');
    }} />;
    return <SelectPanel key="agents" searchable title="Hive · 成员" height={height} entries={session.swarm.tree().map((info) => ({ id: info.id, label: `${info.id} [${info.role}] ${info.state} · ${info.model} · ${info.brief}` }))} onClose={close} onSelect={(entry) => setAgent(entry.id)} />;
  }
  if (kind === 'board' || kind === 'mcp') {
    const entries = kind === 'board' ? session.swarm.board.list('/').map((entry) => ({ id: entry.key, label: `${entry.key} · v${entry.version} · ${entry.chars} 字` })) : session.mcpStatus().map((entry) => ({ id: entry.name, label: `${entry.name} · ${entry.state} · ${entry.toolCount} 个工具` }));
    return <SelectPanel title={kind === 'board' ? '黑板 · 查看完整内容' : 'MCP · 连接状态'} entries={entries} height={height} searchable onClose={close} onSelect={(entry) => { setSelected(entry); const value = kind === 'board' ? session.swarm.board.read(entry.id)?.value : session.mcpStatus().find((status) => status.name === entry.id); setBody(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '条目已删除'); }} />;
  }
  if (kind === 'memory' && prompt) return <PromptPanel title="检索记忆" label="关键词" height={height} onClose={() => setPrompt(false)} onSubmit={async (query) => { const facts = await session.memory.recall(query); setSelected({ id: query, label: `记忆 · ${query}` }); setBody(facts.map((fact) => `[${fact.id}] ${fact.content}`).join('\n') || '没有匹配的记忆'); setPrompt(false); }} />;
  if (kind === 'memory') return <SelectPanel title="项目记忆" height={height} onClose={close} entries={[{ id: 'list', label: '查看记忆' }, { id: 'search', label: '关键词检索' }]} onSelect={(entry) => { setSelected(entry); if (entry.id === 'search') setPrompt(true); else setBody(memory); }} />;
  const usage = store.getState().agents['main']!.totalUsage, cost = session.cost();
  if (kind === 'cost' && session.costBreakdown) return <MessagePanel title="用量与费用" text={formatUsageBreakdown(session.costBreakdown())} height={height} onClose={close} />;
  const text = kind === 'cost' ? `输入 ${usage.input + usage.cacheRead}\n缓存命中 ${usage.cacheRead}\n输出 ${usage.output}\n缓存写入 ${usage.cacheWrite}\n${cost === null ? '部分模型缺少 pricing，无法完整估算费用' : `约 ${formatCost(cost)}`}` : kind === 'todo' ? renderTodos(store.getState().agents['main']!.todos) : session.log.path;
  return <MessagePanel title={{ cost: '用量与费用', todo: '待办清单', logs: '本次运行日志' }[kind as 'cost' | 'todo' | 'logs'] ?? kind} text={text} height={height} onClose={close} />;
}
