import { CQWebSocket } from '@tsuk1ko/cq-websocket';
import Fs from 'fs-extra';
import _ from 'lodash-es';
import minimist from 'minimist';
import RandomSeed from 'random-seed';
import characterglm, { chatWindowManager, messageContextManager } from './plugin/AImodule/characterglm.mjs';
import glm4 from './plugin/AImodule/glm4.mjs';
import tarotReader, { goodmorningSensei } from './plugin/AImodule/tarotReader.mjs';
import ascii2d from './plugin/ascii2d.mjs';
import bilibiliHandler from './plugin/bilibili/index.mjs';
import broadcast from './plugin/broadcast.mjs';
import corpus from './plugin/corpus.mjs';
import cyberCourt from './plugin/cyberCourt/index.mjs';
import getGroupFile from './plugin/getGroupFile.mjs';
import IqDB from './plugin/iqdb.mjs';
import koharuApi, { checkRatingMsg, illustRating, getCommon, illustRemove, pushDoujinshi, formatTraceMessage, myXpDiagnosisReport, groupXpDiagnosisReport, getHelpCard } from './plugin/koharuApi.mjs';
import like from './plugin/like.mjs';
import ocr from './plugin/ocr/index.mjs';
import { rmdHandler } from './plugin/reminder.mjs';
import saucenao, { snDB } from './plugin/saucenao.mjs';
import sendSetu from './plugin/setu.mjs';
import vits from './plugin/vits.mjs';
import whatanime from './plugin/whatanime.mjs';
import { loadConfig } from './setup/config.mjs';
import { globalReg } from './setup/global.mjs';
import psycho from './setup/psycho.mjs';
import asyncMap from './utils/asyncMap.mjs';
import { botClientInfo } from './utils/botClientInfo.mjs';
import CQ from './utils/CQcode.mjs';
import dailyCountInstance from './utils/dailyCount.mjs';
import emitter from './utils/emitter.mjs';
import { IS_DOCKER } from './utils/env.mjs';
import {MsgImage  } from './utils/image.mjs';
import logError from './utils/logError.mjs';
import logger from './utils/logger.mjs';
import { getRawMessage } from './utils/message.mjs';
import { resolveByDirname } from './utils/path.mjs';
import psCache from './utils/psCache.mjs';
import { setKeyValue, getKeyValue, getKeyObject, setKeyObject, getKeys, buildRedisKeyPattern, redis } from './utils/redisClient.mjs';
import { getRegWithCache } from './utils/regCache.mjs';
import searchingMap from './utils/searchingMap.mjs';


const { version } = Fs.readJsonSync(resolveByDirname(import.meta.url, '../package.json'));

const bot = new CQWebSocket({
  ...global.config.cqws,
  forcePostFormat: 'string',
});
const rand = RandomSeed.create();

// 全局变量
globalReg({
  bot,
  botClientInfo: {
    name: '',
    version: '',
  },
  botReady: async () => {
    if (bot.isReady()) return;
    return new Promise(resolve => {
      bot.once('ready', resolve);
    });
  },
  replyMsg,
  sendMsg2Admin,
  parseArgs,
  replySearchMsgs,
  replyGroupForwardMsgs,
  replyPrivateForwardMsgs,
  sendGroupMsg,
  setKeyValue,
  getKeyValue,
  setKeyObject,
  getKeyObject
});

emitter.emit('botCreated');

// 好友请求
bot.on('request.friend', context => {
  let approve = global.config.bot.autoAddFriend;
  const answers = global.config.bot.addFriendAnswers;
  if (approve && answers.length > 0) {
    const comments = context.comment.split('\n');
    try {
      answers.forEach((ans, i) => {
        const a = /(?<=回答:).*/.exec(comments[i * 2 + 1])[0];
        if (ans !== a) approve = false;
      });
    } catch (e) {
      console.error('加好友请求');
      logError(e);
      approve = false;
    }
  }
  if (approve)
    bot('set_friend_add_request', {
      flag: context.flag,
      sub_type: 'invite',
      approve: true,
    });
});

// 加群请求
const groupAddRequests = {};
bot.on('request.group.invite', context => {
  if (global.config.bot.autoAddGroup)
    bot('set_group_add_request', {
      flag: context.flag,
      approve: true,
    });
  else groupAddRequests[context.group_id] = context.flag;
});

// 设置监听器
function setBotEventListener() {
  ['message.private', 'message.group', 'message.group.@.me', 'message.guild', 'message.guild.@.me'].forEach(name =>
    bot.off(name),
  );
  if (global.config.bot.enablePM) {
    // 私聊
    bot.on('message.private', privateAndAtMsg);
  }
  if (global.config.bot.enableGM) {
    // 群组@
    bot.on('message.group.@.me', privateAndAtMsg);
    // 群组
    bot.on('message.group', groupMsg);
  }
  if (global.config.bot.enableGuild) {
    // 频道@
    bot.on('message.guild.@.me', (e, ctx) => {
      compatibleWithGuild(ctx);
      privateAndAtMsg(e, ctx);
    });
    // 频道
    bot.on('message.guild', (e, ctx) => {
      compatibleWithGuild(ctx);
      groupMsg(e, ctx);
    });
  }
}
setBotEventListener();
emitter.onConfigReload(setBotEventListener);

