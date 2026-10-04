/**
 * 兼容出口：AgentLoop 即 AgentRuntime（事件溯源运行时，见 runtime.ts）。
 */
export { AgentRuntime as AgentLoop } from './runtime.js';
export type { AgentRuntimeDeps as AgentLoopDeps } from './runtime.js';
