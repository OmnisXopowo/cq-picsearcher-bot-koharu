import { readFileSync } from 'fs';
import Jimp from 'jimp';
import { random } from 'lodash-es';

const RAND_MOD_PX = 0b1;
const ROTATE_LEFT = 0b10;
const ROTATE_RIGHT = 0b100;
const ROTATE_DOWN = 0b1000;

/**
 * 图片反和谐处理
 * @param {ArrayBuffer} arrayBuffer
 * @param {number} mode
 * @returns base64
 */
export async function imgAntiShieldingFromArrayBuffer(arrayBuffer, mode) {
  const img = await Jimp.read(Buffer.from(arrayBuffer));
  return await imgAntiShielding(img, mode);
}

/**
 * 从本地文件路径读取图片并进行反和谐处理
 * @param {string} filePath 本地缓存文件的绝对路径
 * @param {number} mode 反和谐模式位掩码（同 imgAntiShielding 的 mode）
 * @returns {Promise<string>} base64 字符串（不含 data:...;base64, 前缀）
 */
export async function imgAntiShieldingFromFilePath(filePath, mode) {
  const buffer = readFileSync(filePath);
  const img = await Jimp.read(buffer);
  return await imgAntiShielding(img, mode);
}

/**
 * 图片反和谐处理
 * @param {Jimp} img
 * @param {number} mode
 * @returns base64
 */
export async function imgAntiShielding(img, mode) {
  if (mode & RAND_MOD_PX) randomModifyPixels(img);

  if (mode & ROTATE_LEFT) img.simpleRotate(90);
  else if (mode & ROTATE_RIGHT) img.simpleRotate(-90);
  else if (mode & ROTATE_DOWN) img.simpleRotate(180);

  const base64 = await img.getBase64Async(Jimp.AUTO);
  return base64.split(',')[1];
}

/**
 * 随机修改四角像素
 * @param {Jimp} img
 */
function randomModifyPixels(img) {
  const [w, h] = [img.getWidth(), img.getHeight()];
  const pixels = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const delta = () => (random(0, 1) ? 1 : -1) * random(1, 2);
  for (const [x, y] of pixels) {
    // 读取原始 RGB 并微调 ±1~2，alpha 固定为 255，确保 JPEG 格式下文件 hash 真正改变
    const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
    img.setPixelColor(Jimp.rgbaToInt(clamp(r + delta()), clamp(g + delta()), clamp(b + delta()), 255), x, y);
  }
}
