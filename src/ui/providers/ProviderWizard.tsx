import { loadConfig } from '../../core/config.js';
import { useViewport } from '../viewport.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useBoxMetrics, useCursor, useInput, usePaste, type DOMElement } from 'ink';
import { resolveApiKey, reasoningEfforts, type ReasoningEffort, type RoastConfig } from '../../core/config.js';
import { terminalText } from '../../core/terminal-text.js';
import { displayWidth, graphemes, nextBoundary, previousBoundary, wrapDisplay } from '../../core/text-width.js';
import { PROVIDER_PRESETS } from '../../providers/presets.js';
import { draftFromProfile, draftModelIds, providerOverrideWarnings, providerSettingsSource, readProviderSettings, saveProviderSettings, validateProviderDraft, type ProviderDraft, type ProviderSettings } from '../../cli/provider-settings.js';
import { discoverModels, type CatalogModel } from '../../providers/models.js';
import { SelectPanel } from '../components/SelectPanel.js';
import { pickTheme, ThemeContext, useTheme } from '../theme.js';
import { absoluteOrigin } from '../input/cursor.js';
import { editorViewport } from '../layout.js';
import { createEditor } from '../input/editor.js';
import { TerminalContext, terminalPreferences, useGlyphs } from '../terminal.js';
import { useScroll } from '../scroll.js';
import { motionColor, useEntrance } from '../motion.js';

export interface ProviderWizardProps {
  cwd: string;
  onExit(saved: boolean): void;
  ui?: RoastConfig['ui'];
}

function cleanInput(text: string): string {
  return terminalText(text).replace(/[\n\t]/g, '');
}

/** Local-only form input: never uses the conversation history or UI store. */
export function Field({ label, value, secret, active, onChange, showLabel = true, acceptInput }: { label: string; value: string; secret?: boolean; active: boolean; onChange(value: string): void; showLabel?: boolean; acceptInput?(): boolean }) {
  const theme = useTheme();
  const glyph = useGlyphs();
  const { columns } = useViewport();
  const [cursor, setCursor] = useState(value.length);
  const inputState = useRef({ value, cursor });
  inputState.current.value = value;
  inputState.current.cursor = Math.min(inputState.current.cursor, value.length);
  const ref = useRef<DOMElement>(null);
  useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();
  const position = Math.min(cursor, value.length);
  const view = editorViewport({ ...createEditor(), lines: [secret ? '*'.repeat(value.length) : value], col: position }, Math.max(1, columns - 8), 1);
  const row = view.lines[0]!;
  const start = row.start;
  const shown = row.text;
  const origin = active ? absoluteOrigin(ref.current) : null;
  if (active) setCursorPosition(origin ? { x: origin.x + 3 + displayWidth(shown.slice(0, position - start)), y: origin.y } : undefined);
  const insert = (raw: string) => {
    if (acceptInput?.() === false) return;
    const text = cleanInput(raw);
    const current = inputState.current;
    current.value = current.value.slice(0, current.cursor) + text + current.value.slice(current.cursor);
    current.cursor += text.length;
    onChange(current.value);
    setCursor(current.cursor);
  };
  usePaste(insert, { isActive: active });
  useInput((input, key) => {
    if (acceptInput?.() === false) return;
    const current = inputState.current;
    const move = (next: number) => { current.cursor = next; setCursor(next); };
    const replace = (next: string, col: number) => { current.value = next; onChange(next); move(col); };
    if (key.leftArrow) return move(previousBoundary(current.value, current.cursor));
    if (key.rightArrow) return move(nextBoundary(current.value, current.cursor));
    if (key.home || (key.ctrl && input === 'a')) return move(0);
    if (key.end || (key.ctrl && input === 'e')) return move(current.value.length);
    if (key.ctrl && input === 'u') return replace(current.value.slice(current.cursor), 0);
    if (key.backspace) { if (current.cursor) { const before = previousBoundary(current.value, current.cursor); replace(current.value.slice(0, before) + current.value.slice(current.cursor), before); } return; }
    if (key.delete) return replace(current.value.slice(0, current.cursor) + current.value.slice(nextBoundary(current.value, current.cursor)), current.cursor);
    if (key.return || key.tab || key.escape || key.ctrl || key.meta || key.upArrow || key.downArrow) return;
    if (input) insert(input);
  }, { isActive: active });
  return <Box flexDirection="column">
    {showLabel ? <Text color={active ? theme.accent : undefined} wrap="truncate-end">{label}</Text> : null}
    <Box ref={ref}>
      <Text color={active ? theme.accent : undefined} wrap="truncate-end">{active ? ` ${glyph.pointer} ` : '   '}{active ? <>{shown.slice(0, position - start)}<Text inverse>{graphemes(shown.slice(position - start))[0]?.text ?? ' '}</Text>{shown.slice(nextBoundary(shown, position - start))}</> : shown.trimEnd() || '（未填写）'}</Text>
    </Box>
  </Box>;
}

