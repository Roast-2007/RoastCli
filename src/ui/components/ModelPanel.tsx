import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Session } from '../../agent/session.js';
import { reasoningEfforts, type ReasoningEffort } from '../../core/config.js';
import { configuredModels, type CatalogModel } from '../../providers/models.js';
import type { AgentRole } from '../../swarm/types.js';
import { ROLE_INFO } from '../../swarm/roles.js';
import type { UiStore } from '../store/store.js';
import { SelectPanel } from './SelectPanel.js';
import { Field } from '../providers/ProviderWizard.js';
import { useTheme } from '../theme.js';
import { resolvePricing } from '../../providers/pricing/index.js';

export function ModelPanel({ session, store, height, hive = false }: { session: Session; store: UiStore; height: number; hive?: boolean }) {
  const theme = useTheme();
  const currentRef = `${session.providerName}:${session.model}`;
  const [models, setModels] = useState<CatalogModel[]>(() => configuredModels(session.config));
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('自动获取供应商模型…已配置模型可立即选择');
  const [revision, setRevision] = useState(0);
  const [role, setRole] = useState<AgentRole | null>(null);
  const [chosen, setChosen] = useState<CatalogModel | null>(null);
  const [manual, setManual] = useState(false);
  const [manualValue, setManualValue] = useState(`${session.providerName}:`);
  const manualRef = useRef(manualValue);
  manualRef.current = manualValue;
  const [error, setError] = useState('');
  const close = () => store.setMeta({ overlay: null });
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setMessage('自动获取供应商模型…已配置模型可立即选择');
    void session
      .listModels({ refresh: revision > 0, signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        setModels(result.models);
        setMessage(
          result.warnings.length
            ? `${result.warnings.join(' · ')}；保留已配置模型，也可手动输入`
            : `已获取 ${result.models.length} 个模型；推理强度需服务端支持`,
        );
      })
      .catch((err) => {
        if (!abort.signal.aborted) setMessage(err instanceof Error ? err.message : '获取失败，可手动输入');
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [session, revision]);
  const apply = (model: CatalogModel, effort: ReasoningEffort | null) => {
    if (role) {
      session.setSwarmModel(role, model.ref, effort);
      store.addNotice('main', `Hive ${role} → ${model.ref} · effort ${effort ?? '自动'}（后续派生生效）`, 'success');
      setChosen(null);
      setRole(null);
    } else {
      session.switchModel(model.ref, effort);
      store.setMeta({ contextPercent: session.contextStats().percent });
      store.addNotice('main', `模型 → ${model.ref} · effort ${effort ?? '自动'}`, 'success');
      close();
    }
  };
  useInput(
    (input, key) => {
      if (!manual) return;
      if (key.escape) {
        setManual(false);
        setError('');
        return;
      }
      if (key.ctrl && input === 'c') return close();
      if (key.return) {
        const manualValue = manualRef.current;
        const index = manualValue.indexOf(':');
        const provider = manualValue.slice(0, index),
          id = manualValue.slice(index + 1);
        if (index < 1 || !session.config.providers[provider] || !id || /\s/.test(id)) return setError('填写已配置的 provider:model');
        setChosen({ provider, id, ref: manualValue, meta: session.config.providers[provider]?.models?.[id] ?? {}, source: 'configured' });
        setManual(false);
      }
    },
    { isActive: manual },
  );
  if (manual)
    return (
      <Box flexDirection="column" height={height} overflow="hidden" paddingX={1}>
        {height >= 4 ? (
          <Text bold color={theme.accent} wrap="truncate-end">
            手动添加模型 · provider:model
          </Text>
        ) : null}
        <Field
          label="模型引用"
          showLabel={height >= 3}
          value={manualValue}
          active
          onChange={(value) => {
            manualRef.current = value;
            setManualValue(value);
          }}
        />
        {height >= 2 ? (
          <Text color={error ? theme.danger : theme.muted} wrap="truncate-end">
            {error || 'Enter 选择推理强度 · Esc 返回'}
          </Text>
        ) : null}
      </Box>
    );
  if (hive && !role)
    return (
      <SelectPanel
        key="roles"
        title="Hive · 各角色模型"
        height={height}
        onClose={close}
        entries={Object.entries(ROLE_INFO)
          .filter(([name]) => name !== 'queen')
          .map(([name, info]) => ({
            id: name,
            label: `${name} · ${info.name} → ${session.config.swarm.models?.[name as AgentRole] ?? 'inherit'} / ${session.config.swarm.efforts?.[name as AgentRole] ?? '自动'}`,
          }))}
        message="Queen 使用 /model；已运行的子代理保留原设置"
        onSelect={(entry) => setRole(entry.id as AgentRole)}
      />
    );
  if (chosen) {
    const profile = session.config.providers[chosen.provider]!;
    const efforts = reasoningEfforts(profile.driver, profile.baseURL, chosen.meta);
    const initial = role
      ? session.config.swarm.efforts?.[role]
      : chosen.ref === currentRef
        ? session.reasoningEffort
        : chosen.meta.reasoningEffort;
    return (
      <SelectPanel
        key={`effort:${chosen.ref}`}
        title={`推理强度 · ${chosen.ref}`}
        height={height}
        initialId={initial ?? 'auto'}
        entries={[{ id: 'auto', label: '自动 · 不发送 effort 参数' }, ...efforts.map((effort) => ({ id: effort, label: effort }))]}
        message={efforts.length ? '仅选择供应商和该模型支持的强度' : '该模型未声明推理能力，使用自动'}
        onClose={() => setChosen(null)}
        onSelect={(entry) => apply(chosen, entry.id === 'auto' ? null : (entry.id as ReasoningEffort))}
      />
    );
  }
  const entries = [
    ...(role ? [{ id: 'inherit', label: '跟随主会话模型与推理强度' }] : []),
    { id: 'manual', label: '＋ 手动输入自定义模型' },
    ...models.map((model) => {
      const resolved = resolvePricing(session.config, { provider: model.provider, model: model.id });
      return {
        id: model.ref,
        label: `${model.ref}${model.ref === currentRef ? ' ● 当前' : ''}${model.meta.name ? ` · ${model.meta.name}` : ''}${model.meta.contextWindow ? ` · ${Math.round(model.meta.contextWindow / 1000)}k` : ''}${resolved ? ` · $${resolved.pricing.input}/$${resolved.pricing.output}${resolved.source === 'reference' ? ' 参考' : ''}` : ''}`,
        detail: model.id,
      };
    }),
  ];
  if (!entries.some((entry) => entry.id === currentRef))
    entries.push({ id: currentRef, label: `${currentRef} ● 当前`, detail: session.model });
  return (
    <SelectPanel
      key={`models:${role ?? 'main'}`}
      title={role ? `Hive · ${role} 模型` : '模型 · 选择后设置推理强度'}
      height={height}
      entries={entries}
      searchable
      initialId={role ? session.config.swarm.models?.[role] : currentRef}
      message={`${loading ? '加载中 · ' : ''}${message}`}
      onRefresh={() => setRevision((value) => value + 1)}
      onClose={role ? () => setRole(null) : close}
      onSelect={(entry) => {
        if (entry.id === 'manual') {
          setManualValue(`${session.providerName}:`);
          setManual(true);
          return;
        }
        if (entry.id === 'inherit' && role) {
          session.setSwarmModel(role, 'inherit');
          setRole(null);
          return;
        }
        setChosen(
          models.find((model) => model.ref === entry.id) ?? {
            provider: session.providerName,
            id: session.model,
            ref: currentRef,
            meta: {},
            source: 'configured',
          },
        );
      }}
    />
  );
}
