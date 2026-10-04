/**
 * 扩展缝：RAG 检索增强。
 *
 * 接入方式：实现 RetrievalProvider 并挂到 ExtensionPoints.rag；
 * agent loop 在每次 buildRequest 前调用 augment()，返回的上下文本
 * 作为系统 prompt section（order 320）或首条 user 消息前缀注入。
 * 朴素实现可以先做代码库关键词检索，后续换向量索引。
 */
import type { Message } from '../core/types.js';

export interface RetrievedChunk {
  /** 来源标识（文件路径 / 文档 id） */
  source: string;
  content: string;
  score?: number;
}

export interface RetrievalProvider {
  /**
   * 基于最新用户输入检索相关上下文。
   * 返回空数组 = 本次不注入。实现方自行控制预算（token/条数）。
   */
  retrieve(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<RetrievedChunk[]>;
  /** 可选：全量改写/增强消息历史（高级用法，默认不用） */
  augment?(messages: Message[]): Promise<Message[]>;
}
