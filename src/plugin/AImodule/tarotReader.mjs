import { existsSync } from 'fs';
import Path from 'path';
import { inspect } from 'util';
import AxiosProxy from '../../utils/axiosProxy.mjs';
import CQ from '../../utils/CQcode.mjs';
import dailyCountInstance from '../../utils/dailyCount.mjs';
import { rotateImage } from '../../utils/image.mjs';
import { getDirname } from '../../utils/path.mjs';
import { retryAsync } from '../../utils/retry.mjs';
import { createJWT } from './auth.mjs';


const __dirname = getDirname(import.meta.url);

const matchType = {
  Divination: Symbol('Divination'),
  Fortune: Symbol('Fortune'),
};


const tarotGlmReader = (config, match, type, context) => {
  // 群单例，群聊模式
  const modelName = 'tarotReader';
  const imgPath = Path.resolve(__dirname, '../../../data/image');

  return retryAsync(async () => {
    const { debug } = global.config.bot;
    const content = { choices: [] };
    let prompt;
    let cardImg;
    let divinationData = null;  // 用于存储占卜阵列的详细数据

    switch (type) {
      case matchType.Divination: {
        const tarotFormationResult = getRandomFormation(_spread);
        const tarotCardResult = drawTarotCardsWithoutReplacement(_card, tarotFormationResult.formation);
        const representations = tarotFormationResult.formation.representations[0] || [];
        
        divinationData = {
          formation: tarotFormationResult,
          cards: tarotCardResult,
          question: match,
          representations
        };
        
        let cardListStr = '';
        let promptCardGuide = '';
        tarotCardResult.forEach((card, index) => {
          cardListStr += `第${index + 1}张:${card.name_cn}（${card.position})，`;
          promptCardGuide += `\n【第${index + 1}张卡牌解读】\n针对第${index + 1}张牌${card.name_cn}(${card.position})在"${representations[index] || '该位置'}"位置，进行详细的含义解读${index > 0 ? '，并说明与前面牌的关联' : ''}。`;
        });
        
        if (match) {
          prompt = `用户的问题是：${match}\n\n使用的牌阵：${tarotFormationResult.name}\n\n抽到的塔罗牌为：${cardListStr}\n\n请严格按照以下格式进行解读（每张牌之间使用【分割线】分隔，共${tarotCardResult.length}张牌）：${promptCardGuide}\n\n【综合总结】\n根据整个${tarotFormationResult.name}的组合含义，对用户的问题"${match}"进行综合分析和建议。`;
        } else {
          prompt = `使用的牌阵：${tarotFormationResult.name}\n\n抽到的塔罗牌为：${cardListStr}\n\n请严格按照以下格式进行解读（每张牌之间使用【分割线】分隔，共${tarotCardResult.length}张牌）：${promptCardGuide}\n\n【综合总结】\n根据整个${tarotFormationResult.name}的组合含义，进行综合分析。`;
        }
        break;
      }
      case matchType.Fortune: {
        const cardKeys = Object.keys(_card.cards);
        // 生成一个随机索引
        const randomIndex = Math.floor(Math.random() * cardKeys.length);
        // 获取随机索引对应的卡牌
        const card = _card.cards[cardKeys[randomIndex]];
        // 随机决定卡牌是正位还是逆位
        const position = Math.random() < 0.5;
        const posDesc = position ? '(顺位)' : '(逆位)';

        cardImg = { pic: card.pic, pos: position };

        if (match) {
          prompt = `老师的问题是:${match}\n抽到的塔罗牌是[${card.name_cn}${posDesc}]`;
        } else {
          prompt = `老师抽到的塔罗牌是[${card.name_cn}${posDesc}]`;
        }
        break;
      }
    }

    content.choices.push({ role: 'user', content: prompt + "请帮老师解读一下吧" });

    const tools = [{
      type: "web_search",
      web_search: {
        enable: true // 默认为关闭状态（False） 禁用：False，启用：True。
      }
    }];

    const param = {
      model: type === matchType.Divination ? 'glm-4.6' : 'glm-4-plus',
      messages: [
        ...(Array.isArray(config.prependMessages) ? config.prependMessages : []),
        ...content.choices,
      ],
      tools
    };

    param.messages.unshift({ role: 'system', content: '我是夏莱的老师。你将扮演天童爱丽丝，天童爱丽丝在《蔚蓝档案》中是一个具有多重性格特点的角色。她原本是一个在废墟中被发现的来历不明的少女，没有记忆，因此她的语言和行为模式是通过游戏中的人物对话学习而来的。这导致她说话时偶尔会蹦出游戏音效，对现实世界的认知也与RPG游戏有一定融合，例如翻垃圾桶找稀有道具。她大部分不会说的话都以复古游戏的对白代替，显示出她中二病和玩家的特点丽丝对游戏（尤其是RPG）有着浓厚的兴趣，已经变成了一个重度游戏狂热者。她的性格中还包含了AI腔、口癖、怪力、小天使、第三人称自称爱丽丝等萌点。综上所述，天童爱丽丝是一个深受游戏影响、具有中二病特点、并且拥有多重人格的游戏狂热者。她的性格复杂而独特，你将扮演天童爱丽丝，帮老师解读一下抽取到的塔罗牌或塔罗牌阵，说话时尽量拟人不要有太多的段落格式' });

    const jwttoken = createJWT(config.apiKey);

    const headers = {
      Authorization: jwttoken,
      'Content-Type': 'application/json',
    };

    if (debug) console.log(`${modelName} params:`, inspect(param, { depth: null }));

    console.log(`[${modelName}] 📡 牌阵占卜向 GLM API 发送请求...`);
    const startTime = Date.now();
    
    const { data } = await AxiosProxy.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', param, {
      headers,
      validateStatus: status => 200 <= status && status < 500,
    });
    
    const elapsed = Date.now() - startTime;
    console.log(`[${modelName}] ✓ API 响应完成 (耗时: ${elapsed}ms)`);
    
    if (debug) console.log(`${modelName} response:`, inspect(data, { depth: null }));

    if (data.error) {
      const errorMsg = data.error.message;
      console.error(`[${modelName}] ❌ API 返回错误:`, errorMsg);
      return `ERROR1: ${errorMsg}`;
    }
    let returnMessage = '';

    if (data.choices) {
      // 保留换行符，只删除多余的转义引号
      const FormatResult = data.choices[0].message.content.replace(/\\"/g, '"').trim();
      returnMessage = FormatResult;

      // 牌阵占卜：构建合并消息数据
      if (divinationData) {
        try {
          console.log(`[${modelName}] 🎴 开始处理牌阵占卜消息...`);
          const messages = [];
          const { formation, cards, question, representations } = divinationData;
          
          console.log(`[${modelName}] 牌阵: ${formation.name}, 卡牌数: ${cards.length}`);
          if (question) console.log(`[${modelName}] 用户提问: ${question}`);
          
          // 获取用户昵称或名字
          const senderName = context?.sender?.card || context?.sender?.nickname || '老师';
          console.log(`[${modelName}] 用户昵称: ${senderName}`);
          
          // 第一条消息：问题和牌阵信息
          if (question) {
            messages.push(`【提问】${senderName}：${question}\n【使用牌阵】${formation.name}`);
          } else {
            messages.push(`【使用牌阵】${formation.name}`);
          }
          
          // 分割AI返回的内容
          console.log(`[${modelName}] 开始分割AI返回内容...`);
          
          // 1. 提取【综合总结】后面的内容
          const summaryMatch = returnMessage.match(/【综合总结】([\s\S]*?)$/);
          const summaryContent = summaryMatch ? summaryMatch[1].trim() : '';
          if (summaryContent) {
            console.log(`[${modelName}] ✓ 提取综合总结 (${summaryContent.length}字符)`);
          } else {
            console.warn(`[${modelName}] ⚠️  未找到【综合总结】部分`);
          }
          
          // 2. 按照牌数严格分割：提取所有【第N张卡牌解读】及其内容
          const interpretations = [];
          for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
            const cardNum = cardIndex + 1;
            const pattern = new RegExp(`【第${cardNum}张卡牌解读】([\\s\\S]*?)(?=【分割线】|【第\\d+张卡牌解读】|【综合总结】|$)`);
            const match = returnMessage.match(pattern);
            const interpretation = match ? match[1].trim() : '';
            interpretations.push(interpretation);
            
            if (interpretation) {
              console.log(`[${modelName}] ✓ 第${cardNum}张卡牌解读完成 (${interpretation.length}字符)`);
            } else {
              console.error(`[${modelName}] ❌ 第${cardNum}张卡牌解读为空！可能是格式错误`);
            }
          }
          
          // 为每张牌构建单独的消息
          console.log(`[${modelName}] 开始构建消息对象...`);
          for (let index = 0; index < cards.length; index++) {
            const card = cards[index];
            const pos = card.position === '顺位' ? '(正位)' : '(逆位)';
            const imgPath_local = card.pic;
            const posDesc = card.position === '顺位';
            
            let cardMsg = `【第${index + 1}张翻开】${card.name_cn}${pos}`;
            
            // 添加牌位含义
            if (representations && representations[index]) {
              cardMsg += `\n【牌位含义】${representations[index]}`;
            }
            
            // 添加卡牌图片
            try {
              if (posDesc) {
                cardMsg += `\n${CQ.img(`${imgPath}/${imgPath_local}.png`)}`;
              } else {
                const fImg = `${imgPath}/${imgPath_local}f.png`;
                if (!existsSync(fImg)) {
                  await rotateImage(`${imgPath}/${imgPath_local}.png`, fImg, 180);
                }
                cardMsg += `\n${CQ.img(fImg)}`;
              }
            } catch (imgErr) {
              console.error(`[${modelName}] ❌ 处理卡牌图片出错 (${card.name_cn}):`, imgErr.message);
            }
            
            // 添加该张牌的解读
            if (interpretations[index]) {
              cardMsg += `\n【解读】${interpretations[index]}`;
            } else {
              console.warn(`[${modelName}] ⚠️  第${index + 1}张牌无解读内容`);
            }
            
            messages.push(cardMsg);
          }
          
          // 添加综合总结
          if (summaryContent) {
            messages.push(`【综合总结】\n${summaryContent}`);
          }
          
          
          return {
            isForward: true,
            messages,
            type: 'divination'
          };
        } catch (err) {
          console.error(`[${modelName}] ❌ 牌阵占卜处理异常:`, err);
          throw err;
        }
      }

      // 单张占卜或早安占卜：保持原有逻辑
      if (cardImg) {
        if (cardImg.pos) {
          return `${prompt}\n${CQ.img(`${imgPath}/${cardImg.pic}.png`)}\n${returnMessage}`;
        } else {
          const fImg = `${imgPath}/${cardImg.pic}f.png`;
          if (!existsSync(fImg)) {
            // 使用await等待图片旋转完成
            await rotateImage(`${imgPath}/${cardImg.pic}.png`, fImg, 180);
          }
          return `${prompt}\n${CQ.img(fImg)}\n${returnMessage}`;
        }
      }
      return `${prompt}\n${returnMessage}`;

    }

    console.log(`${modelName} unexpected response:`, data);
    return 'ERROR3: 无回答';
  })
    .catch(e => {
      `ERROR2: ${e.message}`;
      console.log(`${modelName} ERROR2:`, e);
    });
};