function compatibleWithGuild(ctx) {
  ctx.group_id = `${ctx.guild_id}_${ctx.channel_id}`;
}

// 连接相关监听
bot
  .on('socket.connecting', (wsType, attempts) => console.log(`连接中[${wsType}]#${attempts}`))
  .on('socket.failed', (wsType, attempts) => console.log(`连接失败[${wsType}]#${attempts}`))
  .on('socket.error', (wsType, err) => {
    console.error(`连接错误[${wsType}]`);
    console.error(err);
  })
  .on('socket.connect', (wsType, sock, attempts) => {
    console.log(`连接成功[${wsType}]#${attempts}`);
    if (wsType === '/api') {
      bot('get_version_info')
        .then(({ retcode, data, message }) => {
          if (retcode !== 0 || !data) {
            console.error('获取客户端信息失败', message);
            return;
          }

          console.log('客户端', data.app_name, data.app_version);
          console.log('协议版本', data.protocol_version);

          botClientInfo.setInfo({
            name: data.app_name || '',
            version: data.app_version || '',
          });
        })
        .catch(console.error);
      sendMsg2Admin(`已上线#${attempts}`);
    }
  });

// connect
bot.connect();

// 初始化聊天窗口管理器的发送消息回调
chatWindowManager.setSendGroupMsgCallback((groupId, message) => {
  if (bot.isReady()) {
    bot('send_group_msg', { group_id: groupId, message });
  }
});


/**
 * 处理回复给机器人的消息
 * @type {import('cq-websocket').MessageEventListener}
 */
async function replyToBotHandle(context, rMsgData) {

  // 去除消息中的CQ码，只保留纯文本内容
  const pureText = context.message.replace(/\[CQ:[^\]]+\]/g, '').trim();

  const illustObj = await checkRatingMsg(rMsgData, context.self_id);
  if (illustObj) {
    // 处理 /trace 命令 - 查看搜索追踪信息（支持所有类型包括 no_result）
    if (pureText === '/trace' && global.config.bot.KoharuAPI) {
      if (illustObj.trace) {
        const traceMsg = formatTraceMessage(illustObj.trace);
        global.replyMsg(context, traceMsg, false, true);
      } else {
        global.replyMsg(context, '未返回具体跟踪信息', false, true);
      }
      return;
    }
    
    // 无结果消息不支持评分和删除
    if (illustObj.type === 'no_result') {
      return;
    }
    
    if (context.message.includes('/我丢') && isSendByAdmin(context)) {
      illustRemove(illustObj);
    } else {
      const regex = /(\d+(?:\.\d{1,2})?)分/;
      const match = pureText.match(regex);
      if (match) {
        const score = parseFloat(match[1], 10);
        if (score >= 0 && score <= 5) {
          illustRating(illustObj, context, score);
        } else {
          global.replyMsg(context, "老师，打分范围是0~5分，最多两位小数哦", false, true);
        }
      } else {
        console.log(context.message + ':没有找到分数');
      }
    }
  } else {
    // 检查是否是画廊选择消息
    const { checkGallerySelectMsg } = await import('./plugin/koharuApi.mjs');
    const gallerySelectData = await checkGallerySelectMsg(rMsgData, context.self_id);
    if (gallerySelectData) {
      // 处理画廊选择
      const regex = /^(\d+)$/;
      const match = pureText.match(regex);
      if (match) {
        const choice = parseInt(match[1], 10);
        const galleries = gallerySelectData.galleries;
        
        // 检查选择是否有效
        if (choice >= 1 && choice <= galleries.length) {
          const selectedGallery = galleries[choice - 1];
          const shouldSendCover = gallerySelectData.shouldSendCover || false;
          
          // 导入并调用处理函数
          const { handleEhentaiSelect } = await import('./plugin/koharuApi.mjs');
          await handleEhentaiSelect(selectedGallery.link, context, shouldSendCover);
        } else {
          global.replyMsg(context, `选择无效，请输入 1-${galleries.length} 之间的数字`, false, true);
        }
      }
    }
  }
}

/**
 * AI功能处理
 * @type {import('cq-websocket').MessageEventListener}
 */
async function commonAiHandle(e, context) {

  // 早安
  if (context.message.startsWith('/早安爱丽丝')) {
    const completion = await goodmorningSensei();
    global.replyMsg(context, completion, false, true);
    return true;
  }

  // characterglm
  if (global.config.bot.characterglm.enable) {
    if (await characterglm(context)) return true;
  }
  // glm4
  if (global.config.bot.glm4.enable) {
    if (await glm4(context)) return true;
  }

  // 头衔
  // if (global.config.bot.tongyixingchen.enable) {
  //   if (await tongyixingchen(context)) return true;
  // }

  // 塔罗占卜
  if (global.config.bot.tarotReader.enable) {
    if (await tarotReader(context)) return true;
  }


  // 🦾🤖赛博斯坦内鬼
  if (context.message.includes('💪🏻😃')) {
    replyMsg(context, context.message.replace('💪🏻😃', '🦾🤖'));
    return true;
  }
  // 发癫
  if (context.message.startsWith('/发癫 ')) {
    const sentence = psycho[Math.floor(Math.random() * psycho.length)];
    const name = context.message.replace('/发癫 ', '');
    replyMsg(context, sentence.replaceAll('<name>', name || '爱丽丝'));
    return true;
  }
}


