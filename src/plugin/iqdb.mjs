import { load } from 'cheerio';
import _ from 'lodash';
import AxiosProxy from '../utils/axiosProxy.mjs';
import { getCqImg64FromUrl, getAntiShieldedCqImg64FromUrl, dlImgToCacheBuffer } from '../utils/image.mjs';
import { confuseURL } from '../utils/url.mjs';


async function IqDB(url) {
  // 使用 URLSearchParams 替代 FormData 以匹配 Python 库的行为
  const params = new URLSearchParams();
  params.append('url', url);

  // 添加 User-Agent 以匹配 Python 库
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.82 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  const discolor = false;

  if (discolor) params.append('forcegray', 'on');

  try {
    const { data } = await AxiosProxy.post('https://danbooru.iqdb.org/', params, {
      headers,
      validateStatus: status => (200 <= status && status < 500),
    });

    const IqDBResults = parse(data);

    if(IqDBResults && IqDBResults.length > 0){
      const res = IqDBResults[0];
      const snLowAcc = res.similarity < global.config.bot.saucenaoLowAcc;
      const colorRet = await getText(res, snLowAcc);

      return {
        ReturnMsg: colorRet,
        success: true,
        isLowAcc: snLowAcc,
        similarity: res.similarity
      };
    }
    
    return {
      ReturnMsg: `Iqdb搜索无结果`,
      success: false,
      isLowAcc: true
    };
  } catch (error) {
    console.error(`Iqdb error:`, error.message);
    return {
      ReturnMsg: `Iqdb 搜索出错：${error.message}`,
      success: false,
    };
  }
}

function parse(body) {
  const $ = load(body);
  return _.map($('table'), (result) => {
    const content = $(result).text();
    const [link] = $('td.image > a', result);
    const [image] = $('td.image img', result);

    if (!link) return;

    const [, similarity] = content.match(/(\d+%)\s*similarity/) ?? [];
    const [, level] = content.match(/\[(\w+)\]/) ?? [];
    const [, resolution] = content.match(/(\d+×\d+)/) ?? [];

    return {
      url: new URL(link.attribs.href, 'https://iqdb.org/').toString(),
      image: new URL(image.attribs.src, 'https://iqdb.org/').toString(),
      similarity: similarity ? parseFloat(similarity.replace('%', '')) : undefined,
      resolution,
      level: level ? level.toLowerCase() : undefined,
    };
  }).filter((value) => value !== undefined)
    .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
}

async function getText(IqDBResult, snLowAcc = false) {
  const IqdbReturnMsg = [`Iqdb最高${IqDBResult.similarity}%相似：`];
  
  if (IqDBResult.image && !(global.config.bot.hideImg || (IqDBResult.level != 'safe' && (snLowAcc && global.config.bot.hideImgWhenLowAcc)))) {
    const mode = global.config.bot.antiShielding;
    if (mode > 0) IqdbReturnMsg.push(await getAntiShieldedCqImg64FromUrl(IqDBResult.image, mode));
    else IqdbReturnMsg.push(await getCqImg64FromUrl(IqDBResult.image));
  }
  if (IqDBResult.url) IqdbReturnMsg.push(confuseURL(IqDBResult.url));
  return IqdbReturnMsg.join('\n');
}

export default IqDB;