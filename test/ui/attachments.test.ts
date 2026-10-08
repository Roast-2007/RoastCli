import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePastedImagePaths, readImageAttachment, attachmentLimit } from '../../src/ui/input/attachments.js';
import { attachedImages, createEditor, editorReducer, textOf } from '../../src/ui/input/editor.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import type { ImageBlock } from '../../src/core/types.js';

const image: ImageBlock = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' };
describe('image attachments', () => {
  it('accepts quoted, dragged, escaped-space, URL and relative existing image paths only', async () => {
    const ws = tempWorkspace(),
      file = ws.file('My Shot.PNG', '');
    writeFileSync(file, Buffer.from(image.data, 'base64'));
    for (const value of [`"${file}"`, `'${file}'`, `& '${file}'`, file.replace(/ /g, '\\ '), pathToFileURL(file).href, 'My\\ Shot.PNG'])
      expect(parsePastedImagePaths(` ${value}\n`, ws.dir)).toEqual([file]);
    expect(parsePastedImagePaths(`'${file}'\n${pathToFileURL(file).href}`, ws.dir)).toEqual([file, file]);
    for (const value of ['missing.png', 'C:\\missing\\x.png', '/missing/x.jpg', `${file}\nhello`, ws.file('x.txt', 'text')])
      expect(parsePastedImagePaths(value, ws.dir)).toBeNull();
    expect(await readImageAttachment(file)).toEqual(image);
    expect(await readImageAttachment(ws.file('fake.png', 'text'))).toContain('不支持');
    expect(await readImageAttachment(path.join(ws.dir, 'missing.png'))).toContain('无法读取');
  });
  it('preserves order, deduplicates tokens, drops deleted placeholders, and never reuses a number', () => {
    let state = editorReducer(createEditor(), { type: 'attach', image });
    state = editorReducer(state, { type: 'attach', image: { ...image, data: 'second' } });
    expect(textOf(state)).toBe('[图片 #1] [图片 #2] ');
    expect(attachedImages(state, '[图片 #2] [图片 #1] [图片 #2]')).toEqual([state.images['[图片 #2]'], image]);
    expect(attachedImages(state, '[图片 #2]')).toHaveLength(1);
    state = editorReducer(state, { type: 'clear' });
    state = editorReducer(state, { type: 'attach', image });
    expect(textOf(state)).toContain('#3');
    const committed = editorReducer(state, { type: 'commit' });
    expect(committed.images).toEqual({});
    expect(committed.history).toEqual(['[图片 #3] ']);
    expect(editorReducer(state, { type: 'set', text: '[图片 #3]' }).images).toEqual({});
  });
  it('enforces independent count, single-image, and total-byte limits', () => {
    expect(attachmentLimit(Array(9).fill(image))).toContain('8 张');
    const big = { ...image, data: Buffer.alloc(5 * 1024 * 1024).toString('base64') };
    expect(attachmentLimit(Array(4).fill(big))).toBeUndefined();
    expect(attachmentLimit(Array(5).fill(big))).toContain('20 MiB');
    expect(attachmentLimit([{ ...big, data: big.data + 'AAAA' }])).toContain('5 MiB');
  });
  it('keeps image drafts separate from text-only history and discards the saved draft when editing history', () => {
    let state = editorReducer(createEditor(['[图片 #1] old']), { type: 'attach', image });
    state = editorReducer(state, { type: 'up' });
    expect(textOf(state)).toBe('[图片 #1] old');
    expect(attachedImages(state, textOf(state))).toEqual([]);
    const restored = editorReducer(state, { type: 'down' });
    expect(attachedImages(restored, textOf(restored))).toEqual([image]);
    const edited = editorReducer(state, { type: 'backspace' });
    expect(edited.historyIndex).toBeNull();
    expect(editorReducer(edited, { type: 'down' }).images).toEqual({});
    expect(editorReducer(state, { type: 'set', text: 'replacement' }).draftImages).toBeNull();
  });
});