/**
 * 通用处理
 * @type {import('cq-websocket').MessageEventListener}
 */
async function commonHandle(e, context) {
  const config = global.config.bot;

  // 白名单
  if (config.whiteGroup.size && context.group_id && !config.whiteGroup.has(context.group_id)) return true;

  // 忽略自己发给自己的消息
  if (context.user_id === context.self_id || context.user_id === context.self_tiny_id) return true;

  // 管理员指令
  if (handleAdminMsg(context)) return true;

  // 黑名单检测
  if (logger.checkBan(context)) return true;

  // 语言库
  if (corpus(context)) return true;

  // 赛博升堂（投票禁言）
  if (global.config.bot.cyberCourt?.enable) {
    if (await cyberCourt(context)) return true;
  }

  // 忽略指定正则的发言
  if (config.regs.ignore && getRegWithCache(config.regs, 'ignore').test(context.message)) return true;

  // 处理ehentai选择结果
  if (/^\d+$/.test(context.message)) {
    try {
      // 检查是否是ehentai选择回复，通过最近的推本消息查找
      if (!redis) return false;
      const keyPattern = buildRedisKeyPattern('tbSelect', context.self_id, context.group_id);
      const recentMsgIds = await getKeys(keyPattern);
      if (recentMsgIds.length > 0) {
        // 按时间排序，获取最新的消息
        const sortedKeys = recentMsgIds.sort((a, b) => {
          const aId = parseInt(a.split(':').pop());
          const bId = parseInt(b.split(':').pop());
          return bId - aId;
        });
        
        // 获取最新的一条推本选择消息
        const cacheKey = sortedKeys[0];
        const cacheData = await getKeyObject(cacheKey);
        if (cacheData) {
          const choice = parseInt(context.message, 10);
          const galleries = cacheData.galleries;
          
          // 检查选择是否有效
          if (choice >= 1 && choice <= galleries.length) {
            const selectedGallery = galleries[choice - 1];
            const shouldSendCover = cacheData.shouldSendCover || false;
            
            // 导入并调用处理函数
            const { handleEhentaiSelect } = await import('./plugin/koharuApi.mjs');
            await handleEhentaiSelect(selectedGallery.link, context, shouldSendCover);
            
            // 删除已使用的缓存
            // await redis.del(cacheKey);
            return true;
          } else {
            global.replyMsg(context, `选择无效，请输入 1-${galleries.length} 之间的数字`, false, true);
            return true;
          }
        }
      }
    } catch (error) {
      console.error('处理ehentai选择时出错:', error);
    }
  }

  // 通用指令
  if (context.message === '--help') {
    replyMsg(context, 'https://yww.uy/drpg3s');
    return true;
  }
  if (context.message === '--version') {
    replyMsg(context, version);
    return true;
  }
  if (context.message === '--about') {
    replyMsg(context, 'https://github.com/Tsuk1ko/cq-picsearcher-bot');
    return true;
  }

  // 收藏入书库
  if (config.KoharuAPI && (context.message.replace(/^\[CQ:reply,id=-?\d+.*?\]/, '').startsWith("/收藏") || context.message.replace(/^\[CQ:reply,id=-?\d+.*?\]/, '').startsWith("/post"))) {
    if (await koharuApi(context)) return true;
  }

  // 处理/推本或/tb命令
  if (config.KoharuAPI && (context.message.startsWith('/推本') || context.message.startsWith('/tb'))) {
    if (await pushDoujinshi(context)) return true;
  }


  // 来点
  if (config.KoharuAPI && context.message.startsWith("/来点")) {
    if (await getCommon(context)) return true;
  }

  // XP 诊断报告（个人 / 群组）
  if (config.KoharuAPI && context.message.startsWith('/我的xp')) {
    if (await myXpDiagnosisReport(context)) return true;
  }
  if (config.KoharuAPI && context.message.startsWith('/群友xp')) {
    if (await groupXpDiagnosisReport(context)) return true;
  }


  // 处理完所有模型回复后判断AImode，结束所有功能
  if (global.config.bot.AImode) {
    commonAiHandle(e, context);
    return true;
  }
  // 继续非AI相关功能

  // vits
  if (global.config.bot.vits.enable) {
    if (await vits(context)) return true;
  }

  // 点赞
  if (global.config.bot.like.enable) {
    if (await like(context)) return true;
  }

  // reminder
  if (config.reminder.enable) {
    if (rmdHandler(context)) return true;
  }

  // setu
  if (config.setu.enable) {
    if (sendSetu(context)) return true;
  }

  // 反哔哩哔哩小程序 
  if (context.user_id != 3766461635 && await bilibiliHandler(context)) return true;

  return false;
}

