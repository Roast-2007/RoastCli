import { writeFileSync } from 'node:fs';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { InputBox } from '../../src/ui/input/InputBox.js';
import { createEditor, editorReducer, type EditorState } from '../../src/ui/input/editor.js';
import { TerminalContext } from '../../src/ui/terminal.js';
import { MONO, ThemeContext } from '../../src/ui/theme.js';
import type { ClipboardImage } from '../../src/core/clipboard.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const image = { type: 'image' as const, mediaType: 'image/png', data: 'iVBORw0KGgo=' };
const deps = { commands: [], files: () => [] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('InputBox image interaction', () => {
  it.each(['\x1bv', '\x16'])('blocks submission while clipboard reading, then submits the image (%j)', async (key) => {
    let finish!: (value: ClipboardImage) => void;
    const readClipboard = vi.fn(
      () =>
        new Promise<ClipboardImage>((resolve) => {
          finish = resolve;
        }),
    );
    const notify = vi.fn(),
      submit = vi.fn();
    const screen = render(
      <InputBox
        active
        initialHistory={[]}
        placeholder=""
        deps={deps}
        onSubmit={submit}
        attachments={{ cwd: '.', readClipboard, notify }}
      />,
    );
    try {
      await tick();
      screen.stdin.write('描述');
      screen.stdin.write(key);
      await tick();
      screen.stdin.write('\r');
      expect(notify).toHaveBeenCalledWith('图片读取中', 'warn');
      expect(submit).not.toHaveBeenCalled();
      finish({ ok: true, image, source: 'clipboard' });
      await tick();
      expect(screen.lastFrame()).toContain('图片 1');
      screen.stdin.write('\r');
      expect(submit).toHaveBeenCalledWith('描述[图片 #1]', '描述[图片 #1] ', [image]);
    } finally {
      screen.unmount();
    }
  });
  it('attaches an entire file paste atomically and falls back to text when any image is invalid', async () => {
    const ws = tempWorkspace(),
      valid = ws.file('shot.png', ''),
      invalid = ws.file('fake.png', 'not image');
    writeFileSync(valid, Buffer.from(image.data, 'base64'));
    const submit = vi.fn(),
      notify = vi.fn();
    const screen = render(
      <InputBox
        active
        initialHistory={[]}
        placeholder=""
        deps={deps}
        onSubmit={submit}
        attachments={{ cwd: ws.dir, readClipboard: async () => ({ ok: false, reason: 'none' }), notify }}
      />,
    );
    try {
      await tick();
      screen.stdin.write(`\x1b[200~${valid}\n${invalid}\x1b[201~`);
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('不支持'), 'warn'));
      screen.stdin.write('\r');
      expect(submit).toHaveBeenCalledWith(`${valid}\n${invalid}`, `${valid}\n${invalid}`, []);
      screen.stdin.write(`\x1b[200~${valid}\x1b[201~`);
      await vi.waitFor(() => expect(screen.lastFrame()).toContain('图片 1'));
      screen.stdin.write('\r');
      expect(submit).toHaveBeenLastCalledWith('[图片 #1]', '[图片 #1] ', [image]);
    } finally {
      screen.unmount();
    }
  });
  it('preserves attached drafts across remounts and prevents an old read from writing into the new screen', async () => {
    let saved: EditorState = editorReducer(createEditor(), { type: 'attach', image });
    let finish!: (value: ClipboardImage) => void;
    const attachments = {
      cwd: '.',
      notify: vi.fn(),
      readClipboard: () =>
        new Promise<ClipboardImage>((resolve) => {
          finish = resolve;
        }),
    };
    const first = render(
      <InputBox
        active
        initialHistory={[]}
        initialState={saved}
        onStateChange={(state) => {
          saved = state;
        }}
        placeholder=""
        deps={deps}
        onSubmit={vi.fn()}
        attachments={attachments}
      />,
    );
    await tick();
    first.stdin.write('\x1bv');
    await tick();
    first.unmount();
    const submit = vi.fn();
    const second = render(
      <TerminalContext.Provider value={{ ascii: true, motion: false }}>
        <ThemeContext.Provider value={MONO}>
          <InputBox
            active
            initialHistory={[]}
            initialState={saved}
            onStateChange={(state) => {
              saved = state;
            }}
            placeholder=""
            deps={deps}
            onSubmit={submit}
            attachments={attachments}
            maxHeight={2}
          />
        </ThemeContext.Provider>
      </TerminalContext.Provider>,
    );
    try {
      Object.defineProperty(second.stdout, 'columns', { get: () => 12 });
      second.stdout.emit('resize');
      finish({ ok: true, image, source: 'clipboard' });
      await tick();
      expect(saved.imageSeq).toBe(1);
      expect(second.lastFrame()).toContain('图片 1');
      expect(second.lastFrame()?.split('\n').length).toBeLessThanOrEqual(2);
      second.stdin.write('\r');
      expect(submit).toHaveBeenCalledWith('[图片 #1]', '[图片 #1] ', [image]);
    } finally {
      second.unmount();
    }
  });
});
