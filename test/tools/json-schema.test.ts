import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RoastError } from '../../src/core/errors.js';
import { zodToJsonSchema } from '../../src/tools/json-schema.js';

describe('zodToJsonSchema', () => {
  it('转换 ZodObject：required/optional 与 description', () => {
    const schema = z
      .object({
        name: z.string().describe('用户名'),
        age: z.number().int().optional(),
        active: z.boolean(),
      })
      .describe('用户对象');
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      description: '用户对象',
      properties: {
        name: { type: 'string', description: '用户名' },
        age: { type: 'integer' },
        active: { type: 'boolean' },
      },
      required: ['name', 'active'],
    });
  });

  it('ZodNumber 区分 number / integer', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
    expect(zodToJsonSchema(z.number().int())).toEqual({ type: 'integer' });
  });

  it('ZodEnum', () => {
    expect(zodToJsonSchema(z.enum(['a', 'b']).describe('选一个'))).toEqual({
      type: 'string',
      enum: ['a', 'b'],
      description: '选一个',
    });
  });

  it('ZodArray', () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('ZodRecord', () => {
    expect(zodToJsonSchema(z.record(z.number()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  it('ZodOptional / ZodDefault 解包（default 保留默认值，字段不进 required）', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number().default(42),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number', default: 42 },
      },
    });
  });

  it('嵌套对象', () => {
    const schema = z.object({ nested: z.object({ x: z.boolean() }) });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { x: { type: 'boolean' } }, required: ['x'] },
      },
      required: ['nested'],
    });
  });

  it('不支持的类型抛 RoastError(CONFIG)', () => {
    expect(() => zodToJsonSchema(z.union([z.string(), z.number()]))).toThrowError(RoastError);
    try {
      zodToJsonSchema(z.date());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RoastError);
      expect((err as RoastError).code).toBe('CONFIG');
    }
  });
});