// 管理员消息
function handleAdminMsg(context) {
  if (!isSendByAdmin(context)) return false;

  const args = parseArgs(context.message);

  // 允许加群
  const group = args['add-group'];
  if (group && typeof group === 'number') {
    if (typeof groupAddRequests[context.group_id] === 'undefined') {
      replyMsg(context, `将会同意进入群${group}的群邀请`);
      // 注册一次性监听器
      bot.once('request.group.invite', context2 => {
        if (context2.group_id === group) {
          bot('set_group_add_request', {
            flag: context2.flag,
            type: 'invite',
            approve: true,
          });
          replyMsg(context, `已进入群${context2.group_id}`);
          return true;
        }
        return false;
      });
    } else {
      bot('set_group_add_request', {
        flag: groupAddRequests[context.group_id],
        type: 'invite',
        approve: true,
      });
      replyMsg(context, `已进入群${context.group_id}`);
      delete groupAddRequests[context.group_id];
    }
    return true;
  }

  if (args.broadcast) {
    broadcast(parseArgs(context.message, false, 'broadcast'));
    return true;
  }

  // Ban
  const { 'ban-u': bu, 'ban-g': bg } = args;

  if (bu) {
    if (typeof bu === 'number') {
      logger.ban('u', bu);
      replyMsg(context, `已封禁用户${bu}`);
    } else if (typeof bu === 'string' && /^_\d+$/.test(bu)) {
      const uid = bu.replace(/^_/, '');
      logger.ban('u', uid);
      replyMsg(context, `已封禁频道用户${uid}`);
    }
    return true;
  }
  if (bg) {
    if (typeof bg === 'number') {
      logger.ban('g', bg);
      replyMsg(context, `已封禁群组${bg}`);
    } else if (typeof bg === 'string' && /^\d+_\d*$/.test(bg)) {
      const gid = bg.replace(/_$/, '');
      logger.ban(bg.endsWith('_') ? 'guild' : 'g', gid);
      replyMsg(context, `已封禁频道${gid}`);
    }
    return true;
  }



  // 停止程序（使用 pm2 时相当于重启）
  if (args.shutdown) process.exit();

  // 重载配置
  if (args.reload) {
    try {
      dailyCountInstance.loadMap();
      loadConfig();
      replyMsg(context, '配置已重载');
    } catch (error) {
      console.error(error);
      replyMsg(context, String(error));
    }
    return true;
  }

  if (args.save) {
    dailyCountInstance.saveAndResetTimer();
    replyMsg(context, '配置已保存');

  }

  return false;
}

/**
 * 私聊以及群组@的处理
 * @type {import('cq-websocket').MessageEventListener}
 */
async function privateAndAtMsg(e, context) {
  if (global.config.bot.debug) {
    if (!isSendByAdmin(context)) {
      e.stopPropagation();
      replyMsg(context, global.config.bot.replys.debug, true);
      return;
    }
    switch (context.message_type) {
      case 'private':
        console.log(`收到私聊消息 qq=${context.user_id}`);
        break;
      case 'group':
        console.log(`收到群组@消息 group=${context.group_id} qq=${context.user_id}`);
        break;
      case 'guild':
        console.log(`收到频道@消息 guild=${context.guild_id} channel=${context.channel_id} tinyId=${context.user_id}`);
        break;
    }
    console.log(debugMsgDeleteBase64Content(context.message));
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
            replyToBotHandle(context, data);
            e.stopPropagation();
            return;
          }
        } else {
          // 获取不到原消息，忽略
        }
      }
    } catch (error) {
      if (global.config.bot.debug) {
        console.log(error);
      }
    }
  }

  if (await commonHandle(e, context)) {
    e.stopPropagation();
    return;
  }

  // if(await titleSet(e,context)){
  //   e.stopPropagation();
  //   return;
  // }

  if (context.message_type === 'group') {
    try {
      // 判断是否是回复的消息
      const rMsgId = _.get(/^\[CQ:reply,id=(-?\d+).*\]/.exec(context.message), 1);
      if (rMsgId) {
        const { data } = await bot('get_msg', { message_id: Number(rMsgId) });
        if (data) {
          // 如果回复的是机器人的消息则忽略
          if (data.sender.user_id === context.self_id) {
            replyToBotHandle(context, data);
            e.stopPropagation();
            return;
          }
          const imgs = getImgs(getRawMessage(data));
          const rMsg = imgs.map(img => img.toCQ()).join('');
          context = { ...context, message: context.message.replace(/^\[CQ:reply,id=-?\d+.*?\]/, rMsg) };
        } else {
          // 获取不到原消息，忽略
          e.stopPropagation();
          return;
        }
      }
    } catch (error) {
      if (global.config.bot.debug) {
        console.log(error);
      }
    }
  }

  // 转换原图
  if (handleOriginImgConvert(context)) {
    e.stopPropagation();
    return;
  }



  if (hasImage(context.message)) {
    // 搜图
    e.stopPropagation();
    searchImg(context);
  } else if (context.message.search('--') !== -1) {
    // 忽略
  } else if (context.message_type === 'private') {
    const dbKey = context.message;
    const db = snDB[dbKey];
    if (db) {
      logger.smSwitch(0, context.user_id, true);
      logger.smSetDB(0, context.user_id, db);
      replyMsg(context, `已临时切换至【${dbKey}】搜图模式√`, true);
    } else if (global.config.bot.KoharuAPI) {
      await getHelpCard(context);
    } else {
      replyMsg(context, global.config.bot.replys.default, true);
    }
  } else if (global.config.bot.KoharuAPI) {
    await getHelpCard(context);
  } else {
    replyMsg(context, global.config.bot.replys.default, true);
  }
}

