import { readFileSync } from 'fs';
import FormData from 'form-data';
import _ from 'lodash-es';
import Axios from '../utils/axiosProxy.mjs';
import CQ from '../utils/CQcode.mjs';
import { flareSolverr } from '../utils/flareSolverr.mjs';
import getSource from '../utils/getSource.mjs';
import { getAntiShieldedCqImg64FromUrl, getCqImg64FromUrl } from '../utils/image.mjs';
import logError from '../utils/logError.mjs';
import { confuseURL } from '../utils/url.mjs';
import nhentai from './nhentai.mjs';

let hostsI = 0;

const snDB = {
  all: 999,
  pixiv: 5,
  danbooru: 9,
  book: 18,
  doujin: 18,
  anime: 21,
  原图: 10000,
  来源: 10001,

};

/**
 * saucenao 搜索
 *
 * @param {MsgImage} img 图片
 * @param {string} db 搜索库
 * @param {boolean} [debug=false] 是否调试
 * @param {boolean} [withoutThumbnail=false] 是否不显示缩略图
 * @returns Promise 返回消息、返回提示
 */
async function doSearch(img, db, debug = false, withoutThumbnail = false) {
  const hosts = global.config.saucenaoHost;
  const apiKeys = global.config.saucenaoApiKey;
  const index = hostsI++;
  const hostIndex = index % hosts.length; // 决定当前使用的host
  const apiKeyIndex = index % apiKeys.length;

  let warnMsg = ''; // 返回提示
  let msg = global.config.bot.replys.failed; // 返回消息
  let success = false;
  let lowAcc = false;
  let excess = false;
  let topSimilarity = null; // 最高相似度

  if (apiKeys[apiKeyIndex]) {
    await getSearchResult(hosts[hostIndex], apiKeys[apiKeyIndex], img, db)
      .then(async ret => {
        const data = ret.data;

        // 如果是调试模式
        if (debug) {
          console.log(`saucenao[${hostIndex}] ${hosts[hostIndex]}`);
          console.log(JSON.stringify(data));
        }

        // 确保回应正确
        if (typeof data !== 'object') {
          console.error(`[saucenao] 响应数据类型异常: ${typeof data}，内容前200字符: ${String(data).slice(0, 200)}`);
          throw ret;
        }
        if (data.results && data.results.length > 0) {
          data.results.forEach(({ header }) => (header.similarity = parseFloat(header.similarity)));
          topSimilarity = data.results[0].header.similarity; // 保存最高相似度
          if (db === snDB.all && data.results[0].header.index_id !== snDB.pixiv) {
            const firstSim = data.results[0].header.similarity;
            const pixivIndex = data.results.findIndex(
              // 给一点点权重
              ({ header: { similarity, index_id } }) => index_id === snDB.pixiv && similarity * 1.03 >= firstSim,
            );
            if (pixivIndex !== -1) {
              const pixivResults = data.results.splice(pixivIndex, 1);
              data.results.unshift(...pixivResults);
            }
          }
          let {
            header: {
              short_remaining, // 短时剩余
              long_remaining, // 长时剩余
              similarity, // 相似度
              thumbnail, // 缩略图
              index_id, // 图库
              hidden, // 是否因 NSFW 而需要隐藏
            },
            data: {
              ext_urls,
              title, // 标题
              member_name, // 作者
              member_id, // 可能 pixiv uid
              eng_name, // 本子名
              jp_name, // 本子名
              source, // 来源
              author, // 作者
              artist, // 作者
            },
          } = data.results[0];
          const simText = similarity.toFixed(2);
          let sourceTitle = null;
          if (!/^https?:\/\//.test(source)) {
            sourceTitle = source;
            source = null;
          }

          let url = ''; // 结果链接
          if (ext_urls) {
            url = ext_urls[0];
            if (index_id === snDB.pixiv) {
              // 如果结果为 pixiv，尝试找到原始投稿，避免返回盗图者的投稿
              const pixivResults = data.results.filter(
                result =>
                  result.header.index_id === snDB.pixiv &&
                  _.get(result, 'data.ext_urls[0]') &&
                  Math.abs(result.header.similarity - similarity) < 5,
              );
              if (pixivResults.length > 1) {
                const result = _.minBy(pixivResults, result =>
                  parseInt(result.data.ext_urls[0].match(/\d+/).toString()),
                );
                url = result.data.ext_urls[0];
                title = result.data.title;
                member_name = result.data.member_name;
                member_id = result.data.member_id;
                similarity = result.header.similarity;
                thumbnail = result.header.thumbnail;
              }
            } else if (ext_urls.length > 1) {
              // 如果结果有多个，优先取 danbooru
              for (let i = 1; i < ext_urls.length; i++) {
                if (ext_urls[i].indexOf('danbooru') !== -1) url = ext_urls[i];
              }
            }
            url = url.replace('http://', 'https://');
            // 获取来源
            if (!source) source = await getSource(url).catch(() => null);
            if (source && source.includes('i.pximg.net')) {
              source = source.replace(/.*\/(\d+).*?$/, 'https://pixiv.net/i/$1');
            }
          }

          title = title || sourceTitle;
          author = member_name || author || artist;
          if (author && author.length) title = `「${title}」/「${author}」`;

          // 剩余搜图次数
          if (long_remaining < 20) warnMsg += `saucenao-${hostIndex}：注意，24h内搜图次数仅剩${long_remaining}次\n`;
          else if (short_remaining < 5) {
            warnMsg += `saucenao-${hostIndex}：注意，30s内搜图次数仅剩${short_remaining}次\n`;
          }

          // 相似度
          if (similarity < global.config.bot.saucenaoLowAcc) {
            lowAcc = true;
            warnMsg += `相似度 ${simText}% 过低，如果这不是你要找的图，那么可能：确实找不到此图/图为原图的局部图/图清晰度太低/搜索引擎尚未同步新图\n`;
            if (global.config.bot.useAscii2dWhenLowAcc && (db === snDB.all || db === snDB.pixiv))
              warnMsg += '自动使用 IqDb 进行搜索\n';
          }

          const hideThumbnail =
            (global.config.bot.hideImgWhenLowAcc && similarity < global.config.bot.saucenaoLowAcc) || hidden;

          // 回复的消息
          msg = await getShareText({
            url: CQ.escape(url),
            title: [`相似度:${simText}%`, CQ.escape(title)].filter(v => v).join('\n'),
            thumbnail: hideThumbnail ? null : thumbnail,
            author_url: member_id && url.indexOf('pixiv.net') >= 0 ? `https://pixiv.net/u/${member_id}` : null,
            source: CQ.escape(source),
            withoutThumbnail
          });

          success = true;

          // 如果是本子
          const doujinName = jp_name || eng_name; // 本子名
          if (doujinName) {
            if (global.config.bot.getDoujinDetailFromNhentai) {
              const searchName = (eng_name || jp_name).replace('(English)', '').replace(/_/g, '/');
              const doujin = await nhentai(searchName).catch(e => {
                logError('[error] nhentai');
                logError(e);
              });
              // 有本子搜索结果的话
              if (doujin) {
                thumbnail = doujin.thumb;
                url = doujin.url;
              } else {
                if (db === snDB.all) success = false;
                warnMsg += '貌似没有在 nhentai 找到对应的本子 _(:3」∠)_\n';
              }
            }
            msg = await getShareText({
              url,
              title: `(${simText}%) ${CQ.escape(doujinName)}`,
              thumbnail: hideThumbnail ? null : thumbnail,
              withoutThumbnail
            });
          }

          // 处理返回提示
          if (warnMsg.length > 0) warnMsg = warnMsg.trim();
        } else if (data.header?.message) {
          const retMsg = data.header.message;
          console.warn(`[saucenao] API 返回消息: "${retMsg}"`, {
            status: data.header.status,
            short_remaining: data.header.short_remaining,
            long_remaining: data.header.long_remaining,
          });
          if (retMsg.startsWith('Specified file no longer exists on the remote server')) {
            msg = '该图片已过期，请尝试二次截图后发送';
          } else if (retMsg.startsWith('Problem with remote server')) {
            // 解析远程服务器错误详情: "Problem with remote server... (400 - https://...)"
            const detailMatch = retMsg.match(/\((\d+)\s*-\s*(https?:\/\/[^\s)]+)/);
            if (detailMatch) {
              const httpCode = detailMatch[1];
              const failedUrl = detailMatch[2];
              // 判断是图片 URL 不可达还是 SauceNAO 自身问题
              const isImageUrlIssue = failedUrl.includes('qq.com') || failedUrl.includes('qpic.cn')
                || failedUrl.includes('gchat.') || failedUrl.includes('multimedia.');
              if (isImageUrlIssue) {
                console.warn(`[saucenao] 远程服务器无法访问图片 URL (HTTP ${httpCode}): ${failedUrl.slice(0, 80)}...`);
                msg = `saucenao-${hostIndex} SauceNAO 无法访问图片链接 (HTTP ${httpCode})，QQ 图片链接可能已过期或不可公网访问`;
              } else {
                console.warn(`[saucenao] 远程目标服务器异常 (HTTP ${httpCode}): ${failedUrl.slice(0, 80)}...`);
                msg = `saucenao-${hostIndex} 远程服务器异常 (HTTP ${httpCode}: ${new URL(failedUrl).hostname})`;
              }
            } else {
              msg = `saucenao-${hostIndex} 远程服务器出现问题，请稍后尝试重试`;
            }
          } else {
            logError(data);
            msg = `saucenao-${hostIndex} ${CQ.escape(retMsg)}`;
          }
        } else {
          console.error(`[saucenao] 响应数据结构异常，无 results 也无 header.message:`, JSON.stringify(data).slice(0, 500));
          logError(`[error] saucenao[${hostIndex}][data]`);
          logError(data);
        }
      })
      .catch(e => {
        logError(`[error] saucenao[${hostIndex}][request]`);
        if (typeof e === 'string') {
          msg = e;
          logError(e);
        } else if (e.response) {
          console.error(`[saucenao] HTTP 错误 ${e.response.status}:`, {
            statusText: e.response.statusText,
            contentType: e.response.headers?.['content-type'],
            dataPreview: typeof e.response.data === 'string' ? e.response.data.slice(0, 300) : undefined,
          });
          if (e.response.status === 429) {
            msg = `saucenao-${hostIndex} 搜索次数已达单位时间上限，请稍候再试`;
            excess = true;
          } else {
            logError(e.response.data);
          }
        } else {
          console.error(`[saucenao] 非 HTTP 错误:`, e.message || e);
          logError(e);
        }
      });
  } else {
    msg = '未配置 saucenaoApiKey，无法使用 saucenao 搜图';
  }

  return {
    success,
    msg,
    warnMsg,
    lowAcc,
    excess,
    similarity: topSimilarity,
  };
}

