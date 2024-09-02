import { inspect } from 'util';
import { pick } from 'lodash-es';
import AxiosProxy from '../../utils/axiosProxy.mjs';
import { DailyCount } from '../../utils/dailyCount.mjs';
import emitter from '../../utils/emitter.mjs';
import { retryAsync } from '../../utils/retry.mjs';
import { getxingchenContent, insertxingchenContent, deletexingchenContent, createJWT } from './auth.mjs'

const dailyCount = new DailyCount();
let overrideGroups = [];


emitter.onConfigLoad(() => {
  overrideGroups = global.config.bot.tongyixingchen.overrides.map(({ blackGroup, whiteGroup }) => {
    const override = {};
    if (blackGroup) override.blackGroup = new Set(blackGroup);
    if (whiteGroup) override.whiteGroup = new Set(whiteGroup);
    return override;
  });
});

const getMatchAndConfig = text => {
  const globalConfig = global.config.bot.tongyixingchen;
  let match;

  if (text.includes(globalConfig.nickname)) { 
    if (text.startsWith(globalConfig.nickname)) {
      match = text.replace(globalConfig.nickname, '');
    } else {
      match = text;
    }
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
        'characterId',
      ]
    )
  };
};


const callXingchenAPI = (prompt, config, context) => {
  //群单例，群聊模式
  const singleton = true;
  const modelName = 'xingchen';



  return retryAsync(async () => {
    const { debug } = global.config.bot;

    const MaxSize = 20;

    if (prompt == "--r") {
      deletexingchenContent(context.group_id, singleton ? '0' : context.user_id, modelName);
      return '已清空上下文'
    }

    let content = getxingchenContent(context.group_id, singleton ? '0' : context.user_id, modelName)

    content.choices.push({ name: '老师', role: 'user', content: prompt });

    const param = {
      input: {
        messages: [
          ...(Array.isArray(config.prependMessages) ? config.prependMessages : []),
          ...content.choices,
        ],
        aca: {
          botProfile: {
            characterId: config.characterId
          },
          userProfile: {
            userId: context.group_id,
            userName: "老师",
            basicInfo: ""
          },
          context: {
            useChatHistory: false
          }
        }
      }
    };


    if (content.request_id) {
      param.request_id = content.request_id;
    }

    const headers = {
      "Content-Type": "application/json",
      "X-AcA-DataInspection": "enable",
      "x-fag-servicename": "aca-chat-send",
      "x-fag-appcode": "aca",
      "X-AcA-SSE": "disable",
      "Authorization": `Bearer ${config.apiKey}`
    };


    if (debug) console.log(`${modelName} params:`, inspect(param, { depth: null }));

    const { data } = await AxiosProxy.post("https://nlp.aliyuncs.com/v2/api/chat/send", param, {
      headers,
      validateStatus: status => 200 <= status && status < 500,
    });
    if (debug) console.log(`${modelName} response:`, inspect(data, { depth: null }));

    if (data.error) {
      const errorMsg = data.error.message;
      console.error(`${modelName} error:`, errorMsg);
      return `ERROR1: ${errorMsg}`;
    }
    let returnMessage = '';

    if (data.success) {

      const choiceResponses = data.data.choices[0]
      if (choiceResponses.stopReason.startsWith('stop')) {

        returnMessage = choiceResponses.messages[0].content;

        content.choices.push(pick(choiceResponses.messages[0], 'name', 'content', 'role'));

        // if (content.choices.length <= MaxSize) {
        //   content.choices.shift()
        // }

        insertxingchenContent(context.group_id,
          singleton ? '0' : context.user_id,
          content.choices,
          data.request_id,
          modelName);

        return returnMessage;
      }
    }

    console.log(`${modelName} unexpected response:`, data);
    return 'ERROR3: 无回答';
  })
    .catch(e => {
      `ERROR2: ${e.message}`;
      console.log(`${modelName} ERROR2:`, e);
    });
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

  const completion = await callXingchenAPI(prompt, config, context);

  global.replyMsg(context, completion, false, true);

  return true;
};