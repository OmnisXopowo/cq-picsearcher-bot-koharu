import { inspect } from 'util';
import _, { pick } from 'lodash-es';
import OpenAI from 'openai';
import { getImgs, hasImage } from '../../index.mjs';
import AxiosProxy from '../../utils/axiosProxy.mjs';
import Axios from '../../utils/axiosProxy.mjs';
import CQ from '../../utils/CQcode.mjs';
import dailyCountInstance from '../../utils/dailyCount.mjs';
import emitter from '../../utils/emitter.mjs';
import logError from '../../utils/logError.mjs';
import { setKeyValue, getKeyValue } from '../../utils/redisClient.mjs';
import { retryAsync } from '../../utils/retry.mjs';
import ocr from '../ocr/index.mjs';
import { getglmContent, insertglmContent, deleteglmContent, createJWT } from './auth.mjs';

let overrideGroups = [];
// 群单例，群聊模式
const singleton = true;


emitter.onConfigLoad(() => {
  overrideGroups = global.config.bot.glm4.overrides.map(({ blackGroup, whiteGroup }) => {
    const override = {};
    if (blackGroup) override.blackGroup = new Set(blackGroup);
    if (whiteGroup) override.whiteGroup = new Set(whiteGroup);
    return override;
  });
});

const getMatchAndConfig = async context => {
  const globalConfig = global.config.bot.glm4;
  let match;
  let imgUrls;
  let originalContext;
  if (context.message.includes(globalConfig.nickname)) {
    if (context.message.startsWith(globalConfig.nickname)) {
      match = context.message.replace(globalConfig.nickname, '');
    } else {
      match = context.message;
    }
  }


  if (context.message_type === 'group') {
    try {
      // 判断是否是回复的消息
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
  } else if (hasImage(context.message)) {
    imgUrls = getImgs(context.message);
  }

  // 如果从原消息或引用的原消息里获取到图片url，但未被nickname唤醒时，检测是否是@BOT消息，否则放弃消息
  if (imgUrls && !match && context.message.includes('CQ:at') && (context.self_id == _.get(/\[CQ:at,qq=(-?\d+).*\]/.exec(context.message), 1))) {

    // 盒检测
    if (hasImage(context.message)) {
      const awt = await doxingORC(context);
      if (awt) {
        return { match: false };
      }
    }


    match = context.message?.replace(/\[CQ:[^\]]+\]/g, '').trim();
    if (!match) {
      match = '仔细说你看到了什么';
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


const callKimiAPI = (prompt, config, context) => {
  const modelName = 'kimiai';

  const client = new OpenAI({
    apiKey: "sk-aIXe2E8FXCkFzmUkk9j0Q9hgY466Vctw2Y5qEarwelQdWL6L",
    baseURL: "https://api.moonshot.cn/v1",
  });


  return retryAsync(async () => {
    const { systemRole } = global.config.bot.glm4;

    if (prompt == "--r") {
      deleteglmContent(context.group_id, singleton ? '0' : context.user_id, modelName);
      return '已清空上下文';
    }

    const content = getglmContent(context.group_id, singleton ? '0' : context.user_id, modelName);

    content.choices.push({ role: 'user', content: prompt });

    const tools = [
      {
        "type": "builtin_function",
        "function": {
          "name": "$web_search",
        },
      }
    ];

    const messages = [
      ...(Array.isArray(config.prependMessages) ? config.prependMessages : []),
      ...content.choices,
    ];

    messages.unshift({ role: 'system', content: systemRole });
    let finishReason = null;
    let tool_result;
    let completion;
    while (finishReason === null || finishReason === "tool_calls") {
      completion = await client.chat.completions.create({
        model: "kimi-k2-0905-preview",
        messages,
        tools,  // <-- 我们通过 tools 参数，将定义好的 tools 提交给 Kimi 大模型
      });
      const choice = completion.choices[0];
      console.log(choice);
      finishReason = choice.finish_reason;
      console.log(finishReason);
      if (finishReason === "tool_calls") { // <-- 判断当前返回内容是否包含 tool_calls
        messages.push(choice.message); // <-- 我们将 Kimi 大模型返回给我们的 assistant 消息也添加到上下文中，以便于下次请求时 Kimi 大模型能理解我们的诉求
        for (const toolCall of choice.message.tool_calls) { // <-- tool_calls 可能是多个，因此我们使用循环逐个执行
          const tool_call_name = toolCall.function.name;
          const tool_call_arguments = JSON.parse(toolCall.function.arguments); // <-- arguments 是序列化后的 JSON Object，我们需要使用 JSON.parse 反序列化一下
          if (tool_call_name == "$web_search") {
            console.log('????');
            tool_result = tool_call_arguments;
          } else {
            tool_result = 'no tool found';
          }

          // 使用函数执行结果构造一个 role=tool 的 message，以此来向模型展示工具调用的结果；
          // 注意，我们需要在 message 中提供 tool_call_id 和 name 字段，以便 Kimi 大模型
          // 能正确匹配到对应的 tool_call。
          console.log("toolCall.id");
          console.log(toolCall.id);
          console.log("tool_call_name");
          console.log(tool_call_name);
          console.log("tool_result");
          console.log(tool_result);
          messages.push({
            "role": "tool",
            "tool_call_id": toolCall.id,
            "name": tool_call_name,
            "content": JSON.stringify(tool_result), // <-- 我们约定使用字符串格式向 Kimi 大模型提交工具调用结果，因此在这里使用 JSON.stringify 将执行结果序列化成字符串
          });
        }
      }
    }


    let returnMessage = '';

    if (completion.choices) {
      const choiceResponses = completion.choices.map(obj => {
        const FormatResult = obj.message.content.replace(/(\"*)(\\n*)/g, '').trim();
        returnMessage += FormatResult;
        return {
          ...obj.message,
          content: FormatResult
        };
      });
      content.choices.push(...choiceResponses);

      insertglmContent(context.group_id,
        singleton ? '0' : context.user_id,
        content.choices,
        completion.id,
        modelName);

      return returnMessage;
    }

    console.log(`${modelName} unexpected response:`, completion);
    return 'ERROR3: 无回答';
  })
    .catch(e => {
      `ERROR2: ${e.message}`;
      console.log(`${modelName} ERROR2:`, e);
    });
};


const callGML4API = (prompt, config, context) => {
  const modelName = 'glm4';

  return retryAsync(async () => {
    const { debug } = global.config.bot;
    if (prompt == "--r") {
      deleteglmContent(context.group_id, singleton ? '0' : context.user_id, modelName);
      return '已清空上下文';
    }

    const content = getglmContent(context.group_id, singleton ? '0' : context.user_id, modelName);

    content.choices.push({ role: 'user', content: prompt });

    const tools = [{
      type: "web_search",
      web_search: {
        enable: true // 默认为关闭状态（False） 禁用：False，启用：True。
      }
    }];



    const param = {
      model: 'glm-4-plus',
      messages: [
        ...(Array.isArray(config.prependMessages) ? config.prependMessages : []),
        ...content.choices,
      ],
      tools
    };


    if (content.request_id) {
      param.request_id = content.request_id;
    } else {
      param.messages.unshift({ role: 'system', content: '我是夏莱的老师。你是“什亭之匣”的系统管理者和操作系统，你的名字叫普拉娜,以少女的形象示人。你搭载了基沃托斯最先进的人工智能，具备庞大的知识库、接近人类的情感系统以及自主行动能力' });
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
        const FormatResult = obj.message.content.replace(/(\"*)(\\n*)/g, '').trim();
        returnMessage += FormatResult;
        return {
          ...obj.message,
          content: FormatResult
        };
      });
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
    .catch(e => {
      `ERROR2: ${e.message}`;
      console.log(`${modelName} ERROR2:`, e);
    });
};

const callGML4VAPI = (prompt, config, context, imgUrls) => {
  const modelName = 'glm4v';

  return retryAsync(async () => {
    const { debug } = global.config.bot;

    const content = { choices: [] };

    content.choices.push({
      role: "user", content: [
        {
          type: "text",
          text: prompt
        },
        {
          type: "image_url",
          image_url: {
            url: imgUrls[0].url
          }
        }
      ]
    });

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
      console.error(`${modelName} error1:`, errorMsg);
      console.error(`${modelName} error1:`, content);
      return `ERROR1: ${errorMsg}`;
    }
    let returnMessage = '';

    if (data.choices) {
      const choiceResponses = data.choices.map(obj => {
        //        let FormatResult = obj.message.content.replace(/(\"*)(\\n*)/g, '').trim();
        const FormatResult = obj.message.content.trim();
        returnMessage += FormatResult;
        return {
          ...obj.message,
          content: FormatResult
        };
      });
      content.choices.push(...choiceResponses);

      return returnMessage;
    }

    console.log(`${modelName} unexpected response:`, data);
    return 'ERROR3: 无回答';
  })
    .catch(e => {
      `ERROR2: ${e.message}`;
      console.log(`${modelName} ERROR2:`, e);
    });
};

const callQwenVLAPI = (prompt, config, context, imgUrls) => {
  const modelName = 'qwen-vl';

  return retryAsync(async () => {
    const { debug } = global.config.bot;

    const openai = new OpenAI({
      apiKey: "sk-9d41575ec88141598673d44e1793d760",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    });

    const messages = [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "你叫普拉娜，是一个QQ聊天机器人图像助手，不要使用Markdown格式。"
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: imgUrls[0].url
            }
          },
          {
            type: "text",
            text: prompt
          }
        ]
      }
    ];

    if (debug) console.log(`${modelName} params:`, inspect(messages, { depth: null }));

    const response = await openai.chat.completions.create({
      model: "qwen-vl-max-latest",
      messages
    });

    if (debug) console.log(`${modelName} response:`, inspect(response, { depth: null }));

    if (response.choices && response.choices.length > 0) {
      const content = response.choices[0].message.content;
      return content;
    }

    console.log(`${modelName} unexpected response:`, response);
    return 'ERROR3: 无回答';
  })
    .catch(e => {
      console.log(`${modelName} ERROR2:`, e);
      return `ERROR2: ${e.message}`;
    });
};


export default async context => {
  const { match, config, imgUrls } = await getMatchAndConfig(context);
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
    if (dailyCountInstance.get(context.user_id) >= userDailyLimit) {
      global.replyMsg(context, '今日额度已达上限', false, true);
      return true;
    } else dailyCountInstance.add(context.user_id);
  }

  if (global.config.bot.debug) console.log('[glm] prompt:', prompt);

  let completion;
  if (imgUrls) {
    // completion = await callGML4VAPI(prompt, config, context, imgUrls);
    completion = await callQwenVLAPI(prompt, config, context, imgUrls);
  } else {
    completion = await callKimiAPI(prompt, config, context);
  }
  global.replyMsg(context, completion, false, true);

  return true;
};

async function doxingORC(context) {
  const msg = context.message;
  const imgs = getImgs(msg);
  const start = process.hrtime(); // 记录开始时间

  const expiryInSeconds = 60 * 60 * 24 * 3;// 缓存三天过期
  const doxMsg = '卧槽！ 盒！！！';

  const his = await getKeyValue(imgs[0].file);
  if (his === '') {
    return false;
  } else if (his === 'true') {
    replyMsg(context, doxMsg);
    return true;
  }
  if (imgs[0].url.includes("LLOneBot")) {
    logError();
    return false;
  }
  let ret;
  try {
    ret = await Axios.get(imgs[0].url);
  } catch (error) {
    logError(error);
    return false;
  }
  
  if (ret.headers["content-type"] && ret.headers["content-type"] == 'image/gif') {
    setKeyValue(imgs[0].file, '', expiryInSeconds);
    return false;
  }
  console.log("IMGLength", ret.headers["content-type"] + "-" + ret.headers["content-length"]);

  let orcLog;
  try {
    const results = await ocr.default(imgs[0]);
    if (results.length) {
      const checkStr = results.map(str => str.replace(/\s+/g, '')).join('');
      if (doxingCheck(checkStr)) {
        setKeyValue(imgs[0].file, 'true', expiryInSeconds);
        replyMsg(context, doxMsg);
        return true;
      }
      orcLog = checkStr;
    }
    setKeyValue(imgs[0].file, '', expiryInSeconds);
    return false;
  } catch (e) {
    logError(e);
    console.log(ret);
    console.log(imgs[0]);
    return false;
  } finally {
    // 记录结束时间并计算延迟
    const end = process.hrtime(start);
    const delayInSeconds = (end[0] + end[1] / 1e9).toFixed(3); // 转换为秒并保留三位小数
    console.log(`[OCR 耗时${delayInSeconds}秒] ${imgs[0].file}:${orcLog ?? ''}`);
  }
}

// 卧槽盒！
function doxingCheck(checkStr) {
  const keywords = ["姓名", "性别", "出生", "公民", "身份", "天童爱丽丝", "机器人", "号码", "民族", "游戏开发部活动室", "爱丽丝", "基沃托斯市", "2021年3月25", "住址"];
  if (checkStr.includes("天童")) {
    let count = 0;
    if (checkStr.includes("11038120210325")) {
      count += 4;
    }
    // 遍历关键词数组，统计每个关键词的出现次数
    for (let index = 0; index < keywords.length; index++) {
      // 使用正则表达式全局匹配关键词，'g'标志表示全局搜索
      const regex = new RegExp(keywords[index], 'g');
      // 匹配文本中所有关键词出现的位置
      const matches = checkStr.match(regex);
      // 如果有匹配，计算出现次数，否则为0
      if (matches) {
        count++;
        if (count === 6) {
          return true;
        } else {
          if (index === 5 && count <= 3) {
            return false;
          }
        }
      }
    }
  }
  return false;
}