function credentialStatus(settings: ProviderSettings, name: string): string {
  if (settings.providers[name]?.auth === 'none') return '无需密钥';
  try { resolveApiKey(settings.providers[name]!, name); return '凭据已设置'; }
  catch { return '缺少凭据'; }
}

export function ProviderWizard(props: ProviderWizardProps) {
  const theme = useMemo(() => pickTheme(process.env, props.ui?.theme), [props.ui?.theme]);
  const terminal = useMemo(() => {
    try { return terminalPreferences(process.env, props.ui ?? loadConfig(props.cwd)?.ui); }
    catch { return terminalPreferences(process.env, props.ui); }
  }, [props.ui, props.cwd]);
  return <ThemeContext.Provider value={theme}><TerminalContext.Provider value={terminal}><Wizard {...props} /></TerminalContext.Provider></ThemeContext.Provider>;
}

function Wizard({ cwd, onExit }: ProviderWizardProps) {
  const theme = useTheme();
  const glyph = useGlyphs();
  const { rows, columns } = useViewport();
  const compact = rows < 18;
  const read = (): { settings: ProviderSettings; error?: string } => {
    try { return { settings: readProviderSettings(cwd) }; }
    catch (err) { return { settings: { providers: {}, file: providerSettingsSource(cwd).path }, error: err instanceof Error ? err.message : '无法读取配置' }; }
  };
  const [loaded, setLoaded] = useState(read);
  const [step, setStep] = useState<'home' | 'preset' | 'connection' | 'credential' | 'models' | 'review' | 'saved'>('home');
  const stepRef = useRef(step); stepRef.current = step;
  const [selection, setSelectionState] = useState(0);
  const selectionRef = useRef(selection);
  const setSelection = (next: number | ((value: number) => number)) => { selectionRef.current = typeof next === 'function' ? next(selectionRef.current) : next; setSelectionState(selectionRef.current); };
  const [field, setFieldState] = useState(0);
  const fieldRef = useRef(field); fieldRef.current = field;
  const setField = (value: number | ((current: number) => number)) => {
    fieldRef.current = typeof value === 'function' ? value(fieldRef.current) : value;
    setFieldState(fieldRef.current);
  };
  const [draft, setDraftState] = useState<ProviderDraft | null>(null);
  const draftRef = useRef(draft);
  const setDraft = (next: ProviderDraft | null) => { draftRef.current = next; setDraftState(next); };
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [hasSaved, setHasSaved] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [remoteModels, setRemoteModels] = useState<CatalogModel[]>([]);
  const [modelMessage, setModelMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const settings = loaded.settings;
  const names = Object.keys(settings.providers);
  const presets = Object.values(PROVIDER_PRESETS);
  const homeEntries = ['＋ 添加供应商', ...names.map((name) => `${name} · ${settings.default?.startsWith(`${name}:`) ? `默认 ${settings.default.slice(name.length + 1)} · ` : ''}${credentialStatus(settings, name)}`)];
  const entries = step === 'home' ? homeEntries : presets.map((p) => p.label);
  const go = (next: typeof step) => { stepRef.current = next; setStep(next); setError(''); setField(0); pageScroll.move(0); };
  const update = (patch: Partial<ProviderDraft>) => { if (draftRef.current) setDraft({ ...draftRef.current, ...patch }); setError(''); };
  const openModels = () => {
    const current = draftRef.current;
    if (!current) return;
    const invalid = validateProviderDraft({ ...current, model: current.model || 'discovery' });
    if (invalid) return setError(invalid);
    go('models');
  };
  useEffect(() => {
    if (step !== 'models' || !draftRef.current) return;
    const current = draftRef.current;
    const abort = new AbortController();
    const profile = { ...current.existing, driver: current.driver, baseURL: current.baseURL, auth: current.auth };
    setModelMessage('自动获取模型列表…已配置模型仍可选择');
    setRemoteModels(Object.entries(current.existing?.models ?? {}).map(([id, meta]) => ({ id, meta, provider: current.name, ref: `${current.name}:${id}`, source: 'configured' })));
    void discoverModels(profile, current.name, { ...(current.apiKey.trim() ? { apiKey: current.apiKey.trim() } : {}), signal: abort.signal }).then((models) => {
      if (abort.signal.aborted) return;
      const configured = Object.entries(profile.models ?? {}).map(([id, meta]) => ({ id, meta, provider: current.name, ref: `${current.name}:${id}`, source: 'configured' as const }));
      setRemoteModels([...new Map([...configured, ...models].map((model) => [model.id, model])).values()]);
      setModelMessage(`已获取 ${models.length} 个模型 · Enter 勾选多个模型`);
      const live = draftRef.current;
      if (live) update({ modelMeta: Object.fromEntries(models.map((model) => [model.id, model.meta])) });
    }).catch((err) => { if (!abort.signal.aborted) setModelMessage(`${err instanceof Error ? err.message : '获取失败'}；Esc 返回手填模型`); });
    return () => abort.abort();
  }, [step, refresh]);
  const review = () => {
    const draft = draftRef.current;
    if (!draft) return;
    const invalid = validateProviderDraft(draft);
    if (invalid) return setError(invalid);
    try { setWarnings(providerOverrideWarnings(cwd, draft.name, draft.makeDefault || !settings.default)); go('review'); }
    catch (err) { setError(err instanceof Error ? err.message : '无法读取配置'); }
  };
  const gap = rows >= 8 ? 1 : 0;
  const bodyHeight = Math.max(1, rows - 2 - (compact ? 0 : 1) - gap - 1 - (error ? Math.min(2, Math.max(1, rows - 7)) : 0));
  const reviewText = draft ? [
    `${settings.providers[draft.name] ? '更新已有供应商' : '添加供应商'}：${draft.name}`,
    `协议：${draft.driver}`, `地址：${draft.baseURL}`, `模型：${draft.model}`,
    draft.auth === 'none' ? '认证：无密钥' : '凭据：本地保存 API Key（已遮罩）',
    `Reasoning effort：${draft.reasoningEffort ?? '自动（供应商默认）'}`,
    `默认模型：${draft.makeDefault || !settings.default ? `${draft.name}:${draftModelIds(draft)[0]}` : settings.default}`,
    `保存位置：${settings.file}`,
    '下一次启动生效。', ...warnings,
  ] : [];
  const pageLines = (loaded.error ? [`${loaded.error} · Enter 重试`] : step === 'review' ? reviewText : step === 'saved' ? [savedMessage, ...warnings] : []).flatMap((line) => wrapDisplay(terminalText(line), Math.max(1, columns - 2)));
  const pageScroll = useScroll(pageLines.length, bodyHeight), pageOffset = pageScroll.start;
  const accent = motionColor(theme.border, theme.accent, useEntrance(step));

  useInput((input, key) => {
    const step = stepRef.current;
    const field = fieldRef.current;
    const selection = selectionRef.current;
    if (step === 'models') return;
    const draft = draftRef.current;
    if (key.ctrl && input === 'c') return onExit(hasSaved);
    if (key.escape) {
      if (step === 'home' || step === 'saved') return onExit(hasSaved);
      if (step === 'review') return go('credential');
      if (step === 'credential') return go('connection');
      if (step === 'connection' && !draft?.existing) { setSelection(0); return go('preset'); }
      setDraft(null); setSelection(0); return go('home');
    }
    if (pageLines.length && pageScroll.onKey(input, key)) return;
    if (loaded.error) {
      if (key.return) setLoaded(read());
      return;
    }
    if (step === 'home' || step === 'preset') {
      if (key.upArrow) return setSelection((s) => Math.max(0, s - 1));
      if (key.downArrow || key.tab) return setSelection((s) => (s + 1) % entries.length);
      if (!key.return) return;
      if (step === 'home') {
        if (selection === 0) { setSelection(0); return go('preset'); }
        const name = names[selection - 1]!;
        const editing = draftFromProfile(name, settings.providers[name]!, settings.default);
        setDraft({ ...editing, makeDefault: editing.makeDefault || !settings.default });
      } else {
        const preset = presets[selection]!;
        let name = preset.name;
        for (let suffix = 2; settings.providers[name]; suffix++) name = `${preset.name}-${suffix}`;
        setDraft({ name, driver: preset.driver, baseURL: preset.baseURL, model: preset.model, apiKey: '', makeDefault: !settings.default });
      }
      return go('connection');
    }
    if (!draft) return;
    if (key.ctrl && input === 'l' && (step === 'credential' || step === 'review')) return openModels();
    if (step === 'connection' || step === 'credential') {
      const count = step === 'credential' ? 4 : 3;
      if (key.tab) return setField((f) => (f + (key.shift ? count - 1 : 1)) % count);
      if (key.upArrow || key.downArrow) return setField((f) => (f + (key.upArrow ? count - 1 : 1)) % count);
      if (step === 'credential' && (key.leftArrow || key.rightArrow || input === ' ') && field !== 0) {
        if (field === 1) {
          const efforts: (ReasoningEffort | undefined)[] = [undefined, ...reasoningEfforts(draft.driver, draft.baseURL, draft.existing?.models?.[draftModelIds(draft)[0]!] ?? draft.modelMeta?.[draftModelIds(draft)[0]!])];
          const index = efforts.indexOf(draft.reasoningEffort);
          update({ reasoningEffort: efforts[(index + (key.leftArrow ? efforts.length - 1 : 1)) % efforts.length] });
        } else if (field === 2 && settings.default) update({ makeDefault: !draft.makeDefault });
        else if (field === 3) update({ auth: draft.auth === 'none' ? 'api-key' : 'none' });
        return;
      }
      if (!key.return) return;
      if (step === 'connection') {
        if (field < count - 1) return setField((f) => f + 1);
        const invalid = validateProviderDraft({ ...draft, model: draft.model || 'discovery' }, false);
        if (invalid) return setError(invalid);
        return go('credential');
      }
      if (!draft.model.trim()) return openModels();
      return review();
    }
    if (step === 'review' && key.return) {
      try {
        const result = saveProviderSettings(cwd, draft);
        setHasSaved(true); setWarnings(result.warnings);
        setSavedMessage(`已保存到 ${result.file}，下一次启动生效。`);
        setDraft({ ...draft, apiKey: '' });
        setLoaded(read()); go('saved');
      } catch (err) { setError(err instanceof Error ? err.message : '保存失败，请重试'); }
    } else if (step === 'saved' && key.return) {
      setDraft(null); setSelection(0); go('home');
    }
  });

  const visibleCount = Math.max(1, bodyHeight - 1);
  const menuStart = Math.max(0, selection - visibleCount + 1);
  const title = { home: '已配置供应商', preset: '1 / 4 · 选择供应商', connection: '2 / 4 · 连接与模型', credential: '3 / 4 · 配置凭据', models: '自动获取模型', review: '4 / 4 · 确认并保存', saved: '保存成功' }[step];
  const note = presets.find((p) => p.name === draft?.name)?.note;
  if (step === 'models' && draft) {
    const ids = draftModelIds(draft);
    return <SelectPanel title="模型列表 · 可选择多个模型" height={rows} searchable message={modelMessage} onClose={() => go('credential')} onRefresh={() => setRefresh((value) => value + 1)} entries={[{ id: ':done', label: `完成选择 · ${ids.length} 个模型（首个为默认）` }, ...remoteModels.map((model) => ({ id: model.id, label: `${ids.includes(model.id) ? '[x]' : '[ ]'} ${model.id}${model.meta.name ? ` · ${model.meta.name}` : ''}` }))]} onSelect={(entry) => {
      if (stepRef.current !== 'models') return;
      if (entry.id === ':done') { if (!ids.length) throw new Error('请先选择模型，或 Esc 返回手动输入'); return go('credential'); }
      const next = ids.includes(entry.id) ? ids.filter((id) => id !== entry.id) : [...ids, entry.id];
      update({ model: next.join(', '), reasoningEffort: draft.existing?.models?.[next[0]!]?.reasoningEffort ?? draft.modelMeta?.[next[0]!]?.reasoningEffort });
    }} />;
  }
  return <Box width={columns} flexDirection="column" height={rows} overflow="hidden" paddingX={1}>
    <Box flexDirection="column" flexShrink={0}>
    <Text bold color={accent} wrap="truncate-end">ROAST · 供应商配置</Text>
    <Text bold wrap="truncate-end">{title}</Text>
    {!compact ? <Text dimColor wrap="truncate-end">保存位置：{settings.file}</Text> : null}
    </Box>
    <Box flexDirection="column" height={bodyHeight} marginTop={gap} overflow="hidden" flexShrink={0}>
    {pageLines.length ? pageLines.slice(pageOffset, pageOffset + bodyHeight).map((line, i) => <Text key={i} color={loaded.error ? theme.danger : step === 'saved' ? theme.success : undefined} wrap="truncate-end">{line || ' '}</Text>) : null}
    {!loaded.error && (step === 'home' || step === 'preset') ? <Box flexDirection="column" flexShrink={0}>
      {entries.slice(menuStart, menuStart + visibleCount).map((label, index) => <Text key={index} color={menuStart + index === selection ? theme.accent : undefined} wrap="truncate-end">{menuStart + index === selection ? `${glyph.pointer} ` : '  '}{terminalText(label)}</Text>)}
      {entries.length > visibleCount ? <Text dimColor>↑↓ 滚动 · {selection + 1} / {entries.length}</Text> : null}
    </Box> : null}
    {draft && step === 'connection' ? <Box flexDirection="column" flexShrink={0}>
      {!compact ? <Text dimColor wrap="truncate-end">{draft.driver}{note ? ` · ${note}` : ''}</Text> : null}
      {(['name', 'baseURL', 'model'] as const).map((name, index) => !compact || field === index ? <Field key={name} label={['供应商 ID（字母 / 数字 / _ / -）', 'API 基础地址', '模型 ID（逗号分隔；留空自动获取）'][index]!} value={draft[name]} active={field === index} onChange={(value) => update({ [name]: value, ...(name === 'model' ? { reasoningEffort: draft.existing?.models?.[value]?.reasoningEffort } : {}) })} /> : null)}
    </Box> : null}
    {draft && step === 'credential' ? <Box flexDirection="column" flexShrink={0}>
      {!compact || field === 0 ? <Field label={`API Key${draft.existing?.apiKeyRef ? '（留空保留已保存密钥）' : ''}`} secret value={draft.apiKey} active={field === 0} onChange={(apiKey) => update({ apiKey })} /> : null}
      {!compact || field === 1 ? <Text color={field === 1 ? theme.accent : undefined} wrap="truncate-end">{field === 1 ? `${glyph.pointer} ` : '  '}Reasoning effort：{draft.reasoningEffort ?? '自动'} · ←→ 选择</Text> : null}
      {!compact || field === 2 ? <Text color={field === 2 ? theme.accent : undefined} wrap="truncate-end">{field === 2 ? `${glyph.pointer} ` : '  '}设为默认模型：{draft.makeDefault || !settings.default ? '是' : '否'} · {settings.default ? '←→ 切换' : '首个配置自动设为默认'}</Text> : null}
      {!compact || field === 3 ? <Text color={field === 3 ? theme.accent : undefined} wrap="truncate-end">{field === 3 ? `${glyph.pointer} ` : '  '}认证：{draft.auth === 'none' ? '无密钥（本地接口）' : 'API Key'} · ←→ 切换</Text> : null}
      {!compact ? <Text dimColor>密钥以本地明文保存在用户目录 credentials.json，不写入配置或会话记录。推理强度按模型保存，需服务端支持。</Text> : null}
    </Box> : null}
    </Box>
    {error ? <Box flexDirection="column" flexShrink={0}>{wrapDisplay(terminalText(error), Math.max(1, columns - 2)).slice(0, Math.min(2, Math.max(1, rows - 7))).map((line, i) => <Text key={i} color={theme.danger} wrap="truncate-end">{line}</Text>)}</Box> : null}
    <Box flexGrow={1} flexShrink={0} />
    <Box height={1} flexShrink={0}><Text dimColor wrap="truncate-end">{step === 'review' ? 'Enter 保存 · Ctrl+L 模型列表 · Esc 修改' : step === 'saved' ? 'Enter 继续 · Esc 完成' : step === 'credential' ? 'Tab 字段 · Enter 确认 · Ctrl+L 模型列表 · Esc 返回' : step === 'connection' ? compact ? `Tab 字段 ${field + 1}/3 · Enter 下一步 · Esc 返回` : 'Tab / Shift+Tab 字段 · Enter 下一步 · Esc 返回' : '↑↓ 选择 · Enter 确认 · Esc 返回'}{pageLines.length > bodyHeight ? ` · ↑↓ 滚动 ${pageOffset + 1}/${pageLines.length}` : ''}</Text></Box>
  </Box>;
}