/**
 * 群组消息处理
 * @type {import('cq-websocket').MessageEventListener}
 */
async function groupMsg(e, context) {
  if (global.config.bot.debug) {
    if (!isSendByAdmin(context)) {
      e.stopPropagation();
      return;
    }
    switch (context.message_type) {
      case 'group':
        console.log(`收到群组消息 group=${context.group_id} qq=${context.user_id}`);
        break;
      case 'guild':
        console.log(`收到频道消息 guild=${context.guild_id} channel=${context.channel_id} tinyId=${context.user_id}`);
        break;
    }
    console.log(debugMsgDeleteBase64Content(context.message));
  }

  // 聊天窗口激活时，记录所有群消息到上下文
  if (chatWindowManager.isActive(context.group_id)) {
    const nickname = context.sender?.nickname || context.sender?.card || `用户${context.user_id}`;
    messageContextManager.addMessage(
      context.group_id,
      context.message,
      context.user_id,
      nickname
    );
  }

  if ((await commonHandle(e, context)) || (await getGroupFile(context))) {
    e.stopPropagation();
    return;
  }

  // 进入或退出搜图模式
  const { group_id, user_id } = context;

  if (getRegWithCache(global.config.bot.regs, 'searchModeOn').test(context.message)) {
    // 进入搜图
    e.stopPropagation();
    if (
      logger.smSwitch(group_id, user_id, true, () => {
        replyMsg(context, global.config.bot.replys.searchModeTimeout, true);
      })
    ) {
      replyMsg(context, global.config.bot.replys.searchModeOn, true);
    } else replyMsg(context, global.config.bot.replys.searchModeAlreadyOn, true);
  } else if (getRegWithCache(global.config.bot.regs, 'searchModeOff').test(context.message)) {
    e.stopPropagation();
    // 退出搜图
    if (logger.smSwitch(group_id, user_id, false)) replyMsg(context, global.config.bot.replys.searchModeOff, true);
    else replyMsg(context, global.config.bot.replys.searchModeAlreadyOff, true);
  }

  // 搜图模式检测
  let smStatus = logger.smStatus(group_id, user_id);
  if (smStatus) {
    // 获取搜图模式下的搜图参数
    const getDB = () => {
      const cmd = /^(all|pixiv|danbooru|doujin|book|anime|原图)$/.exec(context.message);
      if (cmd) return snDB[cmd[1]] || -1;
      return -1;
    };

    // 切换搜图模式
    const cmdDB = getDB();
    if (cmdDB !== -1) {
      logger.smSetDB(group_id, user_id, cmdDB);
      smStatus = cmdDB;
      replyMsg(context, `已切换至【${context.message}】搜图模式√`);
    }

    // 有图片则搜图
    if (hasImage(context.message)) {
      e.stopPropagation();
      // 刷新搜图TimeOut
      logger.smSwitch(group_id, user_id, true, () => {
        replyMsg(context, global.config.bot.replys.searchModeTimeout, true);
      });
      logger.smCount(group_id, user_id);
      searchImg(context, smStatus);
    }
  } else if (global.config.bot.repeat.enable) {
    // 复读（
    // 随机复读，rptLog得到当前复读次数
    if (
      logger.rptLog(group_id, user_id, context.message) >= global.config.bot.repeat.times &&
      getRand() <= global.config.bot.repeat.probability
    ) {
      logger.rptDone(group_id);
      // 延迟2s后复读
      setTimeout(() => {
        replyMsg(context, context.message);
      }, 2000);
    } else if (getRand() <= global.config.bot.repeat.commonProb) {
      // 平时发言下的随机复读
      setTimeout(() => {
        replyMsg(context, context.message);
      }, 2000);
    }
  }

  if (global.config.bot.shike.enable && global.config.bot.shike.keywords.length > 0) {

    if (getRand() <= global.config.bot.shike.probability && !context.message.includes('[CQ:')) {
      let MsgReply = '';

      global.config.bot.shike.keywords.forEach(key => {
        if (context.message.includes(key)) {
          MsgReply += `${key}？？`;
        }
      });

      if (MsgReply.length > 1) {

        setTimeout(() => {
          replyMsg(context, `${MsgReply} 死刑！！`, false, true);
        }, 2000);
      }
    }
  }
}

/**
 * 搜图
 *
 * @param {*} context
 * @param {number} [customDB=-1]
 * @returns
 */
