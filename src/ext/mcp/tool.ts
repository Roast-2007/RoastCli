/**
 * MCP 工具 → ToolDefinition：
 * - 名称 mcp__<server>__<tool>（只保留 [A-Za-z0-9_-]，超过 64 字符截断并加 hash 后缀，满足各家 API 限制）
 * - schema 原样交给模型（rawJsonSchema），参数校验由 MCP 服务器完成
 * - 默认按 execute 询问（可用规则 `mcp__server__tool` 放行）；服务器配置 trustAnnotations 时，readOnlyHint 的工具按只读处理（可并发、免审批）
 * - 结果：文本原样、支持的图片保留像素；音频及不支持/超限的二进制资源显示占位说明。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContentBlock } from '../../core/types.js';
import { MAX_IMAGE_BYTES, imageMediaType } from '../../tools/read/image.js';
import { defineTool, type ToolDefinition, type ToolResult } from '../../tools/tool.js';

const MAX_NAME = 64;
const MAX_DESCRIPTION = 2000;
/** 单次结果最多保留的字符数 */
const MAX_RESULT_CHARS = 60_000;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

export interface McpCallResult {
  content?: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

export type McpCall = (tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<McpCallResult>;

export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (raw.length <= MAX_NAME) return raw;
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `${raw.slice(0, MAX_NAME - 9)}_${hash}`;
}

function kb(base64: string): number {
  return Math.round((base64.length * 3) / 4 / 1024);
}

function blockText(item: unknown): string {
  const c = item as { type?: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string } };
  switch (c.type) {
    case 'text':
      return c.text ?? '';
    case 'image':
    case 'audio':
      return `[${c.type === 'image' ? '图片' : '音频'} ${c.mimeType ?? ''}，约 ${kb(c.data ?? '')} KB，未展示]`;
    case 'resource':
      if (c.resource?.text !== undefined) return `[资源 ${c.resource.uri ?? ''}]\n${c.resource.text}`;
      return `[二进制资源 ${c.resource?.uri ?? ''} ${c.resource?.mimeType ?? ''}，未展示]`;
    case 'resource_link':
      return `[资源链接 ${c.name ?? ''} ${c.uri ?? ''}]`;
    default:
      return JSON.stringify(item);
  }
}

export function mcpResultToToolResult(result: McpCallResult): ToolResult {
  const images: ContentBlock[] = [];
  let imageBytes = 0;
  const parts = (result.content ?? []).map((item) => {
    const block = item as { type?: string; data?: string; mimeType?: string; resource?: { blob?: string; mimeType?: string } };
    const data = block.type === 'image' ? block.data : block.type === 'resource' ? block.resource?.blob : undefined;
    const mime = block.type === 'image' ? block.mimeType : block.resource?.mimeType;
    if (data && mime?.startsWith('image/') && data.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      const bytes = Buffer.from(data, 'base64'), mediaType = imageMediaType(bytes);
      if (mediaType && imageBytes + bytes.length <= MAX_IMAGE_BYTES) { imageBytes += bytes.length; images.push({ type: 'image', mediaType, data }); return ''; }
    }
    return blockText(item);
  }).filter((t) => t !== '');
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  let text = parts.join('\n\n') || '（无输出）';
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…（结果过长，已截断 ${text.length - MAX_RESULT_CHARS} 个字符）`;
  const content: ContentBlock[] = [{ type: 'text', text }, ...images];
  return { content, ...(result.isError ? { isError: true } : {}) };
}

function objectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return schema['type'] === 'object' ? schema : { type: 'object', properties: {}, ...schema };
}

export function wrapMcpTool(server: string, info: McpToolInfo, call: McpCall, opts: { timeoutMs: number; trustAnnotations?: boolean }): ToolDefinition {
  const readOnly = opts.trustAnnotations === true && info.annotations?.readOnlyHint === true;
  const description = `[MCP · ${server}] ${info.description ?? info.annotations?.title ?? info.name}`.slice(0, MAX_DESCRIPTION);
  return defineTool({
    name: mcpToolName(server, info.name),
    description,
    parameters: z.record(z.string(), z.unknown()),
    rawJsonSchema: objectSchema(info.inputSchema),
    isReadOnly: readOnly,
    isConcurrencySafe: readOnly,
    timeoutMs: opts.timeoutMs,
    permission: { kind: readOnly ? 'read' : 'execute' },
    async execute(args, ctx) {
      return mcpResultToToolResult(await call(info.name, args, ctx.signal));
    },
  });
}
