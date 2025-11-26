import _ from 'lodash-es';
import CQ from './CQcode.mjs';
import { getAntiShieldedCqImg64FromUrl } from './image.mjs';

const getKey = (img, db) => `${img.file}.${db}`;

const CTX_COMPARE_KEY = {
  private: 'user_id',
  group: 'group_id',
  discuss: 'discuss_id',
  guild: 'group_id',
};
const isEqualCtx = (a, b) => {
  if (a.message_type !== b.message_type) return false;
  return a[CTX_COMPARE_KEY[a.message_type]] === b[CTX_COMPARE_KEY[b.message_type]];
};
const isPrivateCtx = ctx => ctx.message_type === 'private';
const isGroupCtx = ctx => ctx.message_type === 'group';

const PUT_RETURN = {
  IS_SEARCHING: Symbol('在搜了'),
  IS_FIRST: Symbol('第一个搜的'),
  NOT_FIRST: Symbol('不是第一个搜的'),
};

class SearchingMap extends Map {
  put(img, db, ctx) {
    const ctxs = (() => {
      const key = getKey(img, db);
      if (super.has(key)) return super.get(key);
      const arr = [];
      super.set(key, arr);
      return arr;
    })();
    if (ctxs.some(_ctx => isEqualCtx(_ctx, ctx))) return PUT_RETURN.IS_SEARCHING;
    return ctxs.push(ctx) > 1 ? PUT_RETURN.NOT_FIRST : PUT_RETURN.IS_FIRST;
  }

  /**
   * 获取回复处理器
   * @param {Object} img - 图片对象
   * @param {Object} db - 数据库对象
   * @returns {Object} 包含 reply 和 end 方法的回复处理器对象
   *   - reply: 异步方法,用于发送消息
   *   - end: 异步方法,用于结束会话并清理资源
   * @throws {Error} 当找不到上下文时抛出错误
   * @description
   * 创建一个回复处理器,用于处理搜图结果的回复。
   * 支持群组转发和私聊转发功能,可配置防屏蔽模式。
   * 会根据配置自动处理消息的发送方式。
   */
  getReplier(img, db) {
    const key = getKey(img, db);
    const ctxs = super.get(key);
    if (!ctxs) throw new Error('no ctxs');

    const mainCtx = _.head(ctxs);
    const mainPromises = [];
    const allMsgs = [];

    const { groupForwardSearchResult, privateForwardSearchResult, pmSearchResult, pmSearchResultTemp } =
      global.config.bot;
    const needGroupForward =
      (privateForwardSearchResult && (isPrivateCtx(mainCtx) || (pmSearchResult && !pmSearchResultTemp))) ||
      (groupForwardSearchResult && isGroupCtx(mainCtx));

    return {
      reply: async (...msgs) => {
        _.remove(msgs, msg => !msg);
        allMsgs.push(...msgs);

        if (needGroupForward) return;

        const promise = global.replySearchMsgs(mainCtx, msgs, undefined, {
          groupForwardSearchResult,
          privateForwardSearchResult,
          pmSearchResult,
          pmSearchResultTemp,
        });
        mainPromises.push(promise);
        return promise;
      },
      end: async ({ file, url }) => {
        await Promise.all(mainPromises);
        super.delete(key);

        const restCtxs = needGroupForward ? ctxs : _.tail(ctxs);
        const antiShieldingMode = global.config.bot.antiShielding;
        const cqImg =
          antiShieldingMode > 0 ? await getAntiShieldedCqImg64FromUrl(url, antiShieldingMode) : CQ.img(file);

        for (const ctx of restCtxs) {
          try {
            await global.replySearchMsgs(ctx, allMsgs, [cqImg], {
              groupForwardSearchResult,
              privateForwardSearchResult,
              pmSearchResult,
              pmSearchResultTemp,
            });
          } catch (e) {}
        }
      },
    };
  }
}

export default Object.assign(new SearchingMap(), PUT_RETURN);