async function searchImg(context, customDB = -1) {
  const args = parseArgs(context.message);
  const hasWord = word => context.message.includes(word);

  // OCR
  if (args.ocr) {
    doOCR(context);
    return;
  }

  // 决定搜索库
  let db = snDB[global.config.bot.saucenaoDefaultDB] || snDB.all;
  if (customDB < 0) {
    if (args.all) db = snDB.all;
    else if (args.pixiv) db = snDB.pixiv;
    else if (args.danbooru) db = snDB.danbooru;
    else if (args.doujin || args.book) db = snDB.doujin;
    else if (args.anime) db = snDB.anime;
    else if (args.a2d) db = -10001;
    else if (context.message_type === 'private') {
      // 私聊搜图模式
      const sdb = logger.smStatus(0, context.user_id);
      if (sdb) {
        db = sdb;
        logger.smSwitch(0, context.user_id, false);
      }
    }
  } else db = customDB;

  if (db === snDB.原图) {
    originImgConvert(context);
    return;
  }

  // 得到图片链接并搜图
  const msg = context.message;
  const imgs = getImgs(msg);

  if (!imgs.length) return;

  // 获取图片链接
  if (/(^|\s|\])链接($|\s|\[)/.test(context.message) || args['get-url']) {
    const validImgs = imgs.filter(img => img.isUrlValid);
    if (validImgs.length !== imgs.length) {
      replyMsg(context, '部分图片无法获取有效链接，请尝试使用其他设备QQ发送', false, true);
    }
    replyMsg(context, _.map(validImgs, 'url').join('\n'));
    return;
  }

  if (global.config.bot.searchFeedback) {
    replyMsg(context, global.config.bot.replys.searchFeedback, false, true);
  }

  for (const img of imgs) {
    // 获取缓存
    if (psCache.enable && !args.purge) {
      const cache = psCache.get(img, db);
      if (cache) {
        const msgs = cache.map(msg => `${CQ.escape(' ')} ${msg}`);
        const antiShieldingMode = global.config.bot.antiShielding;
        const cqImg = antiShieldingMode > 0 ? await img.getAntiShieldedCqImg64(antiShieldingMode) : img.toCQ();
        await replySearchMsgs(context, msgs, [cqImg]);
        continue;
      }
    }

    // 检查搜图次数
    if (!isSendByAdmin(context) && !logger.applyQuota(context.user_id, { value: global.config.bot.searchLimit })) {
      replyMsg(context, global.config.bot.replys.personLimit, false, true);
      return;
    }

    // 检查图片比例
    if (
      global.config.bot.stopSearchingHWRatioGt > 0 &&
      !(await img.checkImageHWRatio(global.config.bot.stopSearchingHWRatioGt))
    ) {
      replyMsg(context, global.config.bot.replys.stopSearchingByHWRatio, false, true);
      return;
    }

    // 可能有其他人在搜同一张图
    switch (searchingMap.put(img, db, context)) {
      case searchingMap.IS_SEARCHING:
        if (imgs.length === 1) replyMsg(context, global.config.bot.replys.searching, false, true);
        continue;
      case searchingMap.NOT_FIRST:
        continue;
    }

    const replier = searchingMap.getReplier(img, db);
    const needCacheMsgs = [];
    let success = true;
    let hasSucc = false;
    let snLowAcc = false;
    let useAscii2d = args.a2d;
    let useIqdb = args.iqdb;
    const useWhatAnime = db === snDB.anime;



    // saucenao
    if (!useAscii2d) {
      const snRes = await saucenao(img, db, args.debug || global.config.bot.debug);
      if (!snRes.success) success = false;
      if (snRes.success) hasSucc = true;
      if (snRes.lowAcc) snLowAcc = true;
      if (
        !useWhatAnime &&
        ((global.config.bot.useAscii2dWhenLowAcc && snRes.lowAcc && (db === snDB.all || db === snDB.pixiv)) ||
          (global.config.bot.useAscii2dWhenQuotaExcess && snRes.excess) ||
          (global.config.bot.useAscii2dWhenFailed && !success))
      ) {
        useIqdb = true;
        useAscii2d = true;
      }
      if (snRes.msg.length > 0) needCacheMsgs.push(snRes.msg);
      await replier.reply(snRes.msg, snRes.warnMsg);
    }

    // iqdb
    if (useIqdb) {
      const { ReturnMsg, success: iqdbSuc, asErr } = await IqDB(img.url).catch(asErr => ({ asErr }));
      if (asErr) {
        
        success = false;
        const errMsg =
          (asErr.response && asErr.response.data.length < 100 && `\n${asErr.response.data}`) ||
          (asErr.message && `\n${asErr.message}`) ||
          '';
        await replier.reply(`iqdb 搜索失败${errMsg}`);
        console.error('[error] iqdb');
        logError(asErr);
      } else {
        if (iqdbSuc) {
          await replier.reply(ReturnMsg);
          needCacheMsgs.push(ReturnMsg);
        }
      }
    }


    // ascii2d
    if (useAscii2d) {
      const { color, bovw, success: asSuc, asErr } = await ascii2d(img, snLowAcc).catch(asErr => ({ asErr }));
      if (asErr) {
        success = false;
        const errMsg =
          (typeof asErr === 'string' && asErr) ||
          (asErr.response && asErr.response.data.length < 100 && `\n${asErr.response.data}`) ||
          (asErr.message && `\n${asErr.message}`) ||
          '';
        await replier.reply(`ascii2d 搜索失败${errMsg}`);
        console.error('[error] ascii2d');
        logError(asErr);
      } else {
        if (asSuc) hasSucc = true;
        if (!asSuc) success = false;
        await replier.reply(color, bovw);
        needCacheMsgs.push(color, bovw);
      }
    }

    // 搜番
    if (useWhatAnime) {
      const waRet = await whatanime(img, args.debug || global.config.bot.debug);
      if (waRet.success) hasSucc = true;
      if (!waRet.success) success = false; // 如果搜番有误也视作不成功
      await replier.reply(...waRet.msgs);
      if (waRet.msgs.length > 0) needCacheMsgs.push(...waRet.msgs);
    }

    if (!hasSucc) logger.releaseQuota(context.user_id);
    replier.end(img);

    // 将需要缓存的信息写入数据库
    if (psCache.enable && success) {
      psCache.set(img, db, needCacheMsgs);
    }
  }
}




