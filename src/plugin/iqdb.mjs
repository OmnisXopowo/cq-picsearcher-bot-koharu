import AxiosProxy from '../utils/axiosProxy.mjs';
import { load } from 'cheerio';
import _ from 'lodash';
import { getCqImg64FromUrl, getAntiShieldedCqImg64FromUrl, dlImgToCacheBuffer } from '../utils/image.mjs';
import { confuseURL } from '../utils/url.mjs';

const BASE_URLs = {
  '2d': 'https://iqdb.org/',
  '3d': 'https://3d.iqdb.org/'
};

async function IqDB(url) {
  const form = new FormData();
  form.append('url', url);

  let agent = null
  // if (Config.getConfig().proxy.enable) {
  //     let proxy = 'http://' + Config.getConfig().proxy.host + ':' + Config.getConfig().proxy.port
  //     agent = new HttpsProxyAgent(proxy)
  // }

  //const discolor = await Config.getConfig().IqDB.discolor;
  const discolor = false;


  if (discolor) form.append('forcegray', 'on');

    const { data } = await AxiosProxy.post('http://iqdb.org', form, {
      validateStatus: status => 200 <= status && status < 500,
    });

    //if (debug) console.log(` response:`, inspect(data, { depth: null }));

    if (data.error) {
      const errorMsg = data.error.message;
      console.error(`Iqdb error:`, errorMsg);
      return {
        ReturnMsg: `Iqdb 搜索出错：${errorMsg}`,
        success: false,
      };
    }

    const IqDBResults = parse(data);

    if(IqDBResults && IqDBResults.length > 0){


      const res = IqDBResults[0];
      let snLowAcc = res.similarity < global.config.bot.saucenaoLowAcc;

      const colorRet = await getText(res,snLowAcc);

      return {
        ReturnMsg:colorRet,
        success: true,
      };
    }
    return {
      ReturnMsg: `Iqdb搜索无结果`,
      success: false,
    };
}

function parse(body) {
  const $ = load(body);
  return _.map($('table'), (result) => {
    const content = $(result).text(),
      [link] = $('td.image > a', result),
      [image] = $('td.image img', result);

    if (!link) return;

    const [, similarity] = content.match(/(\d+%)\s*similarity/) ?? [],
      [, level] = content.match(/\[(\w+)\]/) ?? [],
      [, resolution] = content.match(/(\d+×\d+)/) ?? [];

    return {
      url: new URL(link.attribs.href, 'https://iqdb.org/').toString(),
      image: new URL(image.attribs.src, 'https://iqdb.org/').toString(),
      similarity: similarity ? parseFloat(similarity.replace('%', '')) : undefined,
      resolution,
      level: level ? level.toLowerCase() : undefined,
    };
  }).filter((value) => value !== undefined)
    .sort((a, b) => b.similarity - a.similarity);
}

async function getText(IqDBResult, snLowAcc = false) {
  const IqdbReturnMsg = [`Iqdb最高${IqDBResult.similarity}%相似：`];
  
  if (IqDBResult.image && !(global.config.bot.hideImg || ( IqDBResult.level !='safe' && (snLowAcc && global.config.bot.hideImgWhenLowAcc)))) {
    const mode = global.config.bot.antiShielding;
    if (mode > 0) IqdbReturnMsg.push(await getAntiShieldedCqImg64FromUrl(IqDBResult.image, mode));
    else IqdbReturnMsg.push(await getCqImg64FromUrl(IqDBResult.image));
  }
  if (IqDBResult.url) IqdbReturnMsg.push(confuseURL(IqDBResult.url));
  return IqdbReturnMsg.join('\n');
}


export default IqDB;