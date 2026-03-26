import { resolve } from 'path';
import Fs from 'fs-extra';
import klaw from 'klaw-sync';
import md5 from 'md5';
import sharp from 'sharp';
import logError from './logError.mjs';
import { getDirname } from './path.mjs';

const __dirname = getDirname(import.meta.url);

const DAY_MS = 24 * 3600 * 1000;
const CACHE_DIR = resolve(__dirname, '../../data/cache');

/**
 * 检测 buffer 是否为 WebP 格式（RIFF....WEBP magic number）
 */
const isWebP = (buf) =>
  buf.length >= 12 &&
  buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
  buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;

export const createCache = async (key, data) => {
  let filename = md5(key);
  const regex = /\.[a-zA-Z0-9]+$/;
  const match = filename.match(regex);
  if(!match){
    const ext = key.match(regex);
    filename +=`.${ext[0].substring(1).toLowerCase()}`;
  }

  let buffer = data instanceof Buffer ? data : Buffer.from(data);

  // 防御层1：WebP → PNG 预转换，避免下游 Jimp 不支持 WebP
  if (isWebP(buffer)) {
    try {
      buffer = await sharp(buffer).png().toBuffer();
      filename = filename.replace(/\.webp$/i, '.png');
      console.log('[cache] WebP → PNG 预转换成功');
    } catch (e) {
      console.warn('[cache] WebP → PNG 转换失败，保留原格式（safeJimpRead 将兜底）:', e.message);
    }
  }

  const filepath = resolve(CACHE_DIR, filename);
  Fs.ensureDirSync(CACHE_DIR);
  Fs.writeFileSync(filepath, buffer);
  return filepath;
};

export const getCache = key => {
  const filename = md5(key);
  const filepath = resolve(CACHE_DIR, filename);
  return Fs.existsSync(filepath) ? filepath : null;
};

const releaseExpiredCache = () => {
  if (!Fs.existsSync(CACHE_DIR)) return;
  const expireMs = Date.now() - 7 * DAY_MS; // 7 天过期
  try {
    klaw(CACHE_DIR, {
      nodir: true,
      depthLimit: 1,
      filter: ({ stats: { mtimeMs } }) => mtimeMs < expireMs,
    }).forEach(({ path }) => Fs.removeSync(path));
  } catch (e) {
    console.error('clear expired cache');
    logError(e);
  }
};

releaseExpiredCache();
setInterval(releaseExpiredCache, DAY_MS);