function doOCR(context) {
  const msg = context.message;
  const imgs = getImgs(msg);
  let lang = null;
  const langSearch = /(?<=--lang=)[a-zA-Z]{2,3}/.exec(msg);
  if (langSearch) lang = langSearch[0];

  for (const img of imgs) {
    ocr
      .default(img, lang)
      .then(results => replyMsg(context, CQ.escape(results.join('\n'))))
      .catch(e => {
        replyMsg(context, 'OCR发生错误');
        console.error('[error] OCR');
        logError(e);
      });
  }
}

/**
 * 从消息中提取图片
 *
 * @param {string} msg
 * @returns {MsgImage[]} 图片URL数组
 */
export function getImgs(msg) {
  const cqImgs = CQ.from(msg).filter(cq => cq.type === 'image');
  return cqImgs.map(cq => new MsgImage(cq));
}

/**
 * 判断消息是否有图片
 *
 * @param {string} msg 消息
 * @returns 有则返回true
 */
export function hasImage(msg) {
  return msg.indexOf('[CQ:image') !== -1;
}

/**
 * 发送消息给管理员
 *
 * @param {string} message 消息
 */
export function sendMsg2Admin(message) {
  const admin = global.config.bot.admin;
  if (bot.isReady() && admin > 0) {
    bot('send_private_msg', {
      user_id: admin,
      message,
    });
  }
}

/**
 * 回复消息
 *
 * @param {*} context 消息对象
 * @param {string} message 回复内容
 * @param {boolean} at 是否at发送者
 * @param {boolean} reply 是否使用回复形式
 */
export async function replyMsg(context, message, at = false, reply = false) {
  if (!bot.isReady() || typeof message !== 'string' || message.length === 0) return;
  if (context.message_type === 'group' && typeof context.group_id === 'string' && context.group_id.includes('_')) {
    const [guild_id, channel_id] = context.group_id.split('_');
    return replyMsg(
      {
        ...context,
        message_type: 'guild',
        guild_id,
        channel_id,
      },
      message,
      at,
      reply,
    );
  }

  const parts = [message];
  if (context.message_type !== 'private' && at) parts.unshift(CQ.at(context.user_id));
  if (context.message_type !== 'guild' && context.message_type !== 'private' && reply) {
    parts.unshift(CQ.reply(context.message_id));
  }
  message = parts.join('');

  const logMsg = global.config.bot.debug && debugMsgDeleteBase64Content(message);
  switch (context.message_type) {
    case 'private':
      if (global.config.bot.debug) {
        console.log(`回复私聊消息 qq=${context.user_id}`);
        console.log(logMsg);
      }
      return bot('send_private_msg', {
        user_id: context.user_id,
        message,
      });
    case 'group':
      if (global.config.bot.debug) {
        console.log(`回复群组消息 group=${context.group_id} qq=${context.user_id}`);
        console.log(logMsg);
      }
      return bot('send_group_msg', {
        group_id: context.group_id,
        message,
      });
    case 'discuss':
      if (global.config.bot.debug) {
        console.log(`回复讨论组消息 discuss=${context.discuss_id} qq=${context.user_id}`);
        console.log(logMsg);
      }
      return bot('send_discuss_msg', {
        discuss_id: context.discuss_id,
        message,
      });
    case 'guild':
      if (global.config.bot.debug) {
        console.log(`回复频道消息 guild=${context.guild_id} channel=${context.channel_id} tinyId=${context.user_id}`);
        console.log(logMsg);
      }
      return bot('send_guild_channel_msg', {
        guild_id: context.guild_id,
        channel_id: context.channel_id,
        message,
      });
  }
}

/**
 * 回复搜图消息
 *
 * @param {*} ctx 消息对象
 * @param {string[]} msgs 回复内容
 * @param {string[]} [forwardPrependMsgs] 合并转发附加内容
 * @param {*} [options] global.config.bot
 */
