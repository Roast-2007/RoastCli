/**
 * zod → JSON Schema 轻量递归转换器。
 * 只支持本工具层用到的子集（见下），不支持的类型抛 RoastError('CONFIG')，
 * 让工具作者在定义阶段就暴露问题，而不是给模型一份错误的 schema。
 *
 * 支持：ZodObject / ZodString / ZodNumber(int → integer) / ZodBoolean /
 *       ZodEnum / ZodArray / ZodRecord / ZodOptional / ZodNullable / ZodDefault。
 * .describe() 的描述写入 description 字段。
 */
import { z } from 'zod';
import { RoastError } from '../core/errors.js';

function withDescription(schema: z.ZodTypeAny, out: Record<string, unknown>): Record<string, unknown> {
  const desc = schema.description;
  if (desc && out.description === undefined) out.description = desc;
  return out;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // 解包修饰类型：optional / nullable / default
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(schema.unwrap());
    return withDescription(schema, inner);
  }
  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema._def.innerType as z.ZodTypeAny);
    return withDescription(schema, { ...inner, default: schema._def.defaultValue() });
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(field);
      // zod 的 isOptional() 对 ZodOptional / ZodDefault 均为 true
      if (!field.isOptional()) required.push(key);
    }
    const out: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) out.required = required;
    return withDescription(schema, out);
  }

  if (schema instanceof z.ZodString) {
    return withDescription(schema, { type: 'string' });
  }

  if (schema instanceof z.ZodNumber) {
    return withDescription(schema, { type: schema.isInt ? 'integer' : 'number' });
  }

  if (schema instanceof z.ZodBoolean) {
    return withDescription(schema, { type: 'boolean' });
  }

  if (schema instanceof z.ZodEnum) {
    return withDescription(schema, { type: 'string', enum: [...schema.options] });
  }

  if (schema instanceof z.ZodArray) {
    return withDescription(schema, { type: 'array', items: zodToJsonSchema(schema.element) });
  }

  if (schema instanceof z.ZodRecord) {
    return withDescription(schema, {
      type: 'object',
      additionalProperties: zodToJsonSchema(schema.valueSchema),
    });
  }

  const typeName = (schema as { _def?: { typeName?: string } })._def?.typeName ?? typeof schema;
  throw new RoastError('CONFIG', `zodToJsonSchema 不支持的 zod 类型: ${typeName}`);
}
