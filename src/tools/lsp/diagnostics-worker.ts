import { parentPort } from 'node:worker_threads';
import { DiagnosticsCore } from './diagnostics-core.js';

const core = new DiagnosticsCore();
parentPort?.on('message', (request: { id: number; kind: 'check' | 'warm'; file: string; text?: string }) => {
  try {
    parentPort?.postMessage({ id: request.id, diagnostics: core.check(request.file, request.text) });
  } catch (err) {
    parentPort?.postMessage({ id: request.id, error: err instanceof Error ? err.message : String(err) });
  }
});
