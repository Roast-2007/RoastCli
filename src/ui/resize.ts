import { useViewport } from './viewport.js';
import type { ReactNode } from 'react';
import type { Instance } from 'ink';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

interface InkRenderer {
  resized(): void;
  log: { reset(): void };
  lastOutput: string;
  lastOutputToRender: string;
  lastOutputHeight: number;
  onRender(): void;
}
// Ink 7.1.1 clear() re-synchronizes the old output into its cache. It cannot
// force a repaint. Keep the pinned-version private cache adapter here only.
const renderers = () => import(new URL('./instances.js', pathToFileURL(createRequire(import.meta.url).resolve('ink'))).href) as Promise<{ default: WeakMap<NodeJS.WriteStream, InkRenderer> }>;

export function bindResizeRepaint(stdout: NodeJS.WriteStream, instance: Instance, tree: () => ReactNode): () => void {
  if (!stdout.isTTY) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  const renderer = renderers().then(({ default: instances }) => {
    const ink = instances.get(stdout);
    // Prevent Ink's synchronous old-tree frame on a width decrease. React's
    // The size hook still updates dimensions without a remount.
    if (ink && !disposed) stdout.off('resize', ink.resized);
    return ink;
  });
  const resize = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void repaint(); }, 60);
  };
  async function repaint() {
    const ink = await renderer;
    if (disposed) return;
    await instance.waitUntilRenderFlush();
    if (disposed) return;
    if (ink) {
      ink.log.reset();
      ink.lastOutput = ''; ink.lastOutputToRender = ''; ink.lastOutputHeight = 0;
    } else instance.clear();
    stdout.write('\x1b[2J\x1b[H');
    instance.rerender(tree());
    ink?.onRender();
  }
  stdout.on('resize', resize);
  return () => {
    disposed = true; clearTimeout(timer); stdout.off('resize', resize);
  };
}
