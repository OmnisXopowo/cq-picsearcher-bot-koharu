import { inspect } from 'util';
import { pick } from 'lodash-es';
import AxiosProxy from '../../utils/axiosProxy.mjs';
import { DailyCount } from '../../utils/dailyCount.mjs';
import emitter from '../../utils/emitter.mjs';
import { retryAsync } from '../../utils/retry.mjs';
import { getglmContent, insertglmContent, deleteglmContent, createJWT } from './auth.mjs'

const dailyCount = new DailyCount();

let overrideGroups = [];

emitter.onConfigLoad(() => {
  overrideGroups = global.config.bot.characterglm.overrides.map(({ blackGroup, whiteGroup }) => {
    const override = {};
    if (blackGroup) override.blackGroup = new Set(blackGroup);
    if (whiteGroup) override.whiteGroup = new Set(whiteGroup);
    return override;
  });
});

const getMatchAndConfig = text => {
  const globalConfig = global.config.bot.characterglm;
  let match;
  if(text.startsWith(globalConfig.nickname)){
    match = text.replace(globalConfig.nickname,"");
  }
  else if (text.includes(globalConfig.nickname)) {
    match = text.replace(globalConfig.nickname,globalConfig.meta.bot_name);
  }else if(text.includes(globalConfig.meta.bot_name)){
    match = text;
  }

  return {
    match,
    config: pick(
      globalConfig,
      [
        'model',
        'prependMessages',
        'nickname',
        'apiKey',
        'blackGroup',
        'whiteGroup',
        'meta',
      ]
    ),
  };
};


const callCharacterAPI = (prompt, config, context) => {
  //群单例，群聊模式
  const singleton = true;

  return retryAsync(async () => {
    const { debug } = global.config.bot;
    if (prompt == "--r") {
      deleteglmContent(context.group_id, singleton? '0':context.user_id);
      return '已清空上下文'
    }

    let content = getglmContent(context.group_id, singleton? '0':context.user_id)

    content.choices.push({ role: 'user', content: prompt });

    const param = {
      meta: config.meta,
      prompt: [
        ...(Array.isArray(config.prependMessages) ? config.prependMessages : []),
        ...content.choices,
      ],
    };


    if (content.request_id) {
      param.request_id = content.request_id;
    }

    const jwttoken = createJWT(config.apiKey);

    const headers = {
      Authorization: jwttoken,
      'Content-Type': 'application/json',
    };


    if (debug) console.log('[characterglm] params:', inspect(param, { depth: null }));

    const { data } = await AxiosProxy.post('https://open.bigmodel.cn/api/paas/v3/model-api/charglm-3/invoke', param, {
      headers,
      validateStatus: status => 200 <= status && status < 500,
    });
    if (debug) console.log('[characterglm] response:', inspect(data, { depth: null }));

    if (data.error) {
      const errorMsg = data.error.message;
      console.error('[characterglm] error:', errorMsg);
      return `ERROR1: ${errorMsg}`;
    }
    let returnMessage = '';

    if (data.data.choices) {
      const choiceResponses = data.data.choices.map(obj => {
          let FormatResult = obj.content.replace(/(\"*)(\\n*)/g, '').trim();
          returnMessage += FormatResult;
          return {
            ...obj,
            content : FormatResult
          };
      })
      content.choices.push(...choiceResponses);

      insertglmContent(context.group_id,
        singleton? '0':context.user_id,
        content.choices,
        data.data.request_id);

      return returnMessage;
    }

    console.log('[characterglm] unexpected response:', data);
    return 'ERROR3: 无回答';
  })
  .catch(e => `ERROR2: ${e.message}`);
};

export default async context => {
  const { match, config } = getMatchAndConfig(context.message);
  if (!match) return false;

  if (context.group_id) {
    const { blackGroup, whiteGroup } = config;
    if (blackGroup.has(context.group_id)) return true;
    if (whiteGroup.size && !whiteGroup.has(context.group_id)) return true;
  }

  if (!config.apiKey) {
    global.replyMsg(context, '未配置 APIKey', false, true);
    return true;
  }

  const prompt = match?.replace(/\[CQ:[^\]]+\]/g, '').trim();
  if (!prompt) return true;

  const { userDailyLimit } = global.config.bot.characterglm;
  if (userDailyLimit) {
    if (dailyCount.get(context.user_id) >= userDailyLimit) {
      global.replyMsg(context, '今天玩的够多啦，明天再来吧！', false, true);
      return true;
    } else dailyCount.add(context.user_id);
  }

  if (global.config.bot.debug) console.log('[characterglm] prompt:', prompt);

  const completion = await callCharacterAPI(prompt, config, context);

  global.replyMsg(context, completion, false, true);

  return true;
};