async function getShareText({ url, title, thumbnail, author_url, source ,withoutThumbnail=false}) {
  const texts = [title];
  if (thumbnail && !global.config.bot.hideImg && !withoutThumbnail) {
    const mode = global.config.bot.antiShielding;
    if (mode > 0) texts.push(await getAntiShieldedCqImg64FromUrl(thumbnail, mode));
    else texts.push(await getCqImg64FromUrl(thumbnail));
  }
  if (url) texts.push(confuseURL(url));
  if (author_url) texts.push(`作者: ${confuseURL(author_url)}`);
  if (source) texts.push(confuseURL(source));
  return texts.join('\n');
}

/**
 * 取得搜图结果
 *
 * @param {string} host 自定义 saucenao 的 host
 * @param {string} api_key saucenao api key
 * @param {MsgImage} img 欲搜索的图片
 * @param {number} [db=999] 搜索库
 * @returns Axios 对象
 */
async function getSearchResult(host, api_key, img, db = 999) {
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;

  const dbParam = {};
  switch (db) {
    case snDB.来源:
      dbParam.dbs = [9, 5];
      break;
    case snDB.doujin:
      dbParam.dbs = [18, 38];
      break;
    case snDB.anime:
      dbParam.dbs = [21, 22];
      break;
    default:
      dbParam.db = db;
      break;
  }

  const url = `${host}/search.php`;
  const params = {
    ...(api_key ? { api_key } : {}),
    ...dbParam,
    output_type: 2,
    numres: 3,
    hide: global.config.bot.hideImgWhenSaucenaoNSFW,
  };

  const maskedKey = api_key ? `${api_key.slice(0, 4)}****${api_key.slice(-4)}` : '(none)';

  // ========== 分支 A：本地上传模式（仅 Layer 1+2：多代理+直连） ==========
  if (global.config.bot.saucenaoLocalUpload || !img.isUrlValid) {
    const path = await img.getPath();
    if (path) {
      const form = new FormData();
      form.append('file', readFileSync(path), 'image');
      console.log(`[saucenao] 使用本地上传模式 (key=${maskedKey})`);
      return Axios.searchPost(url, form, {
        params,
        headers: form.getHeaders(),
      });
    }
  }

  // ========== 分支 B：URL 模式（完整 4 层降级链） ==========
  if (img.isUrlValid) {
    const fullParams = { ...params, url: img.rawUrl || img.url };

    // --- Layer 1+2: Axios searchGet（多代理轮询 → 直连） ---
    try {
      console.log(`[saucenao] Layer 1+2: Axios searchGet (key=${maskedKey})`);
      return await Axios.searchGet(url, { params: fullParams });
    } catch (axiosErr) {
      const errMsg = axiosErr?.message || String(axiosErr);
      const status = axiosErr?.response?.status;
      console.warn(`[saucenao] Layer 1+2 失败${status ? ` (HTTP ${status})` : ''}: ${errMsg}`);

      // HTTP 429 是 API 频率限制，换工具请求同一个 api_key 仍会 429，不降级
      if (status === 429) throw axiosErr;
    }

    // 构建完整 URL 供 Puppeteer/FlareSolverr 使用
    const fullUrl = `${url}?${new URLSearchParams(fullParams).toString()}`;

    // --- Layer 3: Puppeteer getJSON ---
    try {
      console.log('[saucenao] Layer 3: 尝试 Puppeteer getJSON...');
      const { puppeteer } = await import('../../libs/puppeteer/index.mjs');
      const result = await puppeteer.getJSON(fullUrl);
      console.log('[saucenao] Layer 3: ✓ Puppeteer 成功');
      return result;
    } catch (puppeteerErr) {
      console.warn(`[saucenao] Layer 3: ✗ Puppeteer 失败: ${puppeteerErr?.message || puppeteerErr}`);
    }

    // --- Layer 4: FlareSolverr getJSON ---
    const fsUrl = global.config?.flaresolverr?.url;
    if (fsUrl) {
      try {
        console.log('[saucenao] Layer 4: 尝试 FlareSolverr getJSON...');
        const result = await flareSolverr.getJSON(fullUrl);
        console.log('[saucenao] Layer 4: ✓ FlareSolverr 成功');
        return result;
      } catch (fsErr) {
        console.error(`[saucenao] Layer 4: ✗ FlareSolverr 失败: ${fsErr?.message || fsErr}`);
      }
    } else {
      console.log('[saucenao] Layer 4: 跳过 FlareSolverr（未配置 flaresolverr.url）');
    }

    // 所有层都失败
    throw new Error('[saucenao] 所有请求方式均失败（多代理→直连→Puppeteer→FlareSolverr）');
  }

  // eslint-disable-next-line no-throw-literal
  throw '部分图片无法获取，如为转发请尝试保存后再手动发送，或使用其他设备手动发送';
}

export default doSearch;

export { snDB };
