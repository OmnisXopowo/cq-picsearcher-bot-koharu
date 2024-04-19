import { inspect } from 'util';
import { pick } from 'lodash-es';
import AxiosProxy from '../../utils/axiosProxy.mjs';
import { DailyCount } from '../../utils/dailyCount.mjs';
import emitter from '../../utils/emitter.mjs';
import { retryAsync } from '../../utils/retry.mjs';
import { getglmContent, insertglmContent, deleteglmContent, createJWT } from './auth.mjs'
import { getImgs, hasImage } from '../../index.mjs'
import _ from 'lodash-es';
import CQ from '../../utils/CQcode.mjs';

const dailyCount = new DailyCount();
let overrideGroups = [];
//群单例，群聊模式
const singleton = true;



emitter.onConfigLoad(() => {
  overrideGroups = global.config.bot.glm4.overrides.map(({ blackGroup, whiteGroup }) => {
    const override = {};
    if (blackGroup) override.blackGroup = new Set(blackGroup);
    if (whiteGroup) override.whiteGroup = new Set(whiteGroup);
    return override;
  });
});

const getMatchAndConfig =  async context => {
  const globalConfig = global.config.bot.glm4;
  let match;
  let imgUrls;
  let originalContext;
  if (context.message.includes(globalConfig.nickname)) {
    match = context.message;
  } 
  if (context.message_type === 'group') {
    try {
      //判断是否是回复的消息
      const rMsgId = _.get(/^\[CQ:reply,id=(-?\d+).*\]/.exec(context.message), 1);
      if (rMsgId) {
        const { data } = await bot('get_msg', { message_id: Number(rMsgId) });
        if (data) {
          // 如果回复的是机器人的消息则忽略
          if (data.sender.user_id === context.self_id) {
            
          }
          const imgs = getImgs(data.message);
          const rMsg = imgs
            .map(({ file, url }) => `[CQ:image,file=${CQ.escape(file, true)},url=${CQ.escape(url, true)}]`)
            .join('');
          originalContext = { ...context, message: context.message.replace(/^\[CQ:reply,id=-?\d+.*?\]/, rMsg) };
        } else {
          // 获取不到原消息，忽略
        }
      }
    } catch (error) {
        console.log(error);
    }
  }
  

  if (originalContext && hasImage(originalContext.message)) {
    imgUrls = getImgs(originalContext.message);
  }else if(hasImage(context.message)){
    imgUrls = getImgs(context.message);
  }

  //如果从原消息或引用的原消息里获取到图片url，但未被nickname唤醒时，检测是否是@BOT消息，否则放弃消息
  if(imgUrls && !match && context.message.includes('CQ:at') && ( context.self_id== _.get(/\[CQ:at,qq=(-?\d+).*\]/.exec(context.message), 1)) ){
    match = context.message?.replace(/\[CQ:[^\]]+\]/g, '').trim();
    if (!match){
    match='仔细说你看到了什么';
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
        'systemRole',
      ]
    ),
    imgUrls
  };
};


const callGML4API = (prompt, config, context) => {
  const modelName = 'glm4';

  return retryAsync(async () => {
    const { debug } = global.config.bot;
    if (prompt == "--r") {
      deleteglmContent(context.group_id, singleton ? '0' : context.user_id, modelName);
      return '已清空上下文'
    }

    let content = getglmContent(context.group_id, singleton ? '0' : context.user_id, modelName);

    content.choices.push({ role: 'user', content: prompt });

    const param = {
      model: 'glm-4',
      messages: [
        ...(Array.isArray(config.prependMessages) ? config.prependMessages : []),
        ...content.choices,
      ],
    };


    if (content.request_id) {
      param.request_id = content.request_id;
    } else {
      param.messages.unshift({ role: 'system', content: '我是夏莱的老师。你是阿洛娜，是“什亭之匣”的系统管理者和操作系统，以少女的形象示人。你搭载了基沃托斯最先进的人工智能，具备庞大的知识库、接近人类的情感系统以及自主行动能力' });
    }

    const jwttoken = createJWT(config.apiKey);

    const headers = {
      Authorization: jwttoken,
      'Content-Type': 'application/json',
    };

    if (debug) console.log(`${modelName} params:`, inspect(param, { depth: null }));

    const { data } = await AxiosProxy.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', param, {
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

    if (data.choices) {
      const choiceResponses = data.choices.map(obj => {
        let FormatResult = obj.message.content.replace(/(\"*)(\\n*)/g, '').trim();
        returnMessage += FormatResult;
        return {
          ...obj.message,
          content: FormatResult
        };
      })
      content.choices.push(...choiceResponses);

      insertglmContent(context.group_id,
        singleton ? '0' : context.user_id,
        content.choices,
        data.request_id,
        modelName);

      return returnMessage;
    }

    console.log(`${modelName} unexpected response:`, data);
    return 'ERROR3: 无回答';
  })
    .catch(e => `ERROR2: ${e.message}`);
};

const callGML4VAPI = (prompt, config, context, imgUrls) => {
  const modelName = 'glm4v';

  return retryAsync(async () => {
    const { debug } = global.config.bot;
    if (prompt == "--r") {
      deleteglmContent(context.group_id, singleton ? '0' : context.user_id, modelName);
      return '已清空上下文'
    }

    let content = getglmContent(context.group_id, singleton ? '0' : context.user_id, modelName);

    content.choices.push({ role: 'user',  content: [
      {
        type: "text",
        text: prompt
      },
      {
        type: "image_url",
        image_url: {
            url : imgUrls[0].url
        }
      }
    ]});

    const param = {
      model: 'glm-4v',
      messages: [
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

    if (debug) console.log(`${modelName} params:`, inspect(param, { depth: null }));

    const { data } = await AxiosProxy.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', param, {
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

    if (data.choices) {
      const choiceResponses = data.choices.map(obj => {
        let FormatResult = obj.message.content.replace(/(\"*)(\\n*)/g, '').trim();
        returnMessage += FormatResult;
        return {
          ...obj.message,
          content: FormatResult
        };
      })
      content.choices.push(...choiceResponses);

      insertglmContent(context.group_id,
        singleton ? '0' : context.user_id,
        content.choices,
        data.request_id,
        modelName);

      return returnMessage;
    }

    console.log(`${modelName} unexpected response:`, data);
    return 'ERROR3: 无回答';
  })
    .catch(e => `ERROR2: ${e.message}`);
};


export default async context => {
  const { match, config,imgUrls } = await getMatchAndConfig(context);
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

  const { userDailyLimit } = global.config.bot.glm4;
  if (userDailyLimit) {
    if (dailyCount.get(context.user_id) >= userDailyLimit) {
      global.replyMsg(context, '今日额度已达上限', false, true);
      return true;
    } else dailyCount.add(context.user_id);
  }

  if (global.config.bot.debug) console.log('[glm] prompt:', prompt);

  let completion;
  if (imgUrls) {
    completion = await callGML4VAPI(prompt, config, context, imgUrls);
  } else {
    completion = await callGML4API(prompt, config, context);
  }
  global.replyMsg(context, completion, false, true);

  return true;
};