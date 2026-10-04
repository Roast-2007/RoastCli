/**
 * 测试隔离：ROAST_HOME 指向临时目录，避免读取/写入真实的 ~/.roast（技能、记忆、信任列表、全局配置）。
 * 单个测试可以自行覆盖 process.env.ROAST_HOME。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env['ROAST_HOME'] = mkdtempSync(path.join(tmpdir(), 'roast-test-home-'));
