import { describe, expect, it } from 'vitest';
import { decodeOutput, detectEncoding, OutputCollector, utf8ChildEnv } from '../../src/tools/bash/output.js';

describe('OutputCollector', () => {
  it('小输出原样返回，多字节字符可跨 chunk', () => {
    const c = new OutputCollector();
    const bytes = Buffer.from('你好 world', 'utf8');
    c.push('out', bytes.subarray(0, 2));
    c.push('out', bytes.subarray(2));
    expect(c.text()).toBe('你好 world');
  });

  it('stdout/stderr 交错按到达顺序拼接，且各自解码', () => {
    const c = new OutputCollector();
    const zh = Buffer.from('中', 'utf8');
    c.push('out', zh.subarray(0, 2));
    c.push('err', Buffer.from('E'));
    c.push('out', zh.subarray(2));
    expect(c.text()).toBe('E中');
  });

  it('超大输出只保留头尾，并标注丢弃字节数', () => {
    const c = new OutputCollector();
    const line = '中'.repeat(1000) + '\n'; // 3001 字节
    for (let i = 0; i < 400; i++) c.push('out', Buffer.from(line, 'utf8'));
    const text = c.text();
    expect(c.totalBytes).toBe(400 * 3001);
    expect(text).toContain('字节已丢弃');
    expect(text.startsWith('中')).toBe(true);
    expect(text.length).toBeLessThan(400 * 1001);
  });

  it.runIf(process.platform === 'win32')('GBK 大输出溢出时头尾都按 GBK 解码', () => {
    const c = new OutputCollector();
    const gbkLine = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]); // "中文\n"
    c.push('out', Buffer.from([0x41])); // 打乱对齐
    for (let i = 0; i < 70_000; i++) c.push('out', gbkLine);
    const text = c.text();
    const head = text.slice(0, 200);
    const tail = text.slice(-200);
    expect(head).toContain('中文');
    expect(tail).toContain('中文');
  });
});

describe('detectEncoding / decodeOutput', () => {
  it('合法 UTF-8', () => {
    expect(detectEncoding(Buffer.from('ok 中文', 'utf8'))).toBe('utf-8');
    expect(decodeOutput(Buffer.from('ok 中文', 'utf8'))).toBe('ok 中文');
  });

  it('末尾截断的 UTF-8 字符不影响判定', () => {
    const buf = Buffer.concat([Buffer.from('编译中文输出', 'utf8'), Buffer.from([0xe4, 0xb8])]);
    expect(detectEncoding(buf)).toBe('utf-8');
  });

  it('零星非法字节仍判定为 UTF-8', () => {
    const buf = Buffer.concat([Buffer.from('编译中文输出完成了', 'utf8'), Buffer.from([0xff]), Buffer.from('\n')]);
    expect(detectEncoding(buf)).toBe('utf-8');
  });

  it.runIf(process.platform === 'win32')('GBK 字节回退解码', () => {
    expect(detectEncoding(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('gbk');
    expect(decodeOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文');
  });
});

describe('utf8ChildEnv', () => {
  it('强制 UTF-8 相关变量，保留已有 UTF-8 LANG', () => {
    expect(utf8ChildEnv({ LANG: 'zh_CN.UTF-8' })['LANG']).toBe('zh_CN.UTF-8');
    expect(utf8ChildEnv({ LANG: 'zh_CN.GBK' })['LANG']).toBe('C.UTF-8');
    expect(utf8ChildEnv({})['PYTHONIOENCODING']).toBe('utf-8');
  });
});
