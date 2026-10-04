import { createHash } from 'node:crypto';
import type { SessionEvent } from '../session/events.js';
import { stableStringify } from '../session/history.js';

const OUTPUT_TOOLS = new Set(['edit', 'multi_edit', 'write', 'board_write', 'report', 'spawn_agent', 'send_message', 'ask_user']);
const MAX_RESULTS = 512;

/** Counts completed model steps after their tools finish; retries and waiting do not advance it. */
export class ProgressWatchdog {
  private step = '';
  private completed = false;
  private progress = false;
  private stalled = 0;
  private alerted = false;
  private denied = false;
  private readonly calls = new Map<string, unknown>();
  private readonly results = new Set<string>();

  constructor(private readonly threshold: () => number) {}

  observe(event: SessionEvent): { steps: number; denied: boolean } | undefined {
    if (event.type === 'step/start') {
      const step = `${event.turn}:${event.step}`;
      if (step === this.step) return;
      let alert: { steps: number; denied: boolean } | undefined;
      if (this.completed) {
        if (this.progress) { this.stalled = 0; this.alerted = false; this.denied = false; }
        else if (++this.stalled >= this.threshold() && !this.alerted) {
          this.alerted = true;
          alert = { steps: this.stalled, denied: this.denied };
        }
      }
      this.step = step;
      this.completed = false;
      this.progress = false;
      this.calls.clear();
      return alert;
    }
    if (event.type === 'assistant/message') this.completed = true;
    if (event.type === 'tool/call') this.calls.set(event.callId, event.args);
    if (event.type === 'tool/result') {
      if (event.isError) { this.denied ||= event.metadata?.['denied'] === true; return; }
      const key = createHash('sha256').update(stableStringify([event.name, this.calls.get(event.callId), event.content])).digest('hex');
      if (OUTPUT_TOOLS.has(event.name) || !this.results.has(key)) this.progress = true;
      this.results.add(key);
      if (this.results.size > MAX_RESULTS) this.results.delete(this.results.values().next().value!);
    }
  }
}
