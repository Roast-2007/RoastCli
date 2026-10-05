import { open } from 'node:fs/promises';
import { z } from 'zod';
import { resolveUserPath } from '../../core/paths.js';
import { defineTool, toolErrorResult } from '../tool.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function imageMediaType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

export const readImageTool = defineTool({
  name: 'read_image',
  description: '读取本地 PNG/JPEG/GIF/WebP 图片并将图像发送给支持视觉的模型，用于截图、UI 稿和报错图片。最大 5 MiB。',
  parameters: z.object({ path: z.string().min(1) }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'read', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path) },
  async execute(args, ctx) {
    const file = await open(resolveUserPath(ctx.cwd, args.path), 'r');
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return toolErrorResult('read_image', '图片必须是文件且不超过 5 MiB');
      const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        ctx.signal.throwIfAborted();
        const result = await file.read(bytes, size, bytes.length - size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > MAX_IMAGE_BYTES) return toolErrorResult('read_image', '图片超过 5 MiB');
      const data = bytes.subarray(0, size),
        mediaType = imageMediaType(data);
      if (!mediaType) return toolErrorResult('read_image', '不支持的图片格式；请使用 PNG/JPEG/GIF/WebP');
      return {
        content: [
          { type: 'text' as const, text: `图片：${args.path}（${mediaType}, ${size} bytes）` },
          { type: 'image' as const, mediaType, data: data.toString('base64') },
        ],
      };
    } finally {
      await file.close();
    }
  },
});