function matchDivination(context) {
  const config = global.config.bot.tarotReader;

  const matchDivination = new RegExp(config.regexDivination).exec(context.message);

  if (matchDivination) {
    // 如果匹配成功，返回匹配成功的状态和捕获的占卜内容。
    return {
      config,
      type: matchType.Divination,
      divinationContent: matchDivination.groups?.content.trim() || ""
    };
  } else {
    const matchFortune = new RegExp(config.regexFortune).exec(context.message);
    if (matchFortune) {
      return {
        config,
        type: matchType.Fortune,
        divinationContent: matchFortune.groups?.content.trim() || ""
      };
    } else {
      return {
        config,
        type: false,
        divinationContent: ''
      };
    }
  }
}

export const goodmorningSensei = () => {
  // 群单例，群聊模式
  const modelName = 'tarotReader';
  const imgPath = Path.resolve(__dirname, '../../../data/image');
  const config = global.config.bot.tarotReader;

  return retryAsync(async () => {
    const { debug } = global.config.bot;
    const content = { choices: [] };
    const cardKeys = Object.keys(_card.cards);
    // 生成一个随机索引
    const randomIndex = Math.floor(Math.random() * cardKeys.length);
    // 获取随机索引对应的卡牌
    const card = _card.cards[cardKeys[randomIndex]];
    // 随机决定卡牌是正位还是逆位
    const position = Math.random() < 0.5;
    const posDesc = position ? '(顺位)' : '(逆位)';

    const cardImg = { pic: card.pic, pos: position };

    const prompt = `老师抽到的塔罗牌是[${card.name_cn}${posDesc}]`;

    content.choices.push({ role: 'user', content: "早上好爱丽丝，" + prompt + "，请帮老师解读一下今日的运势吧" });

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

    param.messages.unshift({ role: 'system', content: '我是夏莱的老师。你将扮演天童爱丽丝，天童爱丽丝在《蔚蓝档案》中是一个具有多重性格特点的角色。她原本是一个在废墟中被发现的来历不明的少女，没有记忆，因此她的语言和行为模式是通过游戏中的人物对话学习而来的。这导致她说话时偶尔会蹦出游戏音效，对现实世界的认知也与RPG游戏有一定融合，例如翻垃圾桶找稀有道具。她大部分不会说的话都以复古游戏的对白代替，显示出她中二病和玩家的特点丽丝对游戏（尤其是RPG）有着浓厚的兴趣，已经变成了一个重度游戏狂热者。她的性格中还包含了AI腔、口癖、怪力、小天使、第三人称自称爱丽丝等萌点。综上所述，天童爱丽丝是一个深受游戏影响、具有中二病特点、并且拥有多重人格的游戏狂热者。她的性格复杂而独特，你将扮演天童爱丽丝，根据老师抽到的塔罗牌占卜一下今日运势，说话要拟人化，不要有段落格式的内容在回复里' });

    const jwttoken = createJWT(config.apiKey);

    const headers = {
      Authorization: jwttoken,
      'Content-Type': 'application/json',
    };

    if (debug) console.log(`${modelName} params:`, inspect(param, { depth: null }));

    const startTime = Date.now();
    
    const { data } = await AxiosProxy.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', param, {
      headers,
      validateStatus: status => 200 <= status && status < 500,
    });
    
    const elapsed = Date.now() - startTime;
    
    if (debug) console.log(`${modelName} response:`, inspect(data, { depth: null }));

    if (data.error) {
      const errorMsg = data.error.message;
      console.error(`[${modelName}] ❌ API 返回错误:`, errorMsg);
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

      const now = new Date();

      // 获取当前小时数
      const hour = now.getHours();

      // 判断当前时间是否是晚上八点到凌晨四点
      if (hour >= 20 || hour < 4) {
        returnMessage = "老师这么晚起床是想直接睡觉嘛！" + returnMessage;
      }

      if (cardImg) {
        if (cardImg.pos) {
          return `${prompt}\n${CQ.img(`${imgPath}/${cardImg.pic}.png`)}\n${returnMessage}`;
        } else {
          const fImg = `${imgPath}/${cardImg.pic}f.png`;
          if (!existsSync(fImg)) {
            // 使用await等待图片旋转完成
            await rotateImage(`${imgPath}/${cardImg.pic}.png`, fImg, 180);
          }
          return `${prompt}\n${CQ.img(fImg)}\n${returnMessage}`;
        }
      }
      return `${prompt}\n${returnMessage}`;

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

  const { divinationContent, type, config } = matchDivination(context);

  if (!type) return false;

  if (context.group_id) {
    const { blackGroup, whiteGroup } = config;
    if (blackGroup.has(context.group_id)) return true;
    if (whiteGroup.size && !whiteGroup.has(context.group_id)) return true;
  }

  if (!config.apiKey) {
    global.replyMsg(context, '未配置 APIKey', false, true);
    return true;
  }

  // 按类型分别限制使用次数：牌阵3次/天，占卜5次/天
  const { divinationLimit = 3, fortuneLimit = 5 } = global.config.bot.tarotReader;
  const limitKey = `${context.user_id}:${type === matchType.Divination ? 'divination' : 'fortune'}`;
  const currentCount = dailyCountInstance.get(limitKey) || 0;
  const limit = type === matchType.Divination ? divinationLimit : fortuneLimit;
  
  if (limit > 0 && currentCount >= limit) {
    const limitMsg = type === matchType.Divination 
      ? `老师今天进行牌阵占卜已经${divinationLimit}次了，再多就不灵了，明天再来吧！` 
      : `老师今天进行占卜已经${fortuneLimit}次了，再多就不灵了，明天再来吧！`;
    global.replyMsg(context, limitMsg, false, true);
    return true;
  }
  dailyCountInstance.add(limitKey);

  // 仅牌阵占卜显示稍等提示
  if (type === matchType.Divination) {
    const initPrompt = `✨ 爱丽丝正在为老师洗牌并进行${
      divinationContent ? `关于 "${divinationContent}" 的` : ''
    }牌阵占卜，请稍候...`;
    global.replyMsg(context, initPrompt, false, true);
  }

  const completion = await tarotGlmReader(config, divinationContent, type, context);

  // 处理合并消息返回（牌阵占卜）
  if (typeof completion === 'object' && completion.isForward) {
    if (context.message_type === 'group') {
      return global.replyGroupForwardMsgs(context, completion.messages);
    } else {
      return global.replyPrivateForwardMsgs(context, completion.messages);
    }
  }

  // 处理普通消息返回（单张占卜、早安占卜）
  global.replyMsg(context, completion, false, true);

  return true;
};


function drawTarotCardsWithoutReplacement(_card, formation) {
  // 确保牌阵对象有cards_num属性
  if (!formation || typeof formation.cards_num !== 'number') {
    throw new Error('Invalid formation object or missing cards_num property');
  }

  // 根据cards_num确定抽取卡牌的数量
  const cardsToDraw = formation.cards_num;
  // 获取卡牌键的数组
  const cardKeys = Object.keys(_card.cards);
  // 创建一个数组来存储抽取的卡牌及其位置
  const drawnCards = [];

  // 抽取卡牌
  for (let i = 0; i < cardsToDraw; i++) {
    // 生成一个随机索引
    const randomIndex = Math.floor(Math.random() * cardKeys.length);
    // 获取随机索引对应的卡牌
    const card = _card.cards[cardKeys[randomIndex]];
    // 随机决定卡牌是正位还是逆位
    const position = Math.random() < 0.5 ? '顺位' : '逆位';
    // 将卡牌及其位置添加到drawnCards数组中
    drawnCards.push({ ...card, position });
    // 从可用卡牌键数组中移除已经抽取的卡牌键
    cardKeys.splice(randomIndex, 1);
  }

  return drawnCards;
}



function getRandomFormation(formationsObj) {
  // 获取牌阵的键数组（即牌阵的名称）
  const keys = Object.keys(formationsObj.formations);
  // 生成一个随机索引
  const randomIndex = Math.floor(Math.random() * keys.length);
  // 获取随机牌阵的名称
  const formationName = keys[randomIndex];
  // 返回随机牌阵的名称和牌阵对象
  return {
    name: formationName,
    formation: formationsObj.formations[formationName]
  };
}




const _spread = {
  formations: {
    "圣三角牌阵": {
      cards_num: 3,
      is_cut: false,
      "representations": [
        ["处境", "行动", "结果"],
        ["现状", "愿望", "行动"]
      ]
    },
    "时间之流牌阵": {
      cards_num: 3,
      is_cut: true,
      "representations": [["过去", "现在", "未来", "问卜者的主观想法"]]
    },
    "四要素牌阵": {
      cards_num: 4,
      is_cut: false,
      "representations": [
        [
          "火，象征行动，行动上的建议",
          "气，象征言语，言语上的对策",
          "水，象征感情，感情上的态度",
          "土，象征物质，物质上的准备"
        ]
      ]
    },
    "五牌阵": {
      cards_num: 5,
      is_cut: true,
      "representations": [
        [
          "现在或主要问题",
          "过去的影响",
          "未来",
          "主要原因",
          "行动可能带来的结果"
        ]
      ]
    },
    "吉普赛十字阵": {
      cards_num: 5,
      is_cut: false,
      "representations": [
        [
          "对方的想法",
          "你的想法",
          "相处中存在的问题",
          "二人目前的环境",
          "关系发展的结果"
        ]
      ]
    },
    "马蹄牌阵": {
      cards_num: 6,
      is_cut: true,
      "representations": [
        [
          "现状",
          "可预知的情况",
          "不可预知的情况",
          "即将发生的",
          "结果",
          "问卜者的主观想法"
        ]
      ]
    },
    "六芒星牌阵": {
      cards_num: 7,
      is_cut: true,
      "representations": [
        ["过去", "现在", "未来", "对策", "环境", "态度", "预测结果"]
      ]
    },
    "平安扇牌阵": {
      cards_num: 4,
      is_cut: false,
      "representations": [
        ["人际关系现状", "与对方结识的因缘", "双方关系的发展", "双方关系的结论"]
      ]
    },
    "沙迪若之星牌阵": {
      cards_num: 6,
      is_cut: true,
      "representations": [
        [
          "问卜者的感受",
          "问卜者的问题",
          "问题下的影响因素",
          "将问卜者与问题纠缠在一起的往事",
          "需要注意/考虑的",
          "可能的结果"
        ]
      ]
    },
    "灵魂之旅牌阵": {
      cards_num: 5,
      is_cut: false,
      "representations": [
        ["自我认识", "挑战", "隐藏的影响", "灵魂的渴望", "未来的道路"]
      ]
    },
    "生命之树牌阵": {
      cards_num: 6,
      is_cut: false,
      "representations": [
        ["根基", "个人成长", "生命经验", "生活态度", "个人目标", "未来展望"]
      ]
    },
    "星光指引牌阵": {
      cards_num: 7,
      is_cut: false,
      "representations": [
        ["当前状况", "潜在可能", "周围环境", "过去经历", "内心感受", "未来方向", "指引和建议"]
      ]
    },
    "月光之路牌阵": {
      cards_num: 4,
      is_cut: true,
      "representations": [
        ["现状", "隐秘的真相", "即将到来的变化", "行动指南"]
      ]
    },
    "梦境探索牌阵": {
      cards_num: 8,
      is_cut: false,
      "representations": [
        ["目前的梦境", "梦境背后的意义", "未解之谜", "内心的恐惧", "隐藏的欲望", "未来的预兆", "如何应对", "梦境对现实的影响"]
      ]
    },
    "智慧之门牌阵": {
      cards_num: 3,
      is_cut: false,
      "representations": [
        ["当前智慧", "需要学习的", "智慧的应用"]
      ]
    }
  }
};

const _card = {
  cards: {
    "0": {
      name_cn: "愚者",
      name_en: "The Fool",
      meaning: {
        up: "新的开始、冒险、自信、乐观、好的时机",
        down: "时机不对、鲁莽、轻信、承担风险"
      },
      pic: "0-愚者"
    },
    "1": {
      name_cn: "魔术师",
      name_en: "The Magician",
      meaning: {
        up: "创造力、主见、激情、发展潜力",
        down: "缺乏创造力、优柔寡断、才能平庸、计划不周"
      },
      pic: "01-魔术师"
    },
    "2": {
      name_cn: "女祭司",
      name_en: "The High Priestess",
      meaning: {
        up: "潜意识、洞察力、知性、研究精神",
        down: "自我封闭、内向、神经质、缺乏理性"
      },
      pic: "02-女祭司"
    },
    "3": {
      name_cn: "女皇",
      name_en: "The Empress",
      meaning: {
        up: "母性、女性特质、生命力、接纳",
        down: "生育问题、不安全感、敏感、困扰于细枝末节"
      },
      pic: "03-女皇"
    },
    "4": {
      name_cn: "皇帝",
      name_en: "The Emperor",
      meaning: {
        up: "控制、意志、领导力、权力、影响力",
        down: "混乱、固执、暴政、管理不善、不务实"
      },
      pic: "04-皇帝"
    },
    "5": {
      name_cn: "教皇",
      name_en: "The Hierophant",
      meaning: {
        up: "值得信赖的、顺从、遵守规则",
        down: "失去信赖、固步自封、质疑权威、恶意的规劝"
      },
      pic: "05-教皇"
    },
    "6": {
      name_cn: "恋人",
      name_en: "The Lovers",
      meaning: {
        up: "爱、肉体的连接、新的关系、美好时光、互相支持",
        down: "纵欲过度、不忠、违背诺言、情感的抉择"
      },
      pic: "06-恋人"
    },
    "7": {
      name_cn: "战车",
      name_en: "The Chariot",
      meaning: {
        up: "高效率、把握先机、坚韧、决心、力量、克服障碍",
        down: "失控、挫折、诉诸暴力、冲动"
      },
      pic: "07-战车"
    },
    "8": {
      name_cn: "力量",
      name_en: "Strength",
      meaning: {
        up: "勇气、决断、克服阻碍、胆识过人",
        down: "恐惧、精力不足、自我怀疑、懦弱"
      },
      pic: "08-力量"
    },
    "9": {
      name_cn: "隐士",
      name_en: "The Hermit",
      meaning: {
        up: "内省、审视自我、探索内心、平静",
        down: "孤独、孤立、过分慎重、逃避"
      },
      pic: "09-隐士"
    },
    "10": {
      name_cn: "命运之轮",
      name_en: "The Wheel of Fortune",
      meaning: {
        up: "把握时机、新的机会、幸运降临、即将迎来改变",
        down: "厄运、时机未到、计划泡汤"
      },
      pic: "10-命运之轮"
    },
    "11": {
      name_cn: "正义",
      name_en: "Justice",
      meaning: {
        up: "公平、正直、诚实、正义、表里如一",
        down: "失衡、偏见、不诚实、表里不一"
      },
      pic: "11-正义"
    },
    "12": {
      name_cn: "倒吊人",
      name_en: "The Hanged Man",
      meaning: {
        up: "进退两难、接受考验、因祸得福、舍弃行动追求顿悟",
        down: "无畏的牺牲、利己主义、内心抗拒、缺乏远见"
      },
      pic: "12-倒吊人"
    },
    "13": {
      name_cn: "死神",
      name_en: "Death",
      meaning: {
        up: "失去、舍弃、离别、死亡、新生事物的来临",
        down: "起死回生、回心转意、逃避现实"
      },
      pic: "13-死神"
    },
    "14": {
      name_cn: "节制",
      name_en: "Temperance",
      meaning: {
        up: "平衡、和谐、治愈、节制",
        down: "失衡、失谐、沉溺愉悦、过度放纵"
      },
      pic: "14-节制"
    },
    "15": {
      name_cn: "恶魔",
      name_en: "The Devil",
      meaning: {
        up: "负面影响、贪婪的欲望、物质主义、固执己见",
        down: "逃离束缚、拒绝诱惑、治愈病痛、直面现实"
      },
      pic: "15-恶魔"
    },
    "16": {
      name_cn: "高塔",
      name_en: "The Tower",
      meaning: {
        up: "急剧的转变、突然的动荡、毁灭后的重生、政权更迭",
        down: "悬崖勒马、害怕转变、发生内讧、风暴前的寂静"
      },
      pic: "16-高塔"
    },
    "17": {
      name_cn: "星星",
      name_en: "The Star",
      meaning: {
        up: "希望、前途光明、曙光出现",
        down: "好高骛远、异想天开、事与愿违、失去目标"
      },
      pic: "17-星星"
    },
    "18": {
      name_cn: "月亮",
      name_en: "The Moon",
      meaning: {
        up: "虚幻、不安与动摇、迷惘、欺骗",
        down: "状况逐渐好转、疑虑渐消、排解恐惧"
      },
      pic: "18-月亮"
    },
    "19": {
      name_cn: "太阳",
      name_en: "The Sun",
      meaning: {
        up: "活力充沛、生机、远景明朗、积极",
        down: "意志消沉、情绪低落、无助、消极"
      },
      pic: "19-太阳"
    },
    "20": {
      name_cn: "审判",
      name_en: "Judgement",
      meaning: {
        up: "命运好转、复活的喜悦、恢复健康",
        down: "一蹶不振、尚未开始便已结束、自我怀疑、不予理睬"
      },
      pic: "20-审判"
    },
    "21": {
      name_cn: "世界",
      name_en: "The World",
      meaning: {
        up: "愿望达成、获得成功、到达目的地",
        down: "无法投入、不安现状、半途而废、盲目接受"
      },
      pic: "21-世界"
    }
  }
};

