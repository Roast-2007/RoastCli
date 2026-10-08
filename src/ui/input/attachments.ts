import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageBlock } from '../../core/types.js';
import { MAX_IMAGE_BYTES, imageMediaType } from '../../tools/read/image.js';

export function parsePastedImagePaths(text: string, cwd: string): string[] | null {
  const lines = text.trim().split(/\r?\n/);
  const result: string[] = [];
  for (let value of lines) {
    value = value.trim().replace(/^&\s+/, '');
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\\ /g, ' ');
    try {
      if (value.startsWith('file://')) value = fileURLToPath(value);
      const file = path.resolve(cwd, value);
      if (!/\.(png|jpe?g|gif|webp)$/i.test(file) || !statSync(file).isFile()) return null;
      result.push(file);
    } catch {
      return null;
    }
  }
  return result.length ? result : null;
}

export function imageFromBytes(data: Buffer): ImageBlock | string {
  if (data.length > MAX_IMAGE_BYTES) return '图片超过 5 MiB';
  const mediaType = imageMediaType(data);
  return mediaType ? { type: 'image', mediaType, data: data.toString('base64') } : '不支持的图片格式；请使用 PNG/JPEG/GIF/WebP';
}

export async function readImageAttachment(absPath: string): Promise<ImageBlock | string> {
  try {
    const file = await open(absPath, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return '图片路径不是文件';
      if (stat.size > MAX_IMAGE_BYTES) return '图片超过 5 MiB';
      const data = Buffer.alloc(MAX_IMAGE_BYTES + 1);
      let size = 0;
      while (size < data.length) {
        const read = await file.read(data, size, data.length - size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      return imageFromBytes(data.subarray(0, size));
    } finally {
      await file.close();
    }
  } catch (err) {
    return `无法读取图片：${err instanceof Error ? err.message : String(err)}`;
  }
}

export function attachmentLimit(images: ImageBlock[]): string | undefined {
  if (images.length > 8) return '单条消息最多 8 张图片';
  const sizes = images.map((image) => Buffer.byteLength(image.data, 'base64'));
  if (sizes.some((size) => size > MAX_IMAGE_BYTES)) return '图片超过 5 MiB';
  if (sizes.reduce((a, b) => a + b, 0) > 20 * 1024 * 1024) return '单条消息图片合计超过 20 MiB';
  return undefined;
}