export async function replySearchMsgs(
  ctx,
  msgs,
  forwardPrependMsgs = [],
  { groupForwardSearchResult, privateForwardSearchResult, pmSearchResult, pmSearchResultTemp } = global.config.bot,
) {
  msgs = msgs.filter(msg => msg && typeof msg === 'string');
  if (msgs.length === 0) return;

  // 群内搜图，私聊回复
  if (pmSearchResult && ctx.message_type === 'group') {
    await replyMsg(ctx, '搜图结果将私聊发送', false, true);

    // 合并发送
    if (privateForwardSearchResult && !pmSearchResultTemp) {
      return replyPrivateForwardMsgs(ctx, msgs, forwardPrependMsgs);
    }

    // 逐条发送
    return asyncMap(msgs, msg => {
      if (global.config.bot.debug) {
        console.log(`回复私聊消息 qq=${ctx.user_id}`);
        console.log(debugMsgDeleteBase64Content(msg));
      }
      return bot('send_private_msg', {
        user_id: ctx.user_id,
        group_id: global.config.bot.pmSearchResultTemp ? ctx.group_id : undefined,
        message: msg,
      });
    });
  }

  // 群内搜图，合并转发
  if (groupForwardSearchResult && ctx.message_type === 'group') {
    return replyGroupForwardMsgs(ctx, msgs, forwardPrependMsgs);
  }

  // 私聊搜图，合并转发
  if (privateForwardSearchResult && !pmSearchResultTemp && ctx.message_type === 'private') {
    return replyPrivateForwardMsgs(ctx, msgs, forwardPrependMsgs);
  }

  // 逐条发送
  return asyncMap(msgs, msg => replyMsg(ctx, msg, false, true));
}

/**
 * 发送合并转发到私聊
 *
 * @param {*} ctx 消息上下文
 * @param {string[]} msgs 消息
 */
export function replyPrivateForwardMsgs(ctx, msgs, prependMsgs = []) {
  const messages = createForwardNodes(ctx, [...prependMsgs, ...msgs]);
  if (global.config.bot.debug) {
    console.log(`回复私聊合并转发消息 qq=${ctx.user_id}`);
    console.log(debugMsgDeleteBase64Content(JSON.stringify(messages)));
  }
  return bot('send_private_forward_msg', {
    user_id: ctx.user_id,
    messages,
  });
}

/**
 * 发送合并转发到群
 *
 * @param {*} ctx 消息上下文
 * @param {string[]} msgs 消息
 */
export function replyGroupForwardMsgs(ctx, msgs, prependMsgs = []) {
  const messages = createForwardNodes(ctx, [...prependMsgs, ...msgs]);
  if (global.config.bot.debug) {
    console.log(`回复群组合并转发消息 group=${ctx.group_id} qq=${ctx.user_id}`);
    console.log(debugMsgDeleteBase64Content(JSON.stringify(messages)));
  }
  return bot('send_group_forward_msg', {
    group_id: ctx.group_id,
    messages,
  });
}

function createForwardNodes(ctx, msgs, prependCtxMsg = false) {
  const messages = msgs.map(content => ({
    type: 'node',
    data: {
      name: '\u200b',
      uin: String(ctx.self_id),
      content,
    },
  }));
  if (prependCtxMsg) {
    messages.unshift({
      type: 'node',
      data: {
        id: ctx.message_id,
      },
    });
  }
  return messages;
}

export function sendGroupMsg(group_id, message) {
  if (global.config.bot.debug) {
    console.log(`发送群组消息 group=${group_id}`);
    console.log(debugMsgDeleteBase64Content(message));
  }
  return bot('send_group_msg', {
    group_id,
    message,
  });
}

/**
 * 生成随机浮点数
 *
 * @returns 0到100之间的随机浮点数
 */
function getRand() {
  return rand.floatBetween(0, 100);
}

export function parseArgs(str, enableArray = false, _key = null) {
  const m = minimist(
    str
      .replace(/(--[\w-]+)(?:\s*)(\[CQ:)/g, '$1 $2')
      .replace(/(\[CQ:[^\]]+\])(?:\s*)(--[\w-]+)/g, '$1 $2')
      .split(' '),
    {
      boolean: true,
    },
  );
  if (!enableArray) {
    for (const key in m) {
      if (key === '_') continue;
      if (Array.isArray(m[key])) m[key] = m[key][0];
    }
  }
  if (_key && typeof m[_key] === 'string' && m._.length > 0) m[_key] += ' ' + m._.join(' ');
  return m;
}

function debugMsgDeleteBase64Content(msg) {
  return msg.replace(/base64:\/\/[a-z\d+/=]+/gi, '(base64)');
}

function isSendByAdmin(ctx) {
  return ctx.message_type === 'guild'
    ? ctx.user_id === global.config.bot.adminTinyId
    : ctx.user_id === global.config.bot.admin;
}

function handleOriginImgConvert(ctx) {
  if (!(/(^|\s|\])原图($|\s|\[)/.test(ctx.message) && hasImage(ctx.message))) return;
  originImgConvert(ctx);
  return true;
}

function originImgConvert(ctx) {
  const imgs = getImgs(ctx.message);
  const lines = imgs.map(img => (img.isUrlValid ? img.url : '获取原图链接失败'));
  replyMsg(ctx, lines.join('\n'), false, false);
}