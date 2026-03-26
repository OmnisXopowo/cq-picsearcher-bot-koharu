import { readFileSync } from 'fs';
import Jimp from 'jimp';
import sharp from 'sharp';

/**
 * 安全的 Jimp.read() 包装函数
 * 当 Jimp 不支持的格式（如 WebP）导致读取失败时，使用 sharp 转码为 PNG 后重试
 * @param {string|Buffer} input 文件路径或 Buffer
 * @returns {Promise<Jimp>}
 */
export default async function safeJimpRead(input) {
  try {
    return await Jimp.read(input);
  } catch (err) {
    if (!String(err).includes('Unsupported MIME type')) throw err;

    const buffer = typeof input === 'string' ? readFileSync(input) : input;
    const pngBuffer = await sharp(buffer).png().toBuffer();
    return await Jimp.read(pngBuffer);
  }
}
