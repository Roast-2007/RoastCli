/**
 * 扩展缝：Prompt 防注入。
 *
 * 两个挂点：
 * - InputGuard：用户输入 / 工具结果回模型前检测注入企图
 *   （工具结果是主要注入面：网页、日志、文件内容里可能藏指令）
 * - OutputGuard：模型输出执行前复核（高危命令、凭据外泄）
 *
 * InputGuard 接在 agent loop 的消息入队处与工具执行管线的
 * post-execute（包装 tool result）处；OutputGuard 接在
 * 工具执行管线的 pre-execute（检查模型产出的参数）处。
 * 实现可以是规则集，也可以是小模型分类器。
 */

export interface GuardVerdict {
  action: 'pass' | 'sanitize' | 'block';
  /** sanitize 时给出清洗后的文本 */
  sanitized?: string;
  /** block/sanitize 的理由（写日志，block 时也反馈给模型） */
  reason?: string;
}

export interface InputGuard {
  /** 检查一段即将进入上下文的外部文本 */
  check(text: string, source: 'user' | 'tool-result' | 'file' | 'web', opts?: { signal?: AbortSignal; hive?: { strategy: string; n: number } }): Promise<GuardVerdict>;
}

export interface OutputGuard {
  /** 检查模型生成的工具调用参数（如 bash 命令） */
  checkToolArgs(toolName: string, args: unknown): Promise<GuardVerdict>;
  /** 检查模型生成的面向用户的文本（如是否泄露凭据） */
  checkText(text: string): Promise<GuardVerdict>;
}
