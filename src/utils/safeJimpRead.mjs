import { readFileSync } from 'fs';
import Jimp from 'jimp';
import sharp from 'sharp';

function isJimpMimeError(err) {
  const message = String(err?.message || err);
  return message.includes('Unsupported MIME type') || message.includes('Could not find MIME for Buffer');
}

/**
 * 安全的 Jimp.read() 包装函数
 * 当 Jimp 不支持的格式（如 WebP）导致读取失败时，使用 sharp 转码为 PNG 后重试
 * @param {string|Buffer} input 文件路径或 Buffer
 * @returns {Promise<Jimp>}
 */
export default async function safeJimpRead(input) {
  if (!input || (Buffer.isBuffer(input) && input.length === 0)) {
    throw new Error('图片数据为空，无法读取');
  }

  try {
    return await Jimp.read(input);
  } catch (err) {
    if (!isJimpMimeError(err)) throw err;

    const buffer = typeof input === 'string' ? readFileSync(input) : input;
    if (!buffer || buffer.length === 0) {
      throw new Error('图片数据为空，无法转码');
    }

    try {
      const pngBuffer = await sharp(buffer).png().toBuffer();
      return await Jimp.read(pngBuffer);
    } catch (convertErr) {
      throw new Error(`图片格式无法识别或转码失败: ${convertErr?.message || convertErr}`);
    }
  }
}
