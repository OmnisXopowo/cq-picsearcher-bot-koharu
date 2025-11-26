import baidubce from './baidubce.mjs';
import ocrspace from './ocr.space.mjs';
import tesseract from './Tesseract.mjs';
import qq from './qq.mjs';
import tencent from './tencent.mjs';

const ocrs = {
  'ocr.space': ocrspace,
  baidubce,
  tencent,
  qq
};

/**
 * @param {string} def
 * @param {string[]} [fb]
 */
const ocrWithFallback = (def, fb) => {
  if (!fb?.length) return ocrs[def];
  const apis = [def, ...fb];
  return async (...args) => {
    let err;
    for (const api of apis) {
      try {
        return await ocrs[api](...args);
      } catch (error) {
        if (global.config.bot.debug) {
          console.error(`[ocr] ${api} error`);
          console.error(error);
        }
        err = error;
      }
    }
    throw err;
  };
};




export default {
  get default() {
    return ocrWithFallback(global.config.bot.ocr.use, global.config.bot.ocr.fallback);
  },
  get local() {
    return ocrWithFallback('qq', global.config.bot.ocr.fallback);
  },
  ...ocrs,
};
