/**
 * 按 config.providers 的 driver 实例化对应 adapter 并注册。
 * 未识别的 driver 抛 RoastError('CONFIG')。
 */
import type { RoastConfig } from '../core/config.js';
import { RoastError } from '../core/errors.js';
import { ProviderRegistry } from './adapter.js';
import { OpenAICompatAdapter } from './openai-compat/adapter.js';
import { AnthropicAdapter } from './anthropic/adapter.js';
import { ProviderLimiter, scheduledAdapter } from './scheduler.js';

export function buildProviderRegistry(config: RoastConfig): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const [name, profile] of Object.entries(config.providers)) {
    const schedule = (adapter: import('./adapter.js').ProviderAdapter) => scheduledAdapter(adapter, new ProviderLimiter(profile.maxConcurrency ?? Math.min(16, config.swarm.maxAgents + 1)));
    switch (profile.driver) {
      case 'openai-compat':
        registry.register(name, schedule(new OpenAICompatAdapter(profile, name)));
        break;
      case 'anthropic':
        registry.register(name, schedule(new AnthropicAdapter(profile, name)));
        break;
      default:
        throw new RoastError('CONFIG', `provider "${name}" 的 driver 无法识别: ${String(profile.driver)}`);
    }
  }
  return registry;
}
