/**
 * provider 冒烟脚本（不走 agent loop）：
 *   pnpm tsx scripts/smoke.ts deepseek:deepseek-chat "say hi in 3 words"
 * 只做 loadConfig + buildProviderRegistry + adapter.stream，流式打印 text-delta，结束打印 usage。
 */
import { loadConfig, parseModelRef } from '../src/core/config.js';
import { asRoastError } from '../src/core/errors.js';
import { emptyUsage, addUsage, userMessage, type TokenUsage } from '../src/core/types.js';
import { buildProviderRegistry } from '../src/providers/registry.js';

async function main(): Promise<void> {
  const [ref, ...promptParts] = process.argv.slice(2);
  const prompt = promptParts.join(' ');
  if (!ref || !prompt) {
    process.stderr.write('用法: pnpm tsx scripts/smoke.ts <provider:model> "<prompt>"\n');
    process.exit(2);
  }

  const config = loadConfig(process.cwd());
  if (!config) {
    process.stderr.write('未找到配置文件（roastcli.config.json，参考 roastcli.config.example.json）\n');
    process.exit(2);
  }

  const modelRef = parseModelRef(ref);
  const registry = buildProviderRegistry(config);
  const adapter = registry.get(modelRef);

  let usage: TokenUsage = emptyUsage();
  let failed = false;
  for await (const chunk of adapter.stream({ model: modelRef.model, messages: [userMessage(prompt)] })) {
    if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.text);
    } else if (chunk.type === 'usage') {
      usage = addUsage(usage, chunk.usage);
    } else if (chunk.type === 'finish') {
      if (chunk.reason === 'error' || chunk.reason === 'aborted') {
        const e = chunk.error ? asRoastError(chunk.error) : undefined;
        process.stderr.write(`\nfinish: ${chunk.reason}${e ? ` [${e.code}] ${e.message}` : ''}\n`);
        failed = true;
      }
    }
  }
  process.stdout.write(`\nusage: input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  const e = asRoastError(err);
  process.stderr.write(`error [${e.code}] ${e.message}\n`);
  process.exit(1);
});
