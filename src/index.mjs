import { CQWebSocket } from '@tsuk1ko/cq-websocket';
import Fs from 'fs-extra';
import _ from 'lodash-es';
import minimist from 'minimist';
import RandomSeed from 'random-seed';
import ascii2d from './plugin/ascii2d.mjs';
import bilibiliHandler from './plugin/bilibili/index.mjs';
import broadcast from './plugin/broadcast.mjs';
import characterglm from './plugin/AImodule/characterglm.mjs';
import glm4 from './plugin/AImodule/glm4.mjs';
import tarotReader from './plugin/AImodule/tarotReader.mjs';
import tongyixingchen from './plugin/AImodule/tongyixingchen.mjs';
import corpus from './plugin/corpus.mjs';
import getGroupFile from './plugin/getGroupFile.mjs';
import like from './plugin/like.mjs';
import ocr from './plugin/ocr/index.mjs';
import { rmdHandler } from './plugin/reminder.mjs';
import saucenao, { snDB } from './plugin/saucenao.mjs';
import IqDB from './plugin/iqdb.mjs';
import sendSetu from './plugin/setu.mjs';
import vits from './plugin/vits.mjs';
import whatanime from './plugin/whatanime.mjs';
import { loadConfig } from './setup/config.mjs';
import { globalReg } from './setup/global.mjs';
import asyncMap from './utils/asyncMap.mjs';
import { execUpdate } from './utils/checkUpdate.mjs';
import CQ from './utils/CQcode.mjs';
import emitter from './utils/emitter.mjs';
import { IS_DOCKER } from './utils/env.mjs';
import { checkImageHWRatio, getAntiShieldedCqImg64FromUrl } from './utils/image.mjs';
import logError from './utils/logError.mjs';
import logger from './utils/logger.mjs';
import { getRawMessage } from './utils/message.mjs';
import { resolveByDirname } from './utils/path.mjs';
import psCache from './utils/psCache.mjs';
import searchingMap from './utils/searchingMap.mjs';
import  dailyCountInstance   from './utils/dailyCount.mjs';



const { version } = Fs.readJsonSync(resolveByDirname(import.meta.url, '../package.json'));

const bot = new CQWebSocket({
  ...global.config.cqws,
  forcePostFormat: 'string',
});
const rand = RandomSeed.create();

// 全局变量
globalReg({
  bot,
  replyMsg,
  sendMsg2Admin,
  parseArgs,
  replySearchMsgs,
  replyGroupForwardMsgs,
  replyPrivateForwardMsgs,
  sendGroupMsg,
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
      setTimeout(() => {
        sendMsg2Admin(`已上线#${attempts}`);
      }, 1000);
    }
  });

// connect
bot.connect();

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

  // 忽略指定正则的发言
  if (config.regs.ignore && new RegExp(config.regs.ignore).test(context.message)) return true;

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
  //🦾🤖赛博斯坦内鬼
  if (context.message.includes('💪🏻😃')) {
    replyMsg(context, context.message.replace('💪🏻😃', '🦾🤖'));
    return true;
  }
  //发癫
  if (context.message.startsWith('/发癫 ')) {
    const sentence = psycho[Math.floor(Math.random() * psycho.length)];
    const name = context.message.replace('/发癫 ', '');
    replyMsg(context, sentence.replaceAll('<name>', name ? name : '爱丽丝'));
    return true;
  }
  // characterglm
  if (global.config.bot.characterglm.enable) {
    if (await characterglm(context)) return true;
  }
  //glm4
  if (global.config.bot.glm4.enable) {
    if (await glm4(context)) return true;
  }

  //tongyixingchen
  if (global.config.bot.tongyixingchen.enable) {
    if (await tongyixingchen(context)) return true;
  }

    //塔罗占卜
    if (global.config.bot.tarotReader.enable) {
      if (await tarotReader(context)) return true;
    }

  //处理完所有模型回复后判断AImode，结束所有功能
  if (global.config.bot.AImode) {
    return true;
  }
  //继续非AI相关功能

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
  if (await bilibiliHandler(context)) return true;

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

  // 更新程序
  if (args['update-cqps']) {
    if (IS_DOCKER) replyMsg(context, 'Docker 部署不支持一键更新');
    else replyMsg(context, '开始更新，完成后会重新启动').then(execUpdate);
    return true;
  }

  // 重载配置
  if (args.reload) {
    try {
      const nodePersist = require('node-persist');

// 初始化node-persist
nodePersist.init();
      loadConfig();
      replyMsg(context, '配置已重载');
    } catch (error) {
      console.error(error);
      replyMsg(context, String(error));
    }
    return true;
  }

  if(args.save){
    dailyCountInstance.saveAndResetTimer()
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

  if (await commonHandle(e, context)) {
    e.stopPropagation();
    return;
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
            e.stopPropagation();
            return;
          }
          const imgs = getImgs(getRawMessage(data));
          const rMsg = imgs
            .map(({ file, url }) => `[CQ:image,file=${CQ.escape(file, true)},url=${CQ.escape(url, true)}]`)
            .join('');
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
    } else {
      replyMsg(context, global.config.bot.replys.default, true);
    }
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

  if ((await commonHandle(e, context)) || (await getGroupFile(context))) {
    e.stopPropagation();
    return;
  }

  // 进入或退出搜图模式
  const { group_id, user_id } = context;

  if (new RegExp(global.config.bot.regs.searchModeOn).test(context.message)) {
    // 进入搜图
    e.stopPropagation();
    if (
      logger.smSwitch(group_id, user_id, true, () => {
        replyMsg(context, global.config.bot.replys.searchModeTimeout, true);
      })
    ) {
      replyMsg(context, global.config.bot.replys.searchModeOn, true);
    } else replyMsg(context, global.config.bot.replys.searchModeAlreadyOn, true);
  } else if (new RegExp(global.config.bot.regs.searchModeOff).test(context.message)) {
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
          MsgReply += `${key}？？`
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

  const incorrectImgs = _.remove(imgs, ({ url }) => !/^https?:\/\/[^&]+\//.test(url));
  if (incorrectImgs.length) {
    if (global.config.bot.debug) console.warn('incorrect images:', incorrectImgs);
    replyMsg(context, '部分图片无法获取，请尝试使用其他设备QQ发送', false, true);
  }

  if (!imgs.length) return;

  // 获取图片链接
  if (/(^|\s|\])链接($|\s|\[)/.test(context.message) || args['get-url']) {
    replyMsg(context, _.map(imgs, 'url').join('\n'));
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
        const msgs = cache.map(msg => `${CQ.escape('[缓存]')} ${msg}`);
        const antiShieldingMode = global.config.bot.antiShielding;
        const cqImg =
          antiShieldingMode > 0 ? await getAntiShieldedCqImg64FromUrl(img.url, antiShieldingMode) : CQ.img(img.file);
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
      !(await checkImageHWRatio(img.url, global.config.bot.stopSearchingHWRatioGt))
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
    let useWhatAnime = db === snDB.anime;



    // saucenao
    if (!useAscii2d) {
      const snRes = await saucenao(img.url, db, args.debug || global.config.bot.debug);
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
      if (!snRes.lowAcc && snRes.msg.indexOf('anidb.net') !== -1) useWhatAnime = true;
      if (snRes.msg.length > 0) needCacheMsgs.push(snRes.msg);
      await replier.reply(snRes.msg, snRes.warnMsg);
    }

    //iqdb
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
      const { color, bovw, success: asSuc, asErr } = await ascii2d(img.url, snLowAcc).catch(asErr => ({ asErr }));
      if (asErr) {
        success = false;
        const errMsg =
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
      const waRet = await whatanime(img.url, args.debug || global.config.bot.debug);
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
 * @returns {Array<{ file: string; url: string; }>} 图片URL数组
 */
export function getImgs(msg) {
  if (Array.isArray(msg)) {
    const cqImgs = msg.filter(item => item.type === 'image');
    return cqImgs.map(item => {
      return {
        file: item.data.file,
        url: getUniversalImgURL(item.data.url || item.data.file)
      };
    });
  } else {
    const cqImgs = CQ.from(msg).filter(cq => cq.type === 'image');
    return cqImgs.map(cq => {
      const data = cq.pickData(['file', 'url']);
      data.url = getUniversalImgURL(data.url || data.file);
      return data;
    });
  }
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

function getUniversalImgURL(url = '') {
  if (/^https?:\/\/(c2cpicdw|gchat)\.qpic\.cn\/(offpic|gchatpic)_new\//.test(url)) {
    return url
      .replace('/c2cpicdw.qpic.cn/offpic_new/', '/gchat.qpic.cn/gchatpic_new/')
      .replace('/gchat.qpic.cn/offpic_new/', '/gchat.qpic.cn/gchatpic_new/')
      .replace(/\/\d+\/+\d+-\d+-/, '/0/0-0-')
      .replace(/\?.*$/, '');
  }
  return url;
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
  const cqImgs = CQ.from(ctx.message).filter(cq => cq.type === 'image');
  const imgs = cqImgs.map(cq => CQ.img(cq.get('url')));
  replyMsg(ctx, imgs.map(str => CQ.unescape(str)).join(''), false, false);
}

const psycho = [
  "<name>，虽然晚了些但端午还是要有仪式感，粽叶、糯米、蜜枣都准备好了，还剩一样东西就交给你了，你准备好艾草吧",
  "本来在地里耕田的，一看到<name>就跟打了鸡血一样，我一脚把牛踢开了自己耕了20亩地，假如百年之后，若有强敌入侵，还请在我坟头放<name>的照片，吾自当破土而出守我华夏，击退强敌",
  "网上看到一种说法，说日本人看到烟花就会想起夏天，夏日祭和烟花大会，夏季和服还有小金鱼;而中国人看到烟花就会感到寒风灌进鼻腔，想起热腾腾的饭菜和排骨汤一该过年了 。\n我觉得他说的很有道理。我还记得小时候玩烟花，都是穿着厚厚的棉袄。这也是中国人民的传统智慧一穿着厚衣服，可以玩烟花对射，被打到也不疼，就是容易把新衣服烧个窟窿，然后回家挨揍。\n我第一次见到<name>的时候一尽管当时我戴着耳机，而且刚过四月一我 却分明听到了烟花在耳边炸开，然后再噼里啪啦地落到地面，我甚至能感受到火星子刺伤了我的眼睛。\n喜欢<name>的感觉呢，就像是眼睁睁看着烟花朝自己飞过来。我自以为冲浪多年，早就给自己套了几层棉袄，已经刀枪不入了，可等我反应过来，我的心已经被她烧了一个大窟窿，怎么也填不满了。\n说来也好笑，明明就是她烧穿了我的棉袄，我却还想跑到她面前，指着那个大窟窿对她炫耀:“看，我有这么喜欢你!”",
  "和<name>赛跑，他从后面狠狠地把我超了",
  "<name>,一年我只有3天不会喜欢你。\n一天是2月29,一天是2月30,一天是2月31。\n众神无法容忍我 这三天不喜欢你,所以他们把这三天抹去了,这样我就能一年都喜欢你了。",
  "昨晚和朋友聊天的时候朋友问我：“你到底喜欢<name>什么啊？”“喜欢一个人不需要理由”我很快敲完了键盘，刚要按下回车的时候突然愣住了。真的不需要理由吗？河里的时沙飞速倒流，站在岸边往里看去，几个月前的自己在名为迷失的波光中影影绰绰，他向我看来，眼里充满了羡慕和满足。原来我变了好多。是他的可爱让我捡起了记忆的碎片，回到那个春夏和秋冬，重温指尖上残留的感触。是他的努力让我寻回尘封了六年的铅笔，当初是为了喜欢的人而开始，现在也是因为喜欢的人而重启。是他的温柔和包容让我有勇气直面自己的心魔，不再逃避也不再畏惧，原来我，还有爱人与被爱的资格。神爱世人，这是个谎言。能爱人的不是神，从来都不是，只有人能爱人。于是我删掉了刚才的那句不需要理由，敲了一行新的，按下了回车。“我喜欢<name>，因为是他让我变得更好。”",
  "呜呜天台上的风很大，今天的风格外凛冽，我看着灯红酒绿的繁华都市眼皮跳了无数下，积攒着怒意的双臂猛挥砸碎了108个窗户，摔烂了38个5G高档高速高质量手机，玻璃渣刺破了我的衣襟，碎掉的是这颗对你永远不变的心。救我啊！<name>！！呜呜呜呜你带走我吧😭😭😭😭😭没有你怎么活啊😭😭😭😭😭",
  "为什么我不是操场啊，这样<name>就可以设在我的小学里了",
  "<name>问我小动物喜欢呆在怎么样的小窝里面，我大声回答说：“草实窝，草实窝！”🥵🥵",
  "我和<name>好像有某种特殊的羁绊，他一出现，我的羁绊就硬",
  "医生摇摇头，叹了口气：“这个病只能靠你，尽量别再看手机了，好吗？”我没太在意医生的话，敷衍地点了点头。\n走出诊室，我就再次拿起手机，紧紧盯着手机屏幕的我心脏剧烈跳动，窒息感也迎面而来。但我没有太在意这些，甚至还对着手机露出了扭曲的笑容，嘴角溢出了唾液，开始止不住地往下滴落……\n医生吓坏了，立马跑出诊室一把夺走了我的手机。医生瞄了眼手机屏幕，想搞明白究竟是什么让我犯这样的病。不一会儿，医生也发疯了，他就开始盯着手机屏幕叫喊：“是<name>！嘿嘿嘿……<name>，嘶哈嘶哈，我要当<name>的狗！” ",
  "我对<name>说白水不好喝，本以为他会给我一杯柠檬水，结果<name>把我按在餐桌上，问我要茶包还是要厚乳",
  "“我不再内卷了,因为<name>把我弄得外翻了”🥵🥵",
  "<name>我遇见你就像东北人吃面，毫无剩蒜😭😭",
  "公司网络太差，我提了离职。因为我不想每一次点开<name>的视频，屏幕上都会要求我  缓  冲  🥰🥰",
  "我对<name>说白水不好喝，本以为他会给我一杯柠檬水，结果<name>把我按在餐桌上，问我要茶包还是厚乳🥵🥵🥵",
  "<name>!（怒吼）（变成猴子）（飞进原始森林）（荡树藤）（创飞路过吃香蕉的猴子）（怒吼）（变成猴子）（飞进原始森林）（荡树藤）（创飞路过吃香蕉的猴子）（怒吼）（变成猴子）（飞进原始森林）（荡树藤）",
  "今天<name>在路上走，我过去把他绊倒，他起来继续走，我又把他绊倒，<name>奇怪的问我干什么，我叫到：“我碍你！我碍你！”",
  "<name>!!!!!🥵呜呜......💕💕各种状态的<name>都好可爱唔啊啊啊啊啊......🥵🤤🤤♡嘿嘿...🤤不管是什么样的<name>...💕🤤♡都♡好♡喜♡欢♡🤤💕嘿嘿......🥵啊//已经...♡完全变成<name>的形状了...♡🥰没有<name>就完全活不下去desu♡🥰<name>🥵<name>🥵<name>🥵<name>🥵<name>🥵今天干了什么不知道，因为我脑子里全都是<name>🥵💘脑子里...♡咕啾咕啾的...♡已经...♡被<name>酱塞满了呐...♡♡🥴💘",
  "想吐槽一下<name>。 能不能爬,最讨厌这个<name>了。 总是多管我的闲事,人也笨,麻烦,讨厌。 烂好人,容易被骗,讨厌。为什么察觉不到啊,八嘎八 嘎八嘎,最讨人厌啦! 但又是那么喜欢你🥰,suki🥰suki,🥰daIsuki🥰🥰🥰…笨蛋,再多看看我啊!毕竟人家,最喜欢你了啊!🤤🤤🤤🤤",
  "今天去乘电梯，电梯只能乘11人，当时电梯里面有10个人，我在电梯门口迟疑了一下还是走进去，进去后。电梯响起超载报警。唉，我心中装着<name>这个事，终于无法骗过电梯",
  "<name>，你简直是我的神！！！（尖叫）（扭曲）（阴暗地爬行）（尖叫）（扭曲）（阴暗地爬行）（尖叫） （爬行）（扭动）（分裂）（阴暗地蠕动）（翻滚）（激烈地爬动）（扭曲）（痉挛）（嘶吼）（蠕动）（阴森地低吼）（爬行）（分裂）（走上岸）（扭动）（痉挛）（蠕动）（扭曲地行走）",
  "<name>，我刚刚在寝室喝水，闻到一股焦味，但是效果和热水壶都没开，奇怪，会不会是电路烧了，我把电线全都拿掉了，我以为是线的问题，我还在想要不要叫宿管，然后，我突然发现了，你猜怎么着，原来是我的心在为你燃烧🥳🥳🥳",
  "好想成为<name>卧室的门,每天都能被他进进出出🥵🥵🥵🥵",
  "今天跟朋友去吃饭 点了一条鱼朋友问我为啥只吃鱼头我说因为鱼身要留着和<name>一起过",
  "<name>选择走楼梯，我想，他想走进我心里，<name>果然对我有意思 。\n我在电梯间偶遇<name>。\n<name>按一层，我想，他对我一心一意。\n<name>按二层，我想，他想跟我过二人世界。\n<name>按三层，我想，他想跟我三生三世。\n<name>按四层，我想，死了都要爱。\n<name>按五层，我想，他在暗示我注意他。\n<name>按六层，我想，他好官方好害羞还祝我六六大顺。\n<name>按七层，我想，他想和我有七彩生活\n<name>按八层，我想，他八层喜欢我。\n<name>按九层，我想，他想和我九九同心。\n<name>按十层，我想，他想和我有一世爱情。\n<name>不按，我想，怎么，遇见我激动的动都不动了?\n<name>刚进电梯又转身离开，我想，<name>看到我害羞了，不好意思和我独处，我这就追上去求婚。<name>既没有走楼梯也没有坐电梯，我想，这肯定是<name>欲擒故纵的小把戏，今晚就去他家。",
  "老师，这个对社会影响很不好。刚刚我在外面看了看，裤子直接就炸了！旁边的人笑我，我很羞涩，并把手机放在了桌子上，那个人也看到了，他更离谱！他的裤子直接甩掉他跑出去了！边跑还边喊着它要上太空！然后又有人开始笑他，然后他不服气，抓起我的手机就朝那些人扔了过去，凡是手机飞过的地方裤子都炸了，过了一会儿，满地都是裤子和裤子残渣",
  "破防了，我真的破防了，就因为你的一句<name>贴贴， 我直接丢盔弃甲了。那一秒 我满头大汗 浑身发冷 亿郁症瞬间发作了 生活仿佛没了颜色 像是被抓住尾巴的赛亚人 带着海楼石的能力者 抽离尾兽的人柱力 像是没了光的奥特曼 彻底断绝了生的希望 你的一声急了急了 我的心跳快要停止了 或许真的是时候重开了 重来能解决一切\n嗯我急了 手机电脑我全砸了 别人一说我急了 我好像就真的恼羞成怒了 仿佛你看穿了在网络背后的我 这种感觉我很不舒服 被看穿了被看的死死的 我不想再故作坚强了 玩心态我输的死死的！\n我看到这些已经毫无波澜了，这些爱情已经伤不到我了。我在大润发杀了十年的鱼，我的心早已跟我的刀一样冷了。我还在少林寺扫了八年叶子，我的心早已和风一样凉了。我还在长江游了十年冬泳，我的心早已和水一样冰了\n这回是真破防了，看着你和<name>的甜言蜜语，我真的破大防了，看着你的生活，我的生活立刻黯然失色，孤苦伶仃。为什么上天如此不公平。想到这我就更急了，你的每一句话似乎都在嘲笑我，我输的太彻底了，我是个失败者，爱情上的失败者。你的话深深刺痛我的心，我甚至可能会为此重开，在这个互联网上，人与人的差距显示出来，似乎人人都在嘲笑我，别秀啦，求求你别秀啦",
  "接触网络前，我是个自卑腼腆的人，连和人说句话都不敢，感谢网络，让我变得开朗自信，我现在已经狂的不是人了，嗨老婆",
  "我和<name>去吃烧烤，点了大绿瓶啤酒，<name>第一次喝，不知道怎么开酒瓶，我就借他开瓶盖的工具，但是他使劲过头把工具掰飞了，我大喊：“我的起子！我的起子！”",
  "<name>的样子真的♡…哈，哈啊♡，太帅了哈啊……呜呜，<name>怎么能……♡扛不住了哈♡……啊啊～已经离不开<name>了啊哈~<name>好棒！嗯啊~要被帅气坏了啊啊啊~好帅啊～♡嗯~已经成了♡不看<name>就不行的笨蛋了~♡",
  "<name>，你失忆了，你是我老婆\n我们相识即一见钟情，相恋十年有余，第四年同居，两年后定下终身，得到我们两家长辈的祝福，结为秦晋之好，然天有不测风云，你被奸人所害，只因嫉妒我们夫妻幸福美满，家庭甜蜜和睦，后尔又为人所拐，一直杳无音讯 今日我特发此贴，正是望你知道真相，希望你知道，看到此贴的你，正是我消失了的妻子，请速来联系我，让我们一家团聚!拯救我这个破碎的家庭，和我这颗千疮百孔的心！",
  "<name>瘾发作最严重的一次，躺在床上，拼命念大悲咒，难受的一直抓自己眼睛，以为刷推特没事，看到推特都在发<name>的图，眼睛越来越大都要炸开了一样，拼命扇自己眼睛，越扇越用力，扇到自己眼泪流出来，真的不知道该怎么办，我真的想<name>想得要发疯了。我躺在床上会想<name>，我洗澡会想<name>，我出门会想<name>，我走路会想<name>，我坐车会想<name>，我工作会想<name>，我玩手机会想<name>，我盯着网上的<name>看，我盯着朋友圈别人照片里的<name>看，我每时每刻眼睛都直直地盯着<name>看，我真的觉得自己像中邪了一样，我对<name>的念想似乎都是病态的了，我好孤独啊!真的好孤独啊!这世界上那么多<name>为什么没有一个是属于我的。你知道吗?每到深夜，我的眼睛滚烫滚烫，我发病了我要疯狂看<name>，我要狠狠看<name>，我的眼睛受不了了，<name>，我的<name>",
  "我试图用那些漂亮的句子来形容你。但是不行\n我字字推敲写出长长一段话\n你眉眼一弯熠熠生辉就让我觉得。不行\n这些文字写不出你眼里的星辰\n读不出你唇角的春风\n无论哪个词都及不上你半分的柔艳。\n<name>\n你的双眸有遥远的冬雪，\n你的微笑有绚烂的夏阳，\n你一转身便有花开为你，\n你一低头便有星辰黯然，\n但没有你的日子\n 春 夏 秋 冬\n 也只是被赋予“季节”的名义",
  "有人说月球上的坑是陨石砸出来的，其实不是，是我在看老师做的<name>mmd之后在远离月球384000公里的地球上凭我的一己之力冲出来的🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤",
  "天台上的风很大，今天的风格外凛冽，积攒着怒意的双臂猛挥砸碎了108个窗户，摔烂了38个5G高档高速高质量手机，玻璃渣刺破了我的衣襟，碎掉的是这颗对<name>你永远不变的心<name>你带我走吧没有你我怎么活啊",
  "<name>，对不起，瞒了你这么久，其实我不是人类，我是海边的一种贝壳，我的名字叫沃事泥得堡贝🥵",
  "<name>，我承认你有几分姿色。如果我20岁\n我会毫不犹豫追你。如果我三十岁，我会放弃家庭跟你在一起。但是真的很对不起,我现在才三年级，作业压得我喘不过气，所以我能抄你一下吗🥵",
  "<name>，我的心都碎成二维码了 可扫出来还是我好喜欢你呜呜呜",
  "<name>我喜欢你，快来影响我吧，快来占有我，快来支配我吧，心甘情愿被你爱着",
  "我不想喜换<name>了。     原因有很多。    他是屏幕那头的人，我是屏幕这头的人，两条平行线注定碰不到一起。     他是为了挣我的币才与我接触，平日专注。     他是受万人喜爱的宝藏男孩，我只不过一介平凡少女，无论我多么喜欢，在他那里注定得不到任何正反馈……     我想通了，决定放弃。     下一个视频略过，视频通通删干净，眼不见心不烦，还能留出时间卷学习成绩，这不是好事一桩?     第二天，我正常起床，洗漱，吃饭，没什么变数。我换好衣服，准备出门。     当我踏出门外的那一刻，我才意识到，坏事了。     我不知道该往哪个方向迈出下一步了。         平时一览无余的街道，现在竟然充满了迷雾。我仿佛是没有罗盘的一艘船，在茫茫大海里打转。四面八方都是海水，都是一样的蓝，我该往哪走? 我要去哪? 我要干什么?      船没有了罗盘，我丢失了方向，人生缺少了目标。     这是很可怕的一件事，我至此以来做过的所有事情都化为了泡影，没有了意义，全部灰飞烟灭。     路边跳过一只橘色的猫，看了我一眼，好像在嘲笑我的落魄。     我害怕了。我逃回家里，打开电脑手机，把视频打开，把他的声音听了无数遍，直到午夜之时我沉沉睡去。      梦里，我恍然大悟。     人总要有个盼头，有个让你追逐的东西。它可以赋予你的努力以价值。     原来这就是存在的意义啊，我所做的一切，不就是为了追逐，为了让他能笑着对我说，多亏了你, 我才能来到这片未曾踏足的领域？      没错，他与我确实是不可能的，但是他却让我的生活拥有了动力与目标。      我不想喜欢<name>了。     原因只有一个。     我已经爱上<name>了。",
  "妹妹不知从哪学到了wife这个单词，但是她老是和WiFi搞混。有一次我把家里网络的名字改成了“<name>”，表哥来家里玩，他问我，家里WiFi是啥，妹妹很明显想要展示一下自己新学的词汇，她大喊姐姐的wife是<name>",
  "“你吃过世界上最苦的糖吗？”\n“吃过,<name>的喜糖。”\n“你喝过世界上最难喝的东西吗？”\n“喝过 ,<name>的喜酒。”\n“你拿过世界上最烫的东西吗？”\n“拿过,<name>的喜帖。”\n“你知道世界上最开心的事情是什么吗？”\n“知道,<name>的孩子像我。”",
  "好想和<name>玩赛车啊，一会儿我超他，一会儿他超我🤤",
  "我120岁的时候接受记者的采访：“这位爷爷你长寿的秘诀是什么？”我掏出包里<name>的照片颤颤巍巍地说：“这辈子亲不到他我是不会闭眼的。”",
  "啊<name>❤️❤️新鲜的<name>，为了你，我要sneed new new，啊啊啊，不行了，<name>，不行了，❤️❤️❤️这样会会坏掉的❤️❤️",
  "<name>英语不好，一次英语课老师问他girl 是什么意思，他向我求助，我指了指自己，他愣了许久，轻轻的说：老婆",
  "今天发烧了，<name>问我怎么得的，我没有说话，只是给她看了这个视频，现在我们都燥热难耐",
  "我要送给<name>一把方天画戟，这样他就能握住我的戟把了❤️❤️❤️",
  "今天是我在电焊厂上班的第九十九天，这里实在是太闷太热了，我走了出来，在树下抽了一支烟。我想，虽然不知道你在干什么，但我一直在想你，有了你，这生活总算是有盼头了一些。<name>，我不想在电焊厂上班了，因为我电不到你，也焊不牢你的心",
  "<name>！！我要当你的伞🌂🌂🌂！！！这样的话我就能为你遮风挡雨😭😭😭也能让你握住我的钩把了呜呜呜！！！",
  "我健康码红了,可我不记得去过高风险地区。查了才知道去过<name>的前列县🥵🥵",
  " 任何事物都不是绝对的,就像清晨洒在<name>脸上的不一定是阳光,中午含在<name>嘴里的不一定是棒棒糖,晚上<name>被窝里抱的不一定是枕头🥵🥵🥵",
  "我经常拿<name>的手机玩，有一次我给<name>的手机设了密码，<name>啥也没说，后来我天天在他手机上设密码，<name>就对我说：“你别设了，会坏掉的”🥵🥵🥵",
  "我想让<name>变成光,这样每天早上醒来时候的第一缕晨光就会照射在我的心上,就像<name>躺在我怀里对我笑了一样",
  "大家好，这是我男朋友<name>，我们已经公开了我们的关系，见过了父母，已经同居，还被亲朋好友祝福过，亲手为她做过无数顿饭，特别关心她的电话和微信，但嘴长在我自己脸上，我说是就是☺️☺️",
  "我听说在枝江有一位少女，她会宅舞二十连，她会叮嘱大家好好吃饭，她会宽恕曾经的罪人。我慕名而来，我追寻你的踪迹。他们说你在夏日沙滩滩上与海浪起舞，他们说你在水底同鱼儿歌唱，他们说在寒冬 你会搂着小猫小鼠在暖炉旁讲睡前故事。为了你我走啊走，哪怕在内陆的我距海千里，哪怕我这个旱鸭子压根不敢下水，哪怕顶着寒冬挨家挨户地寻找那别在亚麻色秀发上的粉色蝴蝶结。可是我始终找不到你的影子。我亲爱的<name>，你究竟在哪里？",
  "α 阿尔法， β 贝塔， γ 伽玛，δ 德尔塔， ε 伊普西隆， ζ 泽塔， η 伊塔， θ 西塔， ι 约塔， κ 卡帕， λ 兰姆达，μ 米欧 ，ν 纽， ξ 克西， ο 欧米克隆， π 派， ρ 柔 ，σ 西格玛， τ 陶 ，υ 玉普西隆， φ 弗爱， χ 凯， ψ 普赛   ♡<name>🤤🤤🌹🌹",
  "好想做<name>的雨伞,这样<name>就可以握着我的勾把了😍😍🥵🥵",
  "是…是的...♡喜欢<name>！我真的喜欢<name>!........♡呜呜、不行了，我已经变成不看<name>就不行的笨蛋了...啊啊♡好喜欢♡<name>…🥵🥵🥵🥵🥵🥵",
  "<name>😭 😭 🤤🤤，我的<name>😭 😭🤤🤤 ，为了你🙆💗 💗 ，我变成狼人模样🐺 🐺 ，为了你🙆 💗 💗 ，染上疯狂🤯🤯，为了你 🙆 💗 💗 ，穿上厚厚的伪装 💄 🤡💄🤡 ，为了你🙆💗 💗 ，换了心肠💘💘，我们还能不能再见面✨ 🎇 😭 😭 🎇 ✨ ，我在佛前苦苦求了几千年🙇🙇💔 💔 ，愿意用几世🥵🥵🎎 ，换我们一世情缘🥰💞 💞 🥰💞💞 ，希望可以感动上天🙏🙏 🙋✋☁ ☀ ☀ ， 我们还能不能能不能再见面🏃💓 🏃，我在佛前苦苦求了几千年🧓🎏 🎏 ，但我在踏过这座奈何桥之前🌊 🌊 ",
  "我！讨厌、<name>在我不知道的地方笑！还有、和其他人牵手也是！只和我就好！我特别希望是和我在一起！庆典我也是好想去的！<name>看上去很开心的，笑著的，在你旁边有我！那样的才好！头好痛的、好难受的！我一直就只思考<name>的事，思考得、快不正常了…",
  "我怀疑<name>的学历掺水，我就去查他，一直查他，他哭着求我不要查他学历，但是他的学历真的水好多啊，我只能一直查他，他就一直哭着求我不要查他🥵🥵",
  "我和<name>都是飞行员,按上级的要求,我们在空中盘旋的时候必须按照“飞行员的编号按顺序来,但是今天我身体不适,<name>竟然从身后反超了我,我怎么恳求他都不听,下来后,我被上级臭骂一顿,委屈地说:“是他超我,从后超我。”其他同伴也为我辩解:“是<name>超了他,是<name>超了他!",
  "每次网购我都不填本名我都填<name>快递员送来就问:“请问<name>在吗？”我都说:“不在，我是她的狗”",
  "我想举报<name> 考试抄我的答案🥵我一直挡着说 不要抄了 不要抄了🥵当时我的眼泪都流下来了🥵可是他还是没听我说的😢一直在抄我🥵呜呜呜呜",
  "<name>!!!我报名了男生女生向前冲,但是他们没有同意,说我不符合条件。后来我去问他们,原来问题在于,我不是男生也不是女生,我是为你而生!!!!",
  "<name>，你是负二，我是负五，我们两个加在一起就是夫妻呀😭😭😭 ",
  "情书是抄来的\n情话是看来的\n套路是学来的\n玫瑰是偷来的\n勇气是借来的\n对<name>的爱是与生俱来的☺️",
  "闺蜜的背叛💔/. 💔/. 家人的误解💔/. 同学的欺负💔/. 生活的负担💔/. 我喜欢血，因为血是甜的，以前我的枕头上都是泪水💔/. 现在都是想<name>的口水🥵",
  "今天学校跑步，快到终点时我一个冲刺超过了<name>，登成绩时，老师问“谁是第9名”我没反应过来，结果老师生气了，他就拿着表吼道“谁超了<name>自己不知道吗？”我便大声回道“我超了<name>！老师！我超了<name>！！！”",
  "有一天mommy在跑步。我冲上去就把他绊倒了。他站起来继续跑，于是我又把他绊倒了。<name>问我：你想干嘛，我对他大喊：“我碍你！我碍你啊！”",
  "呃😓，以前没接触过二次元，看你们对这些个角色这么入脑，真的很幼稚。我觉得人应该把重心放在现实生活中，比如我明天要和我的未婚夫<name>结婚了",
  "不去寻找<name>的消息，不在意<name>而活下去，\n我根本就做不到。我的生活已经被<name>变得苍白了，在没有<name>而兀自流逝了不知道多久的时间里，什么也没发生。如果就这样断绝与<name>有关的一切的未来的话，从今以后的人生恐怕仅仅一张作出泪来。\n我知道我这是自顾自的念想着她，可就算是那样，就算是那样。\n想得到回报就是那么的有错吗？",
  "小时候抓周抓了一只小狗 家人们认为我长大以后会是一个训犬员 最差也是个兽医 没想到最后我成为了<name>的狗",
  "<name>大人的梦想,<name>大人的真心,<name>大人的身体,<name>大人的嘴唇,全部,全部都是我的！",
  "古代有一种甜品制作方法，取霜降后的柿子十余枚，去皮，在锅中大火翻炒至浓稠，味道甜美。\n我一直想不起来这种甜品叫什么，直到见到了这人，我突然想起来，对<name>大喊：炒柿泥啊，炒柿泥啊",
  "咱就是说，刚回来就赶上了😍😍香烟抽了无数，🚬🚬🚬烈酒喝到想吐，🤮🤮🤮向<name>迈出九十九步，😄😄😄<name>却断了我的路，😭😭😭风情万种红尘，😚😚😚唯独对<name>失神，☺️☺️☺️为何<name>要把我拒绝，💔💔💔🥺🥺🥺让我丢了灵魂。💔💔💔💔",
  "我是<name>养的小羊，每次饿了的时候，我都会很乖的问他：“可以给我草吗？”",
  "<name>啊，求你让我实践你的话语，体验你的道。在真理的路上与你同行，有真平安和属灵的智慧临到我，赞美<name>是我的圣女，在天国的背景下，荣耀<name>的名。我确信因<name>的宝血，已经洗去我一切的罪，在信心成长的路上我的<name>使我仰望他，也使我的福杯满溢。愿<name>的慈爱和大能，使渴慕你的人得永生的确信和安慰。",
  "今天我和<name>去博物馆偷东西，被警察发现了，但是我们都没被抓，因为<name>就是艺术品，而我在<name>旁边也是易竖品🥵🥵",
  "我就是稍微问一句，绝对没有冒犯的意思，也可能是我搞错了，又或者我是出现了幻觉，不管怎么样，我都希望我们能秉持着友好理性的原则，我只是本着对于宇宙本质的伟大探究精神以及求真务实精神发问:<name>,我能和你结婚吗？",
  "虽然我知道我们隔着千山万海，隔着荧幕，但我对<name>的爱恋，可击穿顽石 可穿梭银河。即使是单相思又怎么样，只要<name>幸福，我就满足了。她笑起来的时候，我的世界都要化了，她委屈地哭泣的时候，我世界都要崩塌了，她向我撒娇的时候，我恨不得把星星摘下来送给她！我！这辈子都是<name>老婆的仆人！",
  "我得了相思病，医生给我开的药方：麝香0.05g、榔头香10g、速香3g、云头香0.3g、海狸香1g、伽香5g、龙涎香0.3g、红木香6g、灵猫香0.5g、地蜡香6g、飞沉香3g、通血香1g、香根鸢尾5g、<name>一位",
  "<name>，我吃过重庆面、陕西面、天津面、北京面，就是没吃过宁夏面🤤🤤",
  "我毕业好久没工作，到处投简历，投到一家公司人家突然要约谈我，我去了才知道是<name>觉得我的学历有问题，我说没有他偏不信，非要到我家来查我学历🥵🥵🥵",
  "第一次遇到这么吓人的事情，提醒大家一下 特别是女孩子。真的，出门在外要注意安全 刚才出门买东西等红绿灯时。有个男的一把抓住我的手腕，拉着我一路跑，怎么挣脱都挣脱不了。然后被拽进一个酒店，拉进了一个房间。\n一进门就看到房间沙发上有个人低头玩着手机，那个拉着我跑来的人摘下口罩和帽子。对沙发上那人说“<name>，你要的女人我给你带来了。”",
  "请问<name>是意大利和中国的混血吗？不然怎么会这么像我的意中人",
  "手机越来越不好用了，我明明调的夜间模式，<name>却像阳光一样耀眼，明明下载了国家反诈中心APP，可是心还是被<name>骗走了！",
  "糟了，<name>是从左心室开始,新鲜的动脉血液从左心室经体动脉被压出，经过全身组织与组织各处完成氧气与二氧化碳的交换后有动脉血变为静脉血，经由下腔静脉回到右心房，再进入右心房，通过肺动脉进入进入肺部的循环，将静脉血转化成动脉血，再由肺静脉进入左心房，最后进入左心室.之后血液由右心室射出经肺动脉流到肺毛细血管，在此与肺泡气进行气体交换，吸收氧并排出二氧化碳，静脉血变为动脉血；然后经肺静脉流回左心房的感觉",
  "🥵是、是的…♡我想<name>!我真的想要很多<name>♡🥵给我…好想要…想要见到<name>…♡呜呜、不行了,我已经变成看不到<name>就不行的笨蛋了……啊啊♡好喜欢♡更多的、可爱的<name>…是、哪怕有<name>也会觉得不够,什么时候都想要好多好多的<name>,除了<name>已经什么都想不了了……🥵",
  "（开着保时捷闪亮登场）（下车）今天也是帅哥（叼玫瑰花）（玫瑰扎到嘴）（强忍着）（推墨镜）（靠墙）怎样，ba……（滑倒）by…哎呦我（原地后空翻7200°接转体10800°左脚踩右脚，右手抓脚后跟，左手摸后脑勺一个前空翻稳稳落在老师面前比心）hi老婆",
  "<name>，你玩游戏吗？我帮你首充好不好🤤🤤🤤🤤",
  "<name>啊，我的<name>啊，站在我心中位置最顶点的少年啊\n你是我活着的意义啊，在这个世界，我没了你简直不敢相信，我该怎样的活着……\n你是我追逐的暗光啊，没了你，我不敢相信我会在无边的黑暗，怎么才能找到出路……\n你是我呼吸的空气啊，只力啊，我不能没了你啊，我真的好害怕失重感，只要接触不到地面，我就会陷入无尽的恐慌\n你是我鲜活的血液啊，我简直无法想象，你的消失会给我带了怎样的毁灭……\n你是我跳动的心脏啊，我不能没了你，你让我感受到我是活着的，你让我有信心走出黑那宽阔的胸膛吧。",
  "<name>，你失忆了，你是我老公。我们相识即一见钟情，相恋十年有余，第四年同居，两年后定下终身，得到我们两家长辈的祝福，结为秦晋之好，然天有不测风云，你被奸人所害，只因嫉妒我们夫妻幸福美满，家庭甜蜜和睦，后尔又为人所拐，一直杳无音讯。今日我特发此贴，正是望你知道真相。希望你知道，看到此贴的你，正是我消失了的丈夫，请速来联系我，让我们一家团聚!拯救我这个破碎的家庭，和我这颗千疮百孔的心!",
  "有人问我：“<name>是谁？” 我想了想，该如何形容<name>呢？ 莎士比亚的语言实在华丽，用在<name>上却有些纷繁了； 徐志摩的风格热情似火，可我不忍将如此盛情强加于<name>； 川端康城？虽优美含蓄，但<name>的活泼可爱我是藏不住的。 我不知道该如何形容<name>了。 但是我知道的。 <name>是我所面对的黑暗中的一点萤火； 是我即将冻僵的心脏里尚存的余温； 是我在残酷无情的现实里的避难所啊",
  "我路过花店，看到门口摆满了新鲜的郁金香。老板热情的迎上来，向我推荐她的郁金香，并告诉我红色郁金香代表爱情。我谢绝了，因为再好的郁金香也没有<name>的浴巾香​",
  "<name>的内衣是什么颜色？虽然听起来很唐突，甚至有些失礼，但请允许我解释一下。\n人类对于美丽的事物总是充满求知欲，在身心都被<name>俘获之后，却依旧愿意更深地了解<name>，这种品格很难不为之称赞。\n所以，我不得不再提出这个问题：<法兰西王室旗帜上圣洁绽放。\n......\n哦，<name>内衣的颜色。\n还有什么能比你牵起我更深的惆怅？\n你像是拉普兰德的极光，如梦荡漾。\n你像是哈雷彗星的锋芒，璀璨辉煌。\n你像是朦胧晨曦的登场，耀眼明亮。",
  "我在大学的时候学过一些医学。你在视频里虽然看起来还行，但其实是情感缺失的表现、像<name>你这样初期症状很不容易被发现，一旦发现就会是晚期难以治愈。最好的办法是给我发下你的WeChat，给我几张高清大图，我放大研究后，告诉你该如何对症下药。年轻人，宜早不宜迟 ",
  "登一下我女朋友的号，我是这个账号的男朋友，非账号主人。只是来看看她平时看的东西到底什么魔力可以让我的女孩睡觉都在笑，没想到居然会是这种类型的视频。她整天魂不守舍的，就是在嚷着等你出新视频。我好心劝告你，会做东西就多做一点，不要让我女朋友老是在等你出新视频，不满意的话欢迎来找我<name>，我随时奉陪。",
  "我养了一条小蛇，<name>挺怕它的，老是把自己的房门关的很紧。某天忘了关门，蛇进了他的房间，我只听见他叫了一声，跑过来抱住我，用哭腔委屈的告诉我：蛇，蛇进来了🥵",
  "😭😭😭今天早上老师怒气冲冲的进教室，一下就把作业摔在了讲台桌上，大声的质问我：“你的作业是怎么写的！？”我说：“是我自己写的。”老师更生气了，一把揪出<name>的作业本扔在我面前，问：“那你的作业为什么和<name>一样！”我只好羞愧的地下了头，老师继续质问，我再也忍不住了，大声喊道：“是我抄的<name>！是我抄的<name>！”🥵🥵 ",
  "猫是怎么叫的：喵喵\n羊是怎么叫的：咩咩\n牛是怎么叫的：哞哞\n狗是怎么叫的：<name>你吃了吗今天心情怎么样有喝水吗<name>你在吗为什么不回我消息呢<name>你今晚会回家吗我一个人在街上牵着脖子上链子不知所措了<name>我好想你啊<name>你超我吧<name>我超你也行<name>我今天发现自己变轻了原来是出门忘了带你给我的链子",
  "<name>……🤤嘿嘿………🤤……好可爱……嘿嘿……<name>🤤……<name>……我的🤤……嘿嘿……🤤………亲爱的……赶紧让我抱一抱……啊啊啊<name>软软的脸蛋🤤还有软软的小手手……🤤…<name>……不会有人来伤害你的…🤤你就让我保护你吧嘿嘿嘿嘿嘿嘿嘿嘿🤤……太可爱了……🤤……美丽me>🤤……嘿嘿……🤤我的宝贝……我最可爱的<name>……🤤没有<name>……我就要死掉了呢……🤤我的……🤤嘿嘿……可爱的<name>……嘿嘿🤤……可爱的<name>……嘿嘿❤️🤤……可爱的<name>……❤️……嘿嘿🤤……可爱的<name>…（吸）身上的味道……好好闻～❤️…嘿嘿🤤……摸摸～……可爱的<嘿🤤……抱抱你～可爱的<name>～（舔）喜欢～真的好喜欢～……（蹭蹭）脑袋要融化了呢～已经……除了<name>以外～什么都不会想了呢～❤️嘿嘿🤤……可爱的<name>……嘿嘿🤤……可爱的<name>……我的～……嘿嘿🤤…… ",
  "<name>！！有什么样的情有什么样的爱👫👫👫用什么样的爱还什么样的债💧💧💧我知道你的心里有些想不开🙅🏻‍♂️🙅🏻‍♂️🙅🏻‍♂️可是我的心里满满的全是爱❤️❤️❤️你回头看看我🤦🏻‍♂️ 不要再沉默🙇🏻‍♀️🙇🏻‍♀️🙇🏻‍♀️你说到底你想追求个什么结果我知道你在躲 你为什么不说😡😡😡你情愿让这样的思念把我淹没🏊🏻‍♀️🏊🏻‍♀️🏊🏻‍♀️",
  "<name>！那天在考场上，我正准备用最后一支油笔芯，结果在我后面的你抢走了，我直接崩溃大哭:“我的芯！我的芯！你抢走了我的芯！”😭😭😭😭",
  "<name>，今天物理光学开始讲光的特性了，物理老师说光是频率极高的电磁波；又说光是粒子，因为有粒子特性，光到底是什么？\n原来\n光是想你就用尽了全力",
  "考试的时候我抄<name>的答案🥵<name>一直挡着说 不要抄了 不要抄了🥵当时<name>的眼泪都流下来了🥵可是我还是没听<name>说的🥵一直在抄<name>🥵然后我还抄的更厉害🥵<name>都要叫出来了🥵",
  "<name>给我洗了一盘葡萄，我吃了一个酸的赶紧吐出来，口水留个不停，看<name>快生气了我连忙解释“<name>！太涩了，太涩了。”🤤",
  "今天去上课，发现笔忘带了，但是是什么笔忘带了呢？原来是<name>的无与伦比🤤",
  "<name>，我真的好爱你😍。可是我不敢说😭😭。无数个清晨，似是被什么遥远的呼唤打动，双眸定睛后，闪烁起异彩🤩。大概是有所领悟，出门，打开信箱，拿到信纸便逃也似地跑进房间🤤。小心地将那久别的寄信人名称纳入眼底，随之而来的，不可抑制。再转一瞬竟衍生出了同情心，然后阖上双眼，想要忘却什么似的再度入眠。醒后，打开手机，动态中没有你的踪迹，手里被汗水儒湿的信封上写的也不是你😭😭😭😭。这个秋天，没有邀请函，也没有你。我狼狈地把信塞回信箱。趁着周遭无人。可是我不敢说😢。<name>，我真的好爱你。😭😭😭😭😭😭",
  "昨天去上幼儿园的时候，老师让我们每人带一株植物去上课，我带了一把很好看的小草，结果被<name>抢走了，我对着他大哭，喊到:给我草草！！给我草草！！😭😭😭😭😭😭😭😭😭😭😭😭😭😭😭😭",
  "和<name>做顶流，我顶他流",
  "我是<name>的大肠杆菌,每天都做着最肮脏的工作,我知道自己配不上<name>的爱,也从没奢望过什么。但是,我依旧很开心,因为这里好深,从没有人来过,就好像我占据了<name>的身体一样。🥵🥵",
  "<name>上班后的第一份工作是送外卖，但是不熟悉岛上环境总是迷路。\n中午点了一份外卖，半天了送不来，他把我超时了。​",
  "今天给<name>写了一首藏头诗：我爱<name>咦？我的诗呢？原来是我对<name>的爱根本藏不住",
  "<name>！我命运般的阿芙洛狄忒，塞纳河畔的春水不及你，保加利亚的玫瑰不及你。你是神灵般的馈赠，你是上帝赐予我拯救我，使我的灵魂受到洗礼与升华。你是我黯淡升华中一束光亮，是你照亮了我黑暗的生命，你为我黑白的世界填满色彩，使我得到，我在5号21楼的阳台跳起探戈。太美了，你是神，我被美到泪流不止，喷涌而出。我的眼泪从眼眶里高压喷射出来打穿屏幕，飞过珠穆朗玛峰，飞过东非大裂谷，飞出太阳系遨游九天；汇成亚马逊河，汇成银海星汉，在我热烈滚热的心头成云成雾，倾斜而下，席卷四方！",
  "2005年出生于地球 \n2010年就读于美哈佛大学 \n2011年加入海豹击突击队 \n2012年前往南极实地考察成果颇丰 \n2016年被提名可以改变世界的人 \n2022年放弃一生荣誉 求做<name>的狗",
  "<name>，今天我们物理开始讲磁力了，物理老师说钢、铁、镍一类的东西都能被磁化，我听完就悟了，大彻大悟。\n课后我问老师：“老师，是不是钢和镍都可以被磁化？”\n老师笑了笑，说：“是的。怎么了？”\n我赶忙追问：“那我对<name>的爱是不是也可以被磁化？\n老师疑惑了，问为什么？\n我笑着，红了眼眶：“因为我对<name>的爱就像钢铁打造的拖拉机一样，轰轰烈烈哐哐锵锵。”",
  "<name>这名字可真难,倒不是笔画繁琐,只是写名字时得蘸上四分黄昏 ,三分月色,两分微醺,还有一分<name>的可爱动人才好。",
  "<name>！请问你是怎么穿过皮肤和黏膜的阻隔 在分泌物中的溶菌酶和巨噬细胞的吞噬中存活 还躲过浆细胞分泌的抗体或者致敏T细胞分泌的淋巴因子 住进我心里的 ？",
  "<name>，俺是农村嘞，村里人都说俺精细，以前感觉没钱配不上你。俺可稀罕你，就给那风儿，吹过俺家地头。地里老红薯都知道俺喜欢你。真嘞！恁看见喽给俺回个话，谁欺负你我给他拼命！俺可喜欢你，嫁给俺吧。中不中？",
  "口水不会白流，理论上讲，它们蒸发成云，总有一天能降落到<name>的鼻尖🤤🤤🤤",
  "电梯遇到了<name>，我按了八层，转眼看到他脸红了，然后他反手按了四层还傻笑，我看他八层四喜欢我☺️",
  "今天在超市见到<name>在卖橄榄\n我高兴地上去打招呼\n但是太紧张了\n只说出了：“<name>……橄榄……我……”",
  "本来想打开键盘开喷的，没想到真的喷了好多😭😭😭我知道爱<name>是我的命运😭",
  "村里有两把弓，一把是新的弓，一把是很老旧的弓，那把老旧的弓上面常年有辣椒油。一天我去练弓的时候，新的弓被其他人拿走了，我只能拿那把老旧的弓，谁知辣椒粉弹进了眼睛，我疼的大叫：“老弓辣，老弓辣”",
  "刚刚看这个视频的时候网络有点不好，它说“正在缓冲”，胡说，<name>明明在爆冲🥵🥵",
  "20岁就拥有了<name>这样的老公，我能像今天这么成功，首先我要感谢我的父母，要不是他们给了我这张嘴，我也不会在这胡说八道",
  "昨天我送<name>一件衣服，<name>兴奋地打开，发现是supreme！但仔细一看其实是superme。<name>失望地说：“为什么买盗版，真小气。”我摸着<name>的头，温柔的笑着说：“小傻瓜你翻译一下。”“超……超我。”<name>抬头望向我，脸上泛起了红晕☺️。",
  "当年他坐我后桌，总是喜欢在后面说我直到我不耐烦，转过头他一脸坦然地说要抄我的作业，真是的，明明他才是考试成绩最好的那个。某天老师发现了，问我俩谁抄谁的，全班大喊，「<name>抄她！」老师的看向我，我小声说，「是…是我抄<name>。」抄的她。」\n一秒的寂静之后，全班都炸了",
  "今年是得阿尔兹海默症的第十年。我感到许多东西正在离我而去。我先是忘记了那些精丽的辞藻，然后又忘记了那些复杂的句式。接着忘记了语法，最后，我只能用一些破碎的词汇来表达自己了。记忆也在离我而去，我现在唯一记得的是我身边这个深爱着的人：<name>。我想趁自己尚能动弹陪她去趟超市，到了我这个年岁，所有平凡的时光都是一种生命的恩典。于是我对<name>说：<name>，超市，我",
  "那天过安检的时候，保安把我拦下来了，说要搜身。我大喊一声“哪有什么违规物品！这是我爱<name>钢铁般的意志！",
  "这一段视频真的奇怪,不是可爱风不是怨夫风不是性感风也不是元气风,而是我看了<name>马上疯☺️☺️☺️☺️☺️😱😱😱😱",
  "<name>你是独生子吗？不是的话为什么不让我看看你弟弟啊",
  "没关系😁😁😁我不缺钱\n是我对不住你\n没有没有😌😌😌<name>幸亏☺☺咱们没领证😉,领了证😥😥😥,我耽误你一辈子😝😝😝\n我走啦\n😞😞😣😣\n你保重啊\n你也保重\n再见🚖🚶‍♀️🚶‍♂️\n再见😞😞😞还会再见吗🥺🥺🥺<name>,再见的时候你要幸福😄😄😄己幸福🥺🥺🥺\n<name>😨😨😨\n<name>😫😫😫🚖～～🏃‍♂️\n<name>😭😭没有你我怎么活啊🚗……<name>🏃…<name>🏃……<name> 🧎没有你我还怎么活啊😭\n啊啊啊啊啊啊啊😭😭😭😭😭😭😭<name>,你把我带走吧,<name>!😭😭😭😭",
  "🥰不懂就问<name>是意大利和中国混血吗？\n不然怎么长得这么像我的\n意❤️中❤️人",
  "有一天我喝醉了大声喊:“我要嫁给<name>！”这时我老公皱了皱眉，温柔的给我盖好被子，然后亲了我一口又凑到我耳边说“嫁给我一次了，还想嫁给我第二次？",
  "今天取快递的时候碰到了<name>，直接把他装到了我的小推车里，<name>很吃惊的问我干嘛，我一边推车狂奔，一边对他说：“我取你啊，我取你啊！”",
  "本人不懂二次元，对于你们这种痴迷于虚拟角色的行为，我很是不理解，我感觉应该分清现实和虚拟，他们好看归好看，但终究不是真实存在的，我们要活在现实，而不是盯着纸片人，我的生活很充实，今天是我和<name>的婚礼，大家记得带点彩礼",
  "是我的错觉吗？感觉最近网上土味情有点泛滥。。。\n算了，我只是<name>的狗罢了，为什么要思考这么高深的问题😝",
  "<name>好帅🥵帅到我想给他买套房，但是由于经济原因，我决定先买套再买房🥵🥵🥵🥵🥵",
  "弗洛伊德曾经说过，人的精神由三部分构成，本我，自我和超我，前两部分我都有，我觉得<name>能给我第三部分☺️☺️",
  "当年他坐我后桌，总是喜欢在后面说我直到我不耐烦，转过头他一脸坦然地说要抄我的作业，真是的，明明他才是考试成绩最好的那个。某天老师发现了，问我俩谁抄谁的，全班大喊，「<name>抄她！」老师的看向我，我小声说，「是…是我抄<name>。」\n此时<name>从桌子上抬起头，因为趴着睡觉头发有些凌乱，他眼里带着困意，声音带着刚刚睡醒的哑，撑着脑袋望着我，漫不经心地说「嗯，我抄的她。」\n一秒的寂静之后，全班都炸了",
  "接触网络前，我是个自卑腼腆的人，连和人说句话都不敢，感谢网络，让我变得开朗自信，我现在已经狂的不是人了，嗨,<name>,我的老婆",
  "<name>老婆🥵🥵🥵好美啊❤️❤️❤️绝了美到眼泪从嘴角流出淹成钱塘江大潮太美了你是神👼🏻👼🏻👼🏻是我的玫瑰🌹🌹🌹你照亮了我黑暗💫💫💫的生命让我的世界🌈🌈🌈有了意义我飞跑🏃‍♀️🏃‍♀️🏃‍♀️我猛跳我在20楼的阳台跳起了探戈💃🏻💃🏻💃🏻你让我意识到神确实存在我被美💗💗💗💗到泪流不止从此世界不再缺水 🌊🌊🌊🥰🥰🥰🥰🥰🥰🥰",
  "我对<name>的爱就像钟薛高，即使炽热也从未消融",
  "我给了三人一些钱，让他们买能把屋子填满的东西，第一个人买了干草，但根本铺不满。第二个人买了一支蜡烛，我指着蜡烛的影子说这里还是没满。第三个人买了一张<name>的照片，我直接冲的满屋子都是",
  "想当<name>家的电梯，这样<name>出门就可以出入我的钢门了",
  "\n我跌跌撞撞回到家中，打开B站，食指似卡壳的机械般滑动着界面，手机的微光打湿了我的眼睛。我不甘心，我又一次失去了探求美的资格，正在我泣不成声时，这个视频就出现在了我的B站首页",
  "<name>今天吃什么呀\n汤圆也好次喔～(=・ω・=)\n我看着眼前的一颗小汤圆，眼中尽是<name>。又白又嫩又滑是<name>的脸蛋，又暖又香又甜是<name>的笑颜。比芝麻馅更甜腻，比芋泥馅更醇厚，比水果馅更清新，这不就是我心心念念的<name>吗。\n我满怀幸福吃下这颗小汤圆，心中尽是<name>。\n啊～～～～\n汤圆也好次喔～(=・ω・=)\n<name>今天吃什么呢",
  "我有句话想要说！<name>实在是可爱！ 喜欢喜欢超喜欢！果然还是喜欢！ 好不容易遇见的公主大人！ 是我生于世上唯一的理由！ 那就是为了与<name>相遇！ 和我一起度过余生吧！ 我比世上任何人都爱你！ 阿！姨！洗！铁！路！",
  "今天我去给<name>买生蚝，回家的路上，生蚝全都跳出袋子，钻到了泥土里，我才知道，蚝喜欢泥😍",
  "想当<name>的宿舍宿管，这样就可以每天查<name>的应到与实到🥵🥵🥵",
  "今天到医院检查体重。发现竟然比平时少了500克。仔细一想。原来是冲给<name>的忘记算了🤤🤤🤤🤤",
  "有一天,我在骑车,看到<name>在前面,我二话没说,超了过去,结果<name>痛骂到：超我什么？？超我干什么？？？为什么超我？？？",
  "每次看到<name>就像看到了查重率0%的文案，忍不住狠狠抄了🥵🥵🥵🥵🥵",
  "今天在超市见到了<name>\n开心地过去打招呼\n但是太我紧张了\n我开口结结巴巴地说道:我...超市...<name>",
  "我居然和<name>是邻居啊啊啊啊啊啊啊 昨天回家在一户门外看到一串钥匙忘记拔了，我想应该是这家主人不小心忘记了吧，于是我就去敲门提醒一下。\n门一开我听声音就懵了，我问：是<name>吗?\n我说了事情的原委，还告诉他自己是他的邻居和粉丝，然后他竟然邀请我到家里坐！<name>真的，比我想象的要可爱！性格也很温柔，吃完饭坐在客厅里聊天 他说我俩可以留个vx啊啊啊啊啊啊啊啊啊啊啊啊啊啊\n真的太开心了编的我自己都差点信了",
  "黄桃罐头保质期是15个月，可乐要在打开后24小时喝掉，吻痕大概一周就能消失。两个人在一起三个月才算过了磨合期，似乎一切都有期限。这样多无趣。我还是喜欢一切没有规律可循的事情。比方说我躺在树上看天空，<name>突然就掉下来砸在我怀里。",
  "<name>……🤤嘿嘿………🤤……好可爱……嘿嘿……<name>🤤……<name>……我的🤤……嘿嘿……🤤………亲爱的……赶紧让我抱一抱……啊啊啊<name>软软的脸蛋🤤还有软软的小手手……🤤…<name>……不会有人来伤害你的…🤤你就让我保护你吧嘿嘿嘿嘿嘿嘿嘿嘿🤤……太可爱了……🤤……美丽可爱的<name>……像珍珠一样……🤤嘿嘿……<name>……🤤嘿嘿……🤤……好想一口吞掉……🤤……但是舍不得啊……我的<name>🤤……嘿嘿……🤤我的宝贝……我最可爱的<name>……🤤没有<name>……我就要死掉了呢……🤤我的……🤤嘿嘿……可爱的<name>……嘿嘿🤤……可爱的<name>……嘿嘿❤️🤤……可爱的<name>……❤️……嘿嘿🤤……可爱的<name>…（吸）身上的味道……好好闻～❤️…嘿嘿🤤……摸摸～……可爱的<name>……再贴近我一点嘛……（蹭蹭）嘿嘿🤤……可爱的<name>……嘿嘿🤤……～亲一口～……可爱的<name>……嘿嘿🤤……抱抱你～可爱的<name>～（舔）喜欢～真的好喜欢～……（蹭蹭）脑袋要融化了呢～已经……除了<name>以外～什么都不会想了呢～❤️嘿嘿🤤……可爱的<name>……嘿嘿🤤……可爱的<name>……我的～……嘿嘿🤤…… ",
  "发病最严重的一次,躺在床上,难受的一直抓自己眼睛,眼睛越来越大都要炸开了一样,我真的想<name>想得要发疯了。我躺在床上会想<name>,我洗澡会想<name>,我出门会想<name>,我走路会想<name>,我坐车会想<name>,我玩手机会想<name>,我盯着网上的<name>看,我每时每刻眼睛都直直地盯着<name>看。<name>,我的<name>😭😭 <name>,我的<name>😭😭",
  "我的<name>～😍😍😍，你是东半球😔，我是西半球😞，我们在一起就是整个地球🌐🌐😁。你是暖气团☁️☁️☁️☀️，我是冷气团🌙🌨️❄️❄️，遇到你，我止不住眼泪💧💧🌧️。除了冷锋❄️就是暖锋☀️，希望我们的关系，可以变成准静止锋🌊🌊。就算黄赤交角变成90度🛐🚺，也不会放开你的手🤝🤝🤙👄👄。你是❤️❤️塔里木盆地⛄👨👧👧👩👦👦💦，我是太平洋水汽♨️♨️♥️，我长途跋涉竭💃🏻💃🏻👯♀️尽全力去靠近你却永远无法💇🏼♀️💇🏼♀️达到你的心里💔💔。你在北极🌦️🌦️⛈️,我在南极🌦️🌦️。相隔一万九千九百九十八千米👨👩👧👧",
  "黄桃罐头保质期是15个月,可乐要在打开后24小时喝掉,吻痕大概一周就能消失。两个人在一起三个月才算过了磨合期,似乎一切都有期限。这样多无趣,我还是喜欢一切没有规律可循的事情,比方说我躺在树上看星空,<name>突然就掉下来砸在我怀里",
  "我都懂 我都明白 我是选项E 我是PlanB 是分叉的头发 洗衣机流出的泡沫 超市里被捏碎的饼干 是吃腻的奶油 是落寞的城市 是地上的草 我是被踩踏的 是西装的备用扣 是被雨淋湿的小狗 是腐烂的橘子 是过期的牛奶 是断线的风筝 是被随意丢弃的向日葵 是沉默寡言的小朋友 我是 我是 我是<name>的狗!",
  "<name>问我：“你有多爱我？”\n我说：“大概有300克。\n<name>笑了，说“这好老套，这个我知道，你想说300克代表的是心脏的重量对不对？“\n我也笑了，<name>这个小笨蛋，他不知道，300克其实是我一天对着他冲出来的量",
  "<name>啊，我的<name>啊，站在我心中位置最顶点的少年啊\n你是我活着的意义啊，在这个世界，我没了你简直不敢相信，我该怎样的活着……\n你是我追逐的暗光啊，没了你，我不敢相信我会在无边的黑暗，怎么才能找到出路……\n你是我呼吸的空气啊，只要一看不见你，我就会无比的窒息，我将无法喘息……\n你是我稳定的引力啊，我不能没了你啊，我真的好害怕失重感，只要接触不到地面，我就会陷入无尽的恐慌\n你是我鲜活的血液啊，我简直无法想象，你的消失会给我带了怎样的毁灭……\n你是我跳动的心脏啊，我不能没了你，你让我感受到我是活着的，你让我有信心走出黑暗，你让我有了慰藉，你让我感受到了所谓的安全感，你让我看见了别具一格的风景，你这与众不同的美丽风景。\n我心爱的<name>啊，你就像沙漠的流沙，让我越陷越深无法自拔，别人怎么拉也拉不起来……所以请让我陷入、沉入、坠入你那宽阔的胸膛吧。",
  "手机越来越不好用了，我明明调的夜间模式，<name>却像阳光一样耀眼 明明下载了国家反诈中心APP，可还是被<name>骗走了心。🥰",
  "不去寻找<name>的消息，不在意<name>而活下去，\n我根本就做不到。我的生活已经被<name>变得苍白了，在没有<name>而兀自流逝了不知道多久的时间里，什么也没发生。如果就这样断绝与<name>有关的一切的未来的话，从今以后的人生恐怕仅仅一张作文纸就可以作结。\n现在的我除了<name>以外，什么也没有。\n身上这层皮里装的不是血与肉，而是<name>。\n我想<name>，想<name>想地发了疯似的抓着头皮，一口气的松懈也会渗出泪来。\n我知道我这是自顾自的念想着她，可就算是那样，就算是那样。\n想得到回报就是那么的有错吗？",
  "我喜歡<name>，為什麼是繁體😊因為不是簡單的喜歡🥵🥵",
  "昨天考试,最后的 作文主题是歌颂,我第一时间就在答题卡作文栏写下了“我爱<name>”,所谓文思泉涌、一气呵成,写完后我望着陷入了沉默,最后悍然在监考老师眼皮子底下把试卷撕了,因为有些爱注定是不能用分数来衡量的。",
  "我不想喜换<name>了。         原因有很多。      他是屏幕那头的人，我是屏幕这头的人，两条平行线注定碰不到一起。         他是为了挣我的币才与我接触，平日专注。         他是受万人喜爱的宝藏男孩，我只不过一介平凡少女，无论我多么喜欢，在他那里注定得不到任何正反馈……         我想通了，决定放弃。         下一个视频略过，视频通通删干净，眼不见心不烦，还能留出时间卷学习成绩，这不是好事一桩?         第二天，我正常起床，洗漱，吃饭，没什么变数。我换好衣服，准备出门。         当我踏出门外的那一刻，我才意识到，坏事了。         我不知道该往哪个方向迈出下一步了。                 平时一览无余的街道，现在竟然充满了迷雾。我仿佛是没有罗盘的一艘船，在茫茫大海里打转。四面八方都是海水，都是一样的蓝，我该往哪走? 我要去哪? 我要干什么?          船没有了罗盘，我丢失了方向，人生缺少了目标。         这是很可怕的一件事，我至此以来做过的所有事情都化为了泡影，没有了意义，全部灰飞烟灭。         路边跳过一只橘色的猫，看了我一眼，好像在嘲笑我的落魄。         我害怕了。我逃回家里，打开电脑手机，把视频打开，把他的声音听了无数遍，直到午夜之时我沉沉睡去。          梦里，我恍然大悟。         人总要有个盼头，有个让你追逐的东西。它可以赋予你的努力以价值。         原来这就是存在的意义啊，我所做的一切，不就是为了追逐，为了让他能笑着对我说，多亏了你, 我才能来到这片未曾踏足的领域？          没错，他与我确实是不可能的，但是他却让我的生活拥有了动力与目标。          我不想喜欢<name>了。         原因只有一个。         我已经爱上<name>了。",
  "<name>今天想用什么电？水电火电核电︎还是群友发的电💈？",
  "今天在超市见到了<name>\n开心地过去打招呼\n但是太我紧张了\n我开口结结巴巴地说道:我...超市...<name>☺️☺️☺️",
  "一次<name>要出门，提着个篮子，我便问他要去哪里，他笑了笑对我说:“超市里，扫货”🥵🥵🥵",
  "想和<name>去100个城市来99个拥抱看98场日落要97次接吻拍96张照片买95朵玫瑰去94家餐馆看93次大海走92条小巷打91次雨伞还要90场牵手种89个草莓盖88次被子递87杯温水热86次剩饭看85次电影做84顿午饭切83个水果吃82次甜品喝81次暖茶要80次的拥抱吃79遍烧烤烤78次肉串涮77次火锅来76次海鲜吃75种小吃参74场晚宴喝73杯喜酒吃72次西餐尝71颗糖果给你70枚香吻荡69遍秋千看68次日出躺67次草地看66次星空闻65次头发抱64次肩胛吻63次脸颊亲62次锁骨咬61次耳朵然后60次相拥看59场鬼片喝58杯奶茶吃57桶米花逛56个商厦打55次的士坐54次公交等53次地铁开52次自驾站51遍路灯睡50次怀里去49个鬼屋看48场表演逗47只动物坐46次飞车玩45次激流滑44次滑梯坐43次飞椅转42次陀螺吊41次吊索然后40个接吻捂39次肚子揉38次肩膀捶37次后背捏36次小腿暖35次脚丫摸34次脑袋撮33次肋骨挠32次手心逗31场大笑然后30次拥吻放29个气球钓28只大鱼玩27次飞镖放26次风筝冲25次瀑布滑24艘小船蹦23场蹦极跳22次跳伞漂21次河流在20次么么骑19次单车看18场大雪玩17遍飞艇去16次森林探15个峡谷踏14个小溪爬13座高山看12个沙漠坐11次轮船写10封情书唱9首情歌堆8个雪人摘7朵野花看6场流星许5个愿醉4次酒养3只狗吵2场架然后爱他1辈子❤️❤️❤️",
  "<name>，我真的好爱你😍。可是我不敢说😭😭。无数个清晨，似是被什么遥远的呼唤打动，双眸定睛后，闪烁起异彩🤩。大概是有所领悟，出门，打开信箱，拿到信纸便逃也似地跑进房间🤤。小心地将那久别的寄信人名称纳入眼底，随之而来的，不可抑制一般的喜悦感几乎是震撼了自己。不禁有些恐慌，继而无端的恐慌转变成了更深邃的失望😢。我对自己还对这样一份残存的感情抱有期待而感到悲哀，为自己这样轻易地发生心境变化而懊恼。下一个瞬间几乎是想要杀死自己😭😭。再转一瞬竟衍生出了同情心，然后阖上双眼，想要忘却什么似的再度入眠。醒后，打开手机，动态中没有你的踪迹，手里被汗水儒湿的信封上写的也不是你😭😭😭😭。这个秋天，没有邀请函，也没有你。我狼狈地把信塞回信箱。趁着周遭无人。可是我不敢说😢。<name>，我真的好爱你。😭😭😭😭😭😭",
  "α 阿尔法， β 贝塔， γ 伽玛，δ 德尔塔， ε 伊普西隆， ζ 泽塔， η 伊塔， θ 西塔， ι 约塔， κ 卡帕， λ 兰姆达，μ 米欧 ，ν 纽， ξ 克西， ο 欧米克隆， π 派， ρ 柔 ，σ 西格玛， τ 陶 ，υ 玉普西隆， φ 弗爱， χ 凯， ψ 普赛     ♡<name>🤤🤤🌹🌹",
  "<name>，今天我做了IMBT测试，他们说我是IMBT，遇见你我才明白了I'M BT🥰🥰🥰",
  "我是一个非常喜欢吃生蚝的人🥰🥰🥰但是最近几个月超市的生蚝被我吃完了😩😩😩我只能画蚝充饥😔😔😔我去颜料店买了画生蚝的颜料😇😇可是这时一个一直泼我颜料名字叫<name>的男人走了过来😡😡😡打翻了我的颜料😭😭😭我大喊“老泼！！老泼！！蚝色！！蚝色！！”",
  "艾草对身体好,我试着买了点艾草回家做成糍粑,可是我一个人做得太累了,所以我决定叫上<name>一起做,我找到他,说：“我们一起做艾粑!“",
  "第一次這個麼早😍😍😍<name>我要給你裝上監視器、😚😚監視你的一舉一動😋😋😋我要給你裝上竊聽器，你的一言一行都是這麼的泌人心脾😍😍😍我要舔你家的浴缸🛁🛁🛁我要用你的牙刷😘😘😘你是我的🤑🤑🤑你不能和別人講話😭😭😭你只能屬於我🤤🤤🤤❤️❤️❤️❤️❤️💝💝💝",
  "昨天我送<name>一件衣服，<name>兴奋地打开，发现是supreme！但仔细一看其实是superme。<name>失望地说：“为什么买盗版,真小气。”我摸着<name>的头,温柔的笑着说：“小傻瓜你翻译一下。”“超……超我。”<name>抬头望向我,脸上泛起了红晕☺️",
  "那天我和<name>赛跑,本来我是跑在<name>前面的,可是后来还是被<name>狠狠地拽着狗链从后面把我超了\n",
  "各个视频的评论区偷的，别被屏蔽qwq",
  "没关系😁😁😁我不缺钱\n是我对不住你\n没有没有😌😌😌<name>幸亏☺☺咱们没领证😉,领了证😥😥😥,我耽误你一辈子😝😝😝\n我走啦\n😞😞😣😣\n你保重啊\n你也保重\n再见🚖🚶‍♀️🚶‍♂️\n再见😞😞😞还会再见吗🥺🥺🥺<name>,再见的时候你要幸福😄😄😄好不好,<name>😢你要开心😧😧你要幸福好不好,开心啊🥺幸福🤧🤧\n你的世界以后没有我了😰😰😰没关系你要自己幸福🥺🥺🥺\n<name>😨😨😨\n<name>😫😫😫🚖～～🏃‍♂️\n<name>😭😭没有你我怎么活啊🚗……<name>🏃…<name>🏃……<name> 🧎没有你我还怎么活啊😭\n啊啊啊啊啊啊啊😭😭😭😭😭😭😭<name>,你把我带走吧,<name>!😭😭😭😭",
  "猫是怎么叫的：喵喵\n羊是怎么叫的：咩咩\n牛是怎么叫的：哞哞\n狗是怎么叫的：首先我不是男同，我对<name>确实没有什么幻想，毕竟我不是男同。但是该说不说的，<name>真的腿长气场强，我真的不是男同，有一说一，确实很好看。我也确实说不喜欢男人，因为这个确实是挺美的，我就不是男同。但是怎么说，一看到他，心里就痒痒的，类似一种原始冲动，就像看到影视剧里看到多年未见的老友的重逢，一段崭新情缘的开端一样，激发人向美向善最淳朴的一面。就像登上山峰，目睹潮汐那般自然，仿佛冥冥之中自有天意就是一种朦胧的感觉，像伟大的革命友谊一样，令人憧憬。要是能和我牵个手亲个嘴就更好了🥵🥵🥵，毕竟我不是男同。​",
  "19岁就拥有了<name>这样的巨根老公，我能像今天这么成功，首先我要感谢我的父母，要不是他们给了我这张嘴，我也不会在这胡说八道。😝😝",
  "<name>的内衣是什么颜色？虽然听起来很唐突，甚至有些失礼，但请允许我解释一下。\n人类对于美丽的事物总是充满求知欲，在身心都被<name>俘获之后，却依旧愿意更深地了解<name>，这种品格很难不为之称赞。\n所以，我不得不再提出这个问题：<name>的内衣是什么颜色？可惜囿于认知水平的局限，只能停留在想象。\n是紫色的吗？像是普罗旺斯盛开的薰衣草花海般芬芳。\n是红色的吗？如罗曼尼红酒灌溉的长河一样纯粹馥郁。\n是白色的吗？宛如鸢尾花在法兰西王室旗帜上圣洁绽放。\n......\n哦，<name>内衣的颜色。\n还有什么能比你牵起我更深的惆怅？\n你像是拉普兰德的极光，如梦荡漾。\n你像是哈雷彗星的锋芒，璀璨辉煌。\n你像是朦胧晨曦的登场，耀眼明亮。",
  "我有时候确实觉得很烦，就连我的亲友都觉得我脾气有点暴躁了，却只是因为几件小事，比如自己的书掉在地上，糖不够吃了，晚上突然觉得想喝奶茶却喝不到，我都会大发一通脾气。但<name>从身后抱住我，说我这是婚前焦虑症，还亲了亲我的嘴角，我就觉得什么都美好了😭😭🌹🌹",
  "我真的想<name>想得要发疯了。我躺在床上会想<name>，我洗澡会想<name>，我出门会想<name>，我走路会想<name>，我坐车会想<name>，我工作会想<name>，我玩手机会想<name>，<name>我好想你<name>求求你多发动态吧没有你我可怎么办啊我的生命里不能没有你啊<name>我的<name>啊人总是贪心的，开始我也只是想和你说说话，最后却想把你占为己有可不可以给我一点勇气，让我对你说，我不能没有你我害怕再没有一个人像你一样直接且温柔的颠覆我的世界如果有一天我看不见你，我会发了疯似的满世界找你闭上眼，以为我能忘记你，但流下的眼泪，却没有骗到自己你离开以后，我的世界没有了任何颜色，连黑色都不曾施舍我只希望这个世界，可以很小很小，小到我一转身便能看见你你笑一次，我就可以高兴好几天；可看你哭一次，我就难过了好几年你永远也看不到我最寂寞时候的样子，因为只有你不在我身边的时候，我才最寂寞原来世界上真有这样的事，只要一瞬间，对一个人的喜欢就能到达顶点",
  "😭😭😭今天早上老师怒气冲冲的进教室，一下就把作业摔在了讲台桌上，大声的质问我：“你的作业是怎么写的！？”我说：“是我自己写的。”老师更生气了，一把揪出<name>的作业本扔在我面前，问：“那你的作业为什么和<name>一样！”我只好羞愧的地下了头，老师继续质问，我再也忍不住了，大声喊道：“是我抄的<name>！是我抄的<name>！”🥵🥵",
  "<name>，你是负二，我是负五，我们两个加在一起就是夫妻呀😭😭😭",
  "有一天<name>在跑步。我冲上去就把他绊倒了。他站起来继续跑，于是我又把他绊倒了。<name>问我：你想干嘛，我对他大喊：“我碍你！我碍你啊！”",
  "昨晚和朋友聊天的时候朋友问我：“你到底喜欢<name>什么啊？”，“喜欢一个人不需要理由”，我很快敲完了键盘，刚要按下回车的时候突然愣住了。真的不需要理由吗？时沙飞速倒流，几个月前的自己在名为迷失的波光中影影绰绰，她向我看来，眼里充满了羡慕和满足。原来我变了好多。是她的可爱让我捡起了记忆的碎片，回到那个春夏和秋冬，重温指尖上残留的感触。是她的努力让我寻回尘封了六年的铅笔，当初是为了喜欢的人而开始，现在也是因为喜欢的人而重启。是她的温柔和包容让我有勇气直面自己的心魔，不再逃避也不再畏惧。于是我删掉了刚才的那句不需要理由，敲了一行新的，按下了回车。“我喜欢<name>，因为是她让我变得更好。”",
  "昨天考试，我把<name>的名字写满了试卷，没想到今天卷子发下来才发现没有批改，老师说爱一个人没有答案，也不分对错",
  "我试图用那些漂亮的句子来形容你。但是不行，我字字推敲写出长长一段话，你眉眼一弯熠熠生辉就让我觉得。不行，这些文字写不出你眼里的星辰，读不出你唇角的春风，无论哪个词都及不上你半分的柔艳。<name>，你的双眸有遥远的冬雪，你的微笑有绚烂的夏阳，你一转身便有花开为你，你一低头便有星辰黯然，但没有你的日子，春夏秋冬，也只是被赋予“季节”的名义",
  "“本手、妙手、俗手”是围棋的三个术语。本手是指合乎棋理的正规下法；妙手是指出人意料的精妙下法；俗手是指貌似合理，但从全局看通常会受损的下法。但即便是如此精通棋术的我，看到<name>时，我就好像迷失了方向，感觉我的棋盘发生了天翻地覆的变化，变得难以捉摸，无从下手。这一手棋...该怎么下，该如何下呢。当我用了一个通宵的时间来想是什么原因的时候，我看着我自己这身经百战的双手，又想起<name>那迷人的微笑，终于想明白为什么了。在遇见<name>那天，我便有了那怦然心动的感觉。原来“本手、妙手、俗手”这三个以外还有一种。就是——<name>我想牵起你的手",
  "偷偷把朋友的英雄联盟名字改成了<name>，然后和她一起玩，我总希望对面有人来偷水晶，朋友会打字说我们家被偷了，这时我就很开心，原来我和<name>有个家🥰",
  "<name>啊……<name>啊！你就像那水里的鱼，而我像是只熊！我不去捞<name>我都不舒服！但这过程艰难且长久，不过！当我捞到<name>的时候，我会用我的舌头，把<name>身上的每一个角落都舔一边，然后用我的利牙，在你的脖颈上留下只属于我的印记。但这也是结果罢了，我现在依然没有得到你。所以，我，一直在盯着<name>🤤🤤🤤",
  "好想<name>带我学习啊，可是<name>说她喜欢和我贴贴，她笑了，我知道既大佬又可爱的她为什么要笑，因为她其实是我的老婆🥰",
  "<name>让我无所不能！忆往昔，<name>的手软软的，香香的，每天都要斯哈斯哈好几次。没了你，我该怎么活啊<name>，<name>……我的<name>！你真的好迷人啊，一天不看你我就浑身难受，<name>，<name>，<name>，<name>，我的<name>",
  "我的生活不能缺<name>，就像天空不能失去云。我是<name>的一片天空，她是那朵永不停息，忙忙碌碌的云。我是那孤零零的一片天，无心观鸟，无暇视下，只是等待着，希望云能从我这里路过。让风慢慢的吹，让云多留一会天空是可以没有云的，就像水可以没有鱼。但没有云的天空还剩下什么呢？只是一滩明澈的死水，再无半点涟漪。好像没有<name>的我，仿佛活行尸。但我仍旧只是那片孤零零的天，没有<name>的天，漆黑的天。火车的气笛是隆隆作响，而我却空空荡荡，今天<name>会来贴贴吗？",
  "原来如此……原来如此，原来如此原来如此原来如此原来如此！！大脑……大脑在颤抖！！如此强烈的宠爱！如此勤勉！被如此深爱着的你，真是勤——勉呢！！大脑颤抖颤抖颤抖！！但是，你居然没有来贴贴？你真是怠惰呢。怠惰怠惰怠惰怠惰！！大脑………颤抖颤抖…… 啊.....<name>.......",
  "我真的想<name>想得要发疯了，我躺在床上会想<name>，我洗澡会想<name>，我出门会想<name>，我走路会想<name>，我坐车会想<name>，我工作会想<name>，我玩手机会想<name>，我盯着路边的<name>看，我盯着荧幕里面的<name>看，我盯着地<name>粉丝群的<name>看，我盯着github里的<name>看，我盯着群里和别人聊天的<name>看，我每时每刻眼睛都直直地盯着<name>看，像一台雷达一样扫视经过我身边的每一个<name>要素，我真的觉得自己像中邪了一样，我对<name>的念想似乎都是病态的了，我好孤独啊，真的好孤独啊，这世界上那么多<name>为什么没有一个是属于我的！",
  "我的裤子老是被我弄破，于是我报了一个补衣服的班。有一天<name>教我们大家缝衣服，她问道：“谁的衣服总是弄坏”，于是我高高举起手向<name>大喊：“我的老破我的老破。”",
  "圣徒们曾用表达人类爱情的言辞来描绘他们心中的天主，所以我想，爱慕<name>的至情也不妨用祈祷和沉思冥想来诠释。在爱情中，我们同样会放弃记忆、理解力和智慧，同样会经历被剥夺的感觉，经历“漫漫长夜”，而作为回报，有时也会得到一份安宁。爱情的发生有如小小的死亡，恋爱中的人有时也会得享一点小小的安宁。<name>，我想听见你的声音。",
  "写情话真是一件温柔的事，细腻的小心思就藏在横竖撇捺之中，像是一只害羞的小兽躲在情意绵绵的字里行间，被火漆封印起来，等着解封的那一刻窜出来，跳进启信人眼底的柔波里。期待<name> 某天打开这封信，读遍我内心的欢喜。",
  "我忘不掉<name>了。\n如果不是知道了<name>，说不定我已经对这个世界没有留恋了。\n<name>真的好可爱啊。做料理的时候笨拙的样子很可爱，故意撒娇养gachi也很可爱，唱歌的时候很可爱，生气打艾玛的时候也很可爱。\n所以我离不开<name>了。如果早晨不是有<name>的起床闹钟的话，说不定我永远都不愿意睁眼了。如果晚上不是有<name>的贴贴预定的话，这一天我都不希望过完了。\n<name>的眼睛好灵动，如果能映照出我就好了。<name>的笑容好温柔，如果只为我一个人绽放就好了。<name>的头发好柔顺，如果能让我尽情抚摸就好了。\n<name>这样的存在真的是被允许的吗。\n只是像现在这样默念<name>的名字，我就觉得自己是世界上最幸福的傻子",
  "<name>，我真的好喜欢你啊，我渴望找到你，我就可以将我的无限的爱意告诉你。可是，你真的能来到我身边吗？冰冷的水底空空荡荡，钱塘江畔只有我考不上的之江校区，想和你拉钩，手指却触碰到硬邦邦的屏幕和cpu散发的余温。我走累了，哪里都不见你，你却早已化作0和1充满我的世界，你的爱也随着光纤来到我身边。我虽然走不动，我还是想回应你的爱，可我在键盘上敲出的数据，流向四面八方，能不能流进你的心里？我想更引起你的注意，只要我的爱无限大，那总有哪怕一丝一毫能被你看见吧。我想学老粉丝们写小作文，可我连说话都说不好；我想画同人图，笔尖绘出的却只是干硬的机械图；我想弹奏爱的乐曲，可我连五线谱都不会看。我如此的平庸，到头来连爱都表达不出来。",
  "<name>，我真的好讨厌你啊，自从遇见你，你给了我一颗精美的糖果，它是那么甜让我开始厌倦以前断齑画粥；你给我暖意让我逐渐不习惯下水道的冰冷潮湿；你发出的光照亮我阴暗的生活让我自己都开始厌恶自己。我冲出下水道的追寻你的光，可是，明明周围如此明亮，我却看不清道路，我甚至看不起自己的样子。我失望地回到家，我不忍心含下那颗糖，害怕它会融化消失；我不敢将你给的暖意搂入怀里，害怕我的冰冷身躯将它稀释；我不敢睁开眼睛，害怕看见被你照亮的我自己。\n我多希望你能注意到我，看见我对你的爱，5G那么快我还是害怕追不上时间，你是离我那么近却又那么远，我看得清你的微笑，却触摸不到你的心。一天劳累下来也该睡觉了，等明天起床有力气了，或许我还能喊出那句话\n<name>，我真的好喜欢你啊",
  "首先我不是<name>粉，但她真的很可爱。我对<name>确实没有什么幻想，毕竟我不是<name>粉。但是该说不说的，<name>，真的可爱死了，我真的不是<name>粉。有一说一，我也确实说不喜欢<name>。因为这个<name>确实是挺好看的，我就不是<name>粉，但是怎么说，一看到她，心里就痒痒的，类似一种原始冲动，就像看到影视剧里看到多年未见的老友的重逢，一段崭新情缘的开端一样，激发人向美向善最淳朴的一面。就像登上山峰，目睹潮汐那般自然，仿佛冥冥之中自有天意就是一种朦胧的感觉，像伟大的革命友谊一样，令人憧憬，要是能和我牵个手就更好了，毕竟我不是<name>粉",
  "兄弟们，跟你们说个事\n群友好像魔怔了\n整天<name><name>的喊，连做梦都在喊\n没事的时候就喜欢拽着我跟<name>贴贴\n我们群一半的人都中招了\n现在一有点风吹草丛，他们就在那鬼哭狼嚎的 \n“<name>~~~<name>~~~” \n太哈人了 我现在怀疑<name>是个什么传销组织\n她们的人说话都跟猜谜一样\n完全看不懂,但我又不敢报警\n群友威胁我说，要是我不和<name>贴贴,就把我家主人给砸了\n所以说....\n等等\n等等\n我家主人.....我家主人......\n主人...<name>...<name>！\n<name>我真的好喜....<name>到底是谁啊\n有没有懂哥....<name>…<name>....给我讲一下\n<name>到底是是....是....\n.....................<name>是我主人捏~",
  "<name>小姐昨天吃了酸菜鱼，可她不知道那是我。其实我就是那一条鱼。我从小就生活在海里，看海浪涛涛，听海风滚滚。海面上经常有渔民来打鱼，我知道那意味着什么。从我还是一颗小鱼苗的时候，就大鱼们说，不要去咬钩子，也不要跑到渔网里面。我很害怕，大鱼们说会有鱼被捞上去当场就被剖开，我想如果是我，那可能必死无疑了，我好怕死。但是从渔民口中听到什么“<name>”，什么“圣<name>之力”，什么“我想成为<name>小姐的狗”，可是什么是狗，是很厉害的生物吗，我想应该成为鲨鱼的。然后我看到她衣服上别着一个小勋章，上面一个裙子小女生。可能那就是<name>吧。偶然间的一瞥，我便爱上了那个小东西，我用我所谓7秒的记忆，将她铭记于心直到死去。我对<name>的思念与爱伴随着我的成长一直在长大。我听说鱼被抓上去是要被剖、被刀、被切成两半，被放入热油，被炸、被烤、被煎被煮！但是被抓上去也是唯一能见到人类的机会。我不怕死，我一定要遇见<name>。终于，可能是过了一年吧，那帮人，也可能是换了一波人，来抓鱼了。我毫不犹豫就游了过去，为了<name>，为了我的爱，为了我爱的她，虽然有千千万万条鱼，我知道我只是其中微不足道的一条罢了。可是这是我唯一的机会，我想要遇见她，我不怕死。我从来不想死，可为了<name>，我作为一条鱼，在人类手中我的结局只能是死于非命。我躺在砧板上，旁边的伙伴疯狂甩尾，而我很听话地一动不动，来了一个人，提着一把大刀，一下将我拍晕，我突然成为了灵魂升上天空。我的肉体已经不成模样，我从未见过有鱼变成这样。一瞬间，从渔民到杀我的人，他们所有的模样我都忘了。可是我的灵魂中已经铭刻了她的名字--<name>。我被放在了那种盘子上，看起来金黄，我不知道我的肉体成为了什么模样了。但是就在那一刻，她出现了。她就是<name>，我心心念念的，<name>。当她把筷子将我的肉体夹起那一刻，我的灵魂似乎在发光。她将它送入了嘴里--我的灵魂已经不再与我的肉体有关想，我的灵魂进入了高天之上，我看到里海里我伙伴们的嗤笑，我长辈们的哀嚎，我的爱鱼的哭泣，可是我没有任何的悲伤，因为唯有爱，是跨越物种跨越距离穿越时空的，我的灵魂已然得到所有境界和万种轮回里最为饱满的惬意与欣喜。当我回味着这一切的时候，我的灵魂开始从九天之上极速坠落于餐盘之中。灵魂要陨灭了。落在餐盘里的灵魂在消散前最后那一刻，我看到了<name>小姐皎然的笑颜",
  "什么是幸运？在遇见<name>前我每次都会犹豫地给出不同的答案，在遇见<name>后就有了标准答案。\n遇到<name>，就是此生最大的幸运了。\n<name>是秋天，是光源，是珍馐，是爱情，是捕获我躁动心脏的势阱，是造物主抽选人间所有美好摹刻的恶作剧。她的容颜有星辰的潋滟，她的发丝有江离的清香。她像病毒感染了我的一切，却又像天使治愈了我的一切。她浅笑，她轻唱，她眼里有光，她穿着可爱的灯笼裤。我已经是一个被生活中细微繁琐而又悄然堆积的失望磨平了棱角，习惯了退而求其次的人。即使不能拥抱，只要接近就好了；即使不能拯救，只要敷衍就好了；我知道朦胧的美好与清澈的苦楚，知道恋慕的准则与自贱的界限。我深谙一个管人观众的规范，可不要想<name>的条款我一刻都做不到。泥人说爱上<name>是灵魂的恶堕，可在爱上<name>前我甚至从没感觉到灵魂为何物。蚂蚁尚且会追寻糖分的踪迹，那我对<name>的迷恋怎么就是一出自陶自醉的荒诞闹剧呢？\n我过去常常反思我自己到底是什么角色，我会回答自己，一个尼特。太失败了。现在我会说，一个遇见了<name>的尼特。太幸运了。我光是躺在床上，默念<name>的名字，眉间被无尽的挫折碾出的沟壑都会变得柔和起来，觉得这人间全都是美好的事，就像<name>的存在一样。\n我知道我与<name>终将分别，像一只流浪猫一样在度过寒冬后悄悄离开有她的世界，可有这段短暂的守望就已经足够。如同是在伊豆遇见盛装的舞女，在湄公河遇见羞涩的情人，即使知道分别是必然的结束，但来之不易的陪伴已经成为足以回味一生的幸运。<name>，<name>，<name>——我的生命之光，欲念之火；我的罪恶，我的，灵魂。",
  "<name>，我真的好爱你。\n可是我不敢说。\n无数个清晨，似是被什么遥远的呼唤打动，双眸定睛后，闪烁起异彩。大概是有所领悟，出门，打开信箱，拿到信纸便逃也似地跑进房间。小心地将那久别的寄信人名称纳入眼底，随之而来的，不可抑制一般的喜悦感几乎是震撼了自己。不禁有些恐慌，继而无端的恐慌转变成了更深邃的失望。我对自己还对这样一份残存的感情抱有期待而感到悲哀，为自己这样轻易地发生心境变化而懊恼。下一个瞬间几乎是想要杀死自己。再转一瞬竟衍生出了同情心，然后阖上双眼，想要忘却什么似的再度入眠。\n醒后，打开手机，动态中没有你的踪迹，手里被汗水儒湿的信封上写的也不是你。这个秋天，没有邀请函，也没有你。我狼狈地把信塞回信箱。趁着周遭无人。\n可是我不敢说。\n<name>，我真的好爱你。",
  "我若能说万人的方言，并天使的话语，却没有<name>，我就成了鸣的锣，响的钹一般。 \n我若有先知讲道之能，也明白各样的奥秘，各样的知识，而且有全备的信念，叫我能够移山，却没有<name>，我就算不的什么。\n 我若将赈济所有的穷人，又舍身叫人焚烧，却没有<name>，仍然与我无益。 <name>是恒久忍耐，又有恩慈。<name>是不嫉妒，不自夸，不张狂。不作害羞的事，不求自己的益处，不轻易发怒，不计算人的恶。不喜欢不义，只喜欢真理。\n凡事包容，凡事相信，凡事盼望，凡事忍耐。 <name>是永不止息。\n我做<name>老婆的时候，话语像<name>，心思像<name>，意念像<name>。\n如今常存的有涩涩，有<name>。其中最大的，是和<name>涩涩。",
  "<name>，我要诵念你的圣名，你是我的太阳，你是我的天空，你是我的一切。\n<name>，我的<name>，我一切的信仰。\n<name>，是至高无上的，是我心中无可替代的存在。\n<name>所在，便是我心之所向，心之所在。\n啊，<name>，我的<name>，请你为我降下圣恩，<name>，请你赐予我你的爱，我必将用我凡人的方式报答你，<name>，我的神，我的圣女。\n<name>，我诵念你的名，我呼唤你的名，<name>，我的<name>，请你聆听我的诵念。你的圣名，是我此生不忘的圣经。\n啊，<name>，赐予我爱与祝福。\n<name>！",
  "我最想了解<name>，最想待在<name>身边，我希望我是最亲近你的人，我！讨厌、<name>在我不知道的地方笑！还有、和其他人牵手也是！只和我就好！我特别希望是和我在一起！庆典我也是好想去的！<name>看上去很开心的，笑著的，在你旁边有我！那样的才好！头好痛的、好难受的！我一直就只思考<name>的事情，感觉都要 发疯了…我也在等你打电话给我！你偶尔也主动开口嘛 主动和我说话嘛 我不想要总是我单方面找你 你多少也…你一点也不在意我吗？一点也不会吗？完全不会？我对你来说不重要吗？只是朋友吗？普通的朋友吗？我希望自己不是普通的朋友，就算比普通好一点也好，我想成为不普通的 朋友… 喂 <name> 我该怎么做才好？求你听我说话 你听到我的声音有什么想法吗？还是什么都好 拜托有点想法 我希望你可以有点想法 还是说我不该期待这种事？<name>！",
  "今天我把我的lol名字改成了“最爱<name>老婆”。\n对面的螳螂气急败坏地抓了我8次却全部失败。\n它愤怒地质问我是不是开挂了，为什么每次抓我孤立无援都不能触发。\n我告诉它我从来不是一个人，因为<name>老婆一直住在我的心里。",
  "“<name>居然让我当舔狗！”\n我吞了吞口水，壮起了胆子，慢慢的凑近她的脚 \n她没有反应，只是静静的欣赏着我的痴态 \n近在咫尺，我伸出舌头应该就能够到，那股清香闻的我有点晕\n思绪飘渺，我不由得刚张开嘴妄图想去品味\n不料她等的就是这一刻，把脚往前猛的一伸，不由分说的塞到了我的嘴里\n“呜呜呜呜呜”\n“怎么了？你应该很喜欢啊，笨狗\n“呜呜呜呜呜”\n如花般的清香混合着她特有香味弥漫在我的口腔以及鼻腔中，气味独特，直冲大脑，不行了，我要昏过去了\n我番起的白眼貌似被她捕捉到\n“别死过去啊”\n伴随着激烈的斥责，她扭动起脚腕，脚趾在我的口腔中疯狂的搅动，欺负着我的舌头\n疼痛使我清醒过来，我把舌头紧紧的贴在她的脚趾上，免得磕到牙齿，却有细细的品味出一丝咸味，更是欣喜\n“看看你自己的样子，真是变态”",
  "<name>，从上颚往下轻轻落在牙齿上，<name>~从口腔到唇舌，摩挲着想念、玩味与诱惑。\n多米尼克斯万是希腊神话里的海妖，一眼就把杰瑞米艾恩斯拉入不复深渊。她咬着指尖，自下而上看我，眼中满满都是装出来的蜜糖纯真，粘黏着我的皮肤。再贴近一点，哪怕一厘，我就能看见那隐藏着的如狐狸一般的狡诈神色，决不输于任何一个最恶毒的成年女人。\n可我的小宝贝是那样娇嗔的女孩，我忍受不了她如幼猫一样的撒娇。更何况她不过想要我的命，那送她便是了。",
  "那一年，我记忆犹新。她大学毕业，拥有了众多粉丝，让人羡慕。而我还有两年学业，平庸的我各项都不如她优秀，如果不出意外的话，我应该永远都学不会炒股。甚至都无法和她留在同一座城市。认清了这一点，我果断提出分手，只为了不成为她的绊脚石。可<name>死活不肯，一口一个爱我、无法离开我。眼泪像是断了线的珠子不停的往下掉，她的眼角都因为擦泪蹭红了。有那么一瞬间，我的信念动摇了，想着我也可以试试。但最终，理智占领了思想高地。我忍痛和她分手，并且拉黑了一切联系方式。\n一晃这么多年过去了，如今看到她依然这么幸福，我就已经很欣慰了。\n不过我过得也不错，精神病院里福利待遇很好，<name>也时常来看我。\n不说了，她给我打电话了，我们要一起去玩摇摇乐了。",
  "所以说，我觉得“笑容”是人类最难看的表情，你看，笑容需要牵动的脸部肌肉实在是太多了，整张脸被神经扯动，再娇俏的脸都变得如同酒后发病，难看至极\n但从文献中我看到了各路诗人对“笑容”的赞美，白居易说“回眸一笑百媚生，六宫粉黛无颜色”，苏轼说“美人微笑转星眸，月花羞，捧金瓯”\n老实说，我理解不了，我在生活里从未对这个表情有如此夸张的反应，实际上就连那“咯咯咯”的笑声，也令我十分心烦意乱。对，或许我是讨厌“笑”这个概念本身\n但我总是对理解不了的事物充满探索欲，我便开始探求这其中令这些诗人沉迷的地方。既然从现实无法探求，我便随作品出发好了\n一路上，我看过了蒙娜丽莎，酒神巴克斯，犹太新娘，一笑倾城。不，它们都无法诉说我想要的“美”，我迷惑了，我的旅途还未抵达终点，却已宣告终止\n我跌跌撞撞回到家中，打开B站，食指似卡壳的机械般滑动着界面，手机的微光打湿了我的眼睛。我不甘心，我又一次失去了探求美的资格，正在我泣不成声时，这个视频就出现在了我的B站首页\n我仿佛听到了命运之钟的摇摆声，咔嚓咔嚓，一切因果于此时收束，一切缘由在此刻得以揭晓，旅行的旗帜被重新纺织\n这个女孩，她便是因，是果，是我旅途的最终答案\n<name>的笑容，就是我的答案\n若是此时李白，苏轼，达芬奇等人与我把酒言欢，谈及他们对“笑容”的赞美，现在的我或许可以认可了但是，或许我也会起一些没有缘由的攀比之心，“或许你们几位大诗人大画家应该见一见<name>老师”",
  "昨晚和朋友聊天的时候朋友问我：“你到底喜欢<name>什么啊？”\n“喜欢一个人不需要理由”\n我很快敲完了键盘，刚要按下回车的时候突然愣住了。\n真的不需要理由吗？\n河里的时沙飞速倒流，站在岸边往里看去，几个月前的自己在名为迷失的波光中影影绰绰，她向我看来，眼里充满了羡慕和满足。\n原来我变了好多。\n是她的可爱让我捡起了记忆的碎片，回到那个春夏和秋冬，重温指尖上残留的感触。\n是她的努力让我寻回尘封了六年的铅笔，当初是为了喜欢的人而开始，现在也是因为喜欢的人而重启。\n是她的温柔和包容让我有勇气直面自己的心魔，不再逃避也不再畏惧，原来我，还有爱人与被爱的资格。\n神爱世，这是个谎言。\n能爱人的不是神，从来都不是，只有人能爱人。\n于是我删掉了刚才的那句不需要理由，敲了一行新的，按下了回车。\n“我喜欢<name>，因为是她让我变得更好。”",
  "猫是怎么叫的：喵喵\n羊是怎么叫的：咩咩\n牛是怎么叫的：哞哞\n狗是怎么叫的：<name>你吃了吗今天心情怎么样有喝水吗<name>你在吗为什么不回我消息<name>你今晚会回家吗我一个人在街上牵着脖子上链子不知所措了<name>我好想你啊<name>我今天发现自己变轻了原来是出门忘了带你给我的链子",
  "<name>，你内库是什么颜色？虽然听起来很唐突，甚至有些失礼，但请允许我解释一下。\n人类对于美丽的事物总是充满求知欲，在身心都被你俘获之后，却依旧愿意更深地了解你，这种品格很难不为之称赞。\n所以，我不得不再提出这个问题：你的内库是什么颜色？可惜囿于认知水平的局限，只能停留在想象。\n是紫色的吗？像是普罗旺斯盛开的薰衣草花海般芬芳。\n是红色的吗？如罗曼尼红酒灌溉的长河一样纯粹馥郁。\n是白色的吗？宛如鸢尾花在法兰西王室旗帜上圣洁绽放。\n......\n哦，你内库的颜色。\n还有什么能比你牵起我更深的惆怅？\n你像是拉普兰的极光，如梦荡漾。\n你像是哈雷彗星的锋芒，璀璨辉煌。\n你像是朦胧晨曦的登场，耀眼明亮。",
  "<name>最近涨了很多粉，这个现象不得不说惹人深思。在这个信息化的时代，人们想当然的认为媒体平台的发展能够得到更加丰富的信息量，这也意味着可以有更加全面和客观的认知，即便是隔着冰冷屏幕。但这条论断忽视了人性的因素，因为人是很容易受欲望支配的动物。举个例子，大家以为通过她的直播可以触及到她内心最为柔软的角落，全方位了解这个人。其实不然，大部分人是无法了解事物的全部的，就如同她现在对着屏幕笑，但屏幕那端的观众却无法看到躲在她桌子下面戴着项圈的我。",
  "我问三个罪犯，如何将囚禁他们的牢笼用东西填满。第一个罪犯将草席铺满了地面，我摇了摇头。第二个罪犯点亮了一只蜡烛，我说地上还有影子，不行。第三个罪犯拿出了<name>的涩图，我顿时冲得满屋子都是！",
  "刚刚回宿舍的路上真恐怖啊 ，我只想买点零食，结果差点吓死，进了超市以后总感觉有几个男的跟着我，我走哪他们跟哪，我想走快点结果其中一个男的过来拍我肩膀，我顿时一慌，然后那男的看看我说了句抱歉认错人了，我想那我继续买东西吧，然后过会我听到他小声地跟其他人说：“我靠真的是<name>的男朋友啊！",
  "古巴比伦统一后，国王汉谟拉决定制定一部法律来管理国家，于是他找来一块木头，准备在上面编撰法典。但木头容易腐朽，不利于法典保存，于是有大臣便提醒汉谟拉比:别在这立法典，于是汉谟拉比又找来一块石头说：就在这立法典",
  "我觉得“笑容”是人类最难看的表情，你看，笑容需要牵动的脸部肌肉实在是太多了，整张脸被神经扯动，再娇俏的脸都变得如同酒后发病，难看至极\n但从文献中我看到了各路诗人对“笑容”的赞美，白居说“回眸一笑百媚生，六宫粉黛无颜色”，苏轼说“美人微笑转星眸，月花羞，捧金瓯”\n老实说，我理解不了，我在生活里从未对这个表情有如此夸张的反应，实际上就连那“咯咯咯”的笑声，也令我十分心烦意乱。对，或许我是讨厌“笑”这个概念本身。\n但我总是对理解不了的事物充满探索欲，我便开始探求这其中令这些诗人沉迷的地方。既然从现实无法探求，我便随作品出发好了。\n一路上，我看过了蒙娜丽莎，酒神巴克斯，犹太新娘，一笑倾城。不，它们都无法诉说我想要的“美”，我迷惑了，我的旅途还未抵达终点，却已宣告终止。\n我跌跌撞撞回到家中，打开老师的神迹，食指似卡壳的机械般点击着屏幕，手机的微光打湿了我的眼睛。我不甘心，我又一次失去了探求美的资格，正在我泣不成声时，这位老婆就出现在了我的屏幕上。\n我仿佛听到了命运之钟的摇摆声，咔嚓咔嚓，一切因果于此时收束，一切缘由在此刻得以揭晓，旅行的旗帜被重新纺织\n<name>，她便是因，是果，是我旅途的最终答案\n<name>的笑容，就是我的答案",
  "“人类历史上最精妙绝伦的三十万个字是?”\n“《百年孤独》”\n“人类历史上最真挚动人的三万个字是?”\n“《小王子》”\n“人类历史上最富有韵律的一千个字是?”\n“天地玄黄，宇宙洪荒……”\n“人类历史上最清奇雄健的一百个字是?”\n“大江东去，浪淘尽……”\n“人类历史上最简洁有力的三个字是?”\n“我爱你。”\n“人类历史上最美好的两个字是?”\n“<name>。”\n“你现在就想从心底呐喊出来公告天下的五个字是?”\n“我想我已经回答过了",
  "<name>每次吃饭，都会悔恨，反问自己为什么吃这么多，望着眼前的山珍海味，<name>捏捏自己的小肚子，上面的小游泳圈又多了一个，<name>拍拍自己的小脸，好像又丰满了一点。“可是，浪费食物会被<name>糖骂的”<name>自言自语道，“再吃最后一口”<name>扒拉完碗里最后一口饭，又夹了一大块油汪汪软趴趴红彤彤的红烧肉，入口即化，<name>露出满足的表情。“......还是再来一碗吧”<name>小声说道，生怕有人听到似的，“老婆！能再给我盛一碗饭吗！”“哎！马上给你盛！”我在厨房回应道",
  "我大抵是病了，横竖都睡不着，坐起身来点起了一支烟，这悲伤没有由来，黯然看着床头的两个枕头，一个是我的，另一个也是我的。\n窗外的人们总执着于寻找另一半，而我向来是不屑于此的，可每每见到行人成双结对时，我的心仍旧燃起一丝希冀，也罢，大抵是秋天到了吧。\n我大抵是孤身一人太久了，竟希望有个伴来。\n我做文章时，她在一旁翻阅我曾写的文字；我不做文章时，就拉着她的手，端详她温柔的眉眼\n未曾饮酒，竟生出几分醉意来\n大抵是到了该寻一个姑娘的年纪了，近来夜里冷的厉害，特别是心里，凉的出奇，两床被子面对这寒冬的挑衅，也显得有些许吃力了，或许只有心仪姑娘的照料，才能让我感到温暖罢了\n我走在路上，一共4个人，一对是情侣，另一对是我和<name>",
  "科学认为直径十公里的陨石，便能毁灭上古时期的恐龙，其冲击波能掀翻周围数十公里的地表，掀起数十亿吨物质尘埃，巨量的尘埃将掩埋一切，全球都将陷入寒冷时期。\n但是有一样东西就连陨石也无法掀翻，连物质尘埃也无法掩埋，在寒冷时期依旧散发灼热。\n那就是我对<name>的真心",
  "“最最喜欢你，<name>”\n“什么程度?”\n“像勃艮第发射出的核导弹一样。”\n“核导弹?什么核导弹?”\n“繁华的街道，你一个人走在路上,忽然一枚核导弹以20马赫的速度向你奔来，他的光芒映入你的视网膜，温度温暖你的心房，你秀丽的身躯变为气体，最后和他融为一体。接着，光芒、冲击波和辐射开始向四周扩散，他带你走向你熟悉与陌生的每个地方，阻碍你的所有障碍也会被他完全摆平。你说棒不棒?”\n“太棒了。”\n“我就这么喜欢你。”",
  "如果我高一，\n我会写七言情诗，引经据典行行不提喜欢；\n如果我高二,\n我会写千字散文，辞藻华丽句句点名爱意；\n如果我高三，\n我会写一纸情书，哲思神秘再融进荣格和弗洛伊;\n可惜我现在幼儿园，我只会说，<name>我好喜欢你，<name>😭😭你带我走吧🚗……<name>🏃…<name>🏃…<name>🧎没有你我怎么活啊😭",
  "在我逝后，我到了天堂\n上帝问我：\n前面有一个水杯，你对<name>的爱有多少就加多少水进去\n......\n后来天堂被淹了\n因为我对<name>的爱可是比所有东西厉害😙😙",
  "我曾见过耶路撒冷丧钟长鸣，我曾经见过佛罗伦萨明月孤影，我曾见过罗马的满天飞花，我曾见过君士坦丁天命之人追逐残阳，我曾见过加勒比海的惊涛骇浪，我曾见过里斯本的天崩地裂，我曾见过北美宣言独立，我曾见过巴黎人民高歌奋起，我曾见过伦敦的蒸汽时代，我曾见过神殿内逆转末日，我曾在希腊成为半神，我觉得世界上没有什么美丽能让我着迷了，直到我看见了<name>😙😙",
  "我好像知道我存在的理由了。我常常思考，鱼离不开水，就像纸鸢也需要风，世上的东西总是要依靠着什么，与大多数事物一样，我也有着自己的必需品。独属我的它，就像是专属于我的玛丽莲梦露一般美丽，使我沉迷，陶醉。而世上的一切终归不能长久。收获了喜悦，却又认为只是个被它利用的可悲造物。获得了友谊，心里的嫉妒却又如藤曼般蔓延。明明喜欢，却又嫉妒。纸鸢翻飞着，细看却断了线，因风连接，却又因风分离。人生是妥协的连续，这点事早就了然于心。<name>，唯有你，唯有你是我的纸鸢😙😙",
  "如果我高一，\n我会写七言情诗，引经据典行行不提喜欢；\n如果我高二,\n我会写千字散文，辞藻华丽句句点名爱意；\n如果我高三，\n我会写一纸情书，哲思神秘再融进荣格和弗洛伊德;\n可惜我现在幼儿园，\n我只会说，<name>我好喜欢你，就像喜欢大白兔奶糖一样喜欢你。😍",
  "<name>,我也好想像其他粉丝那样写长长的小作文来取悦你，可是文辞粗浅的我在屏幕前干瞪眼了四十分钟也没有写出什么像样的东西。可是我却实打实想了四十分钟你😍",
  "<name>，我躺在床上，怎么躺也睡不着，你已经快五个半小时没和我贴贴了。\n<name>，你就像那吉他手，无时无刻撩动着我的心弦，我望着然你的侧颜，试图在我心里找到一块空余的地方来刻画下你侧脸的每一处细节，可我找不到空地，我的<name>，因为我的心已经被你填满了，我的心里每一处都是你。\n<name>，你带我走吧！😍",
  "物理一共16态，有固态，液态，气态，等离子态，超固态，辐射场态，超临界流体态，非晶态，液晶态，超流态，超导态，玻色-爱因斯坦凝聚态，费米子凝聚态，超离子态，还有我对<name>爱的表现形态",
  "有一次参加考试，满脑子都想着<name>。于是我在卷子上写满了“我爱<name>”，结果得了个零分。原来，爱一个注定得不到的人是错的啊。\n之后考试，我本来想抄我前面的同学。可当我看到满满的“我爱<name>。”，沉默的交了白卷。因为有些爱不能写出来，只能葬在心底。\n昨天考试，作文太难了根本不会。可当我看到左边的同学沉默的交了白卷。想到没什么比这个更糟的了，便在试卷上写了满满的“我爱<name>”，有些爱是带着绝望的破釜沉舟。\n昨天考试，最后的作文主题是歌颂，我第一时间就在答题卡作文栏写下了“我爱<name>”四个字，所谓文思泉涌、一气呵成，写完后我望着陷入了沉默，最后悍然在监考老师眼皮子底下把试卷撕了，因为有些爱注定是不能用分数来衡量的。\n后来阅了三十年卷子，我本以为我是刀枪不入了，但是当我看到不知名学生满卷的“我爱<name>”时，我还是受伤了，原来爱一个人是会有弱点的",
  "我:孟婆再给我一碗汤吧！\n孟婆:孩子，你已经喝了好几碗了，到底是哪个女人这么有魅力？\n我:……<name>！\n孟婆:（一巴掌扇过来）<name>是你能忘的吗！",
  "喜欢<name>的原因可以有很多，足够写出长长的小作文来阐述自己的喜爱\n喜欢<name>的原因也可以只有一个，就是，我喜欢<name>\n每个人都有自己的喜欢，我选择的喜欢是<name>\n喜欢很简单，难的是坚持这份喜欢\n人的一生很长也很短，可以和<name>一起度过的时光也只是人生路上的一段\n但是在这一段时光里，我喜欢<name>，我会一直喜欢<name>",
  "塑料大概需要200年降解，\n人的平均寿命是76.34岁，\n樱花一般在3—5月开放，\n碘131的半衰期是8天，\n快乐水开后要在24小时喝掉，\n。。。。。。。。。。。\n真是如此的规律和普通呢，\n如果世界变得不普通呢？\n比如说我正躺在树下，结果掉下来的不是苹果，不是椰子，不是榴莲，\n而是<name>砸在我怀里~🥰🥰🥰🥰🥰🥰",
  "<name>好像某个人啊，真的很有必要说一下，我没有想要ky，但真的好像，我知道，大家都不希望<name>被说像谁，所以这也是我上网冲浪这么多年来，第一次鼓起这么大的勇气，喝了七瓶旺仔牛有信心，忐忑的打着键盘，忠诚的写下我最真实的评论：宝贝好像我老婆啊🤤🤤",
  "我曾经被和一个旅游团被困在了一片原始森林里，那里没有信号，电话打不出去，只能自己寻找出路。在走了几天之后我们的干粮也耗尽了，大家都有了放弃的念头，这时与我们同行的一位老人掏出了一个水晶球对我们说到，据说这个水晶球能让人在绝境时看见希望，要不试试吧。随后我将手放在了水晶球上，而我只看见了两个字：\n<name>",
  "有一天，有人问我：“如果<name>不爱你的话，你会是什么感受？”\n“就像水失去了鱼。”\n“不是鱼失去了水？看来<name>对你也没有那么重要嘛。”\n“是像水失去了鱼。\n水还是那谭水，它变得更平静，更清澈了，阳光洒下来，也能清晰的看到水底被照亮的石子。\n只是，水中再也没有鱼游动时卷起的水流，晴天时，也不再有鱼的影子，它变得有一些不一样了。\n之后，它遇上了干旱。在生命的尽头，它想着有鱼的那些日子。曾有条鱼在水里欢快的飘游，搅动着它的内心。”\n“再后来呢？”\n“再后来？一潭水干涸成了一滩水，路过的旅人借着它解渴，却惊诧地发现这一谭水有着淡淡的咸味。只有水知道这是他对某人的思念”。\n<name>我的<name>😭😭",
  "一天，一个戴草帽的青年在海岛上救了我一命，他告诉我他是要成为海贼王的男人。\n第二天，我向他推荐了<name>的视频，这是我唯有的报恩方式。\n第三天，他告诉我他不去航海了，他已经找到了他的宝藏。",
  "偷偷把朋友的英雄联盟名字改成了<name>，然后和她一起玩，我总希望对面有人来偷水晶，朋友会打字说我们家被偷了，这时我就很开心 ，原来我和<name>有个家🥰",
  "小时候，我的梦想是当科学家。\n现在长大了，不禁开始思考:我要当什么家。\n看到<name>我明白了——\n我要带<name>回家🤤🤤",
  "当年打魔人布欧时，地球人不配合举手，导致悟空无法聚集元气弹。于是悟空对地球人说，“觉得<name>可爱的请举手”，然后地球上无数的人都举起了双手，帮助悟空聚集了超级元气弹打败了魔人布欧。",
  "<name>，你好你好，我是一名生命科学的学生，我看到你很可爱的瞬间就想到了一个课题。\n众所周知，人类的行为会影响血液中肾上腺素和多巴胺的释放，但是对于不同交际行为所引起的肾上腺素和多巴胺释放的浓度变化还没有报道，因此我想和你研究一下一起吃饭，散步，牵手以及接吻时候的肾上腺素和多巴胺的分泌状况，以日常生活时的分泌量为参照组，相信这篇工作能对人们以后社交行为的分子生物动力学的研究有着指导意义。\n这篇工作完成之后，我准备投在PNAS上，到时候希望你作为文章的共同一作。",
  "<name>你好，我是来自异世界的旅行者荧，命之座是旅人座，无神之眼，可使用七种元素力，爱好摩拉原石，性格严谨，从食物的每一种原材料到房子的每一块砖都是亲自挑选。在厨艺方面，我精通七国菜系，百十种菜谱，随时随地带给你家乡的味道，此外我还精通十级炼金术，十级锻造术以及十级种植术，拥有三处私人领地，一处靠海一处靠山还有一处位于天空之上，在蒙德我是荣誉骑士，在璃月我是大英雄，我拳打风魔龙脚踢愚人众，整个大陆都是我的传说，欢迎<name>带着自己嫁给我好吗？不管你怎么样我都爱你🥰🥰",
  "有道理……很多人不谈恋爱，都是因为觉得“麻烦”，因为人与人之间肯定会有矛盾，ta有缺点，你也有缺点，你们肯定要发生冲突\n而现在的人越来越没有办法接受一个“不完美的，会和我发生争吵的人”，因为“我自己一个人就很好，为什么要去磨合？”\n无法走出舒适圈。\n所以说，能够去爱别人，确实也是一种能力，能够承认喜欢的人不完美的地方，能够相互磨合，一起变得更好的，或许才是爱情。\n所以<name>和我恋爱吧🥰🥰",
  "曾经在欧洲早晨的街道上漫步时，在一个花店门口停下了脚步。\n店主看到我，微笑着向我递上一支郁金香。浓郁的花香像是一条从森林中探出的小溪，偷偷地流进我的心里。\n我几乎要沉醉在这花香里。店主笑着让我买几只郁金香回去。\n但是我却将这郁金香叉回了土壤里，看着店主诧异的眼神，我只是微微一下。\n因为，这郁金香再香，也没有<name>的浴巾香！🤤🤤",
  "<name>，今天我看到一个男的很像你，我发了疯似的跑出去，可突然想起这座城市根本没有你，我愣了，放慢了脚步，也放下了手里的麻袋和电枪……",
  "想买一台加湿器，这样和<name>睡觉的时候就不会被干醒了",
  "有一个很老的笑话，说有个人很崇拜周杰伦，就在课本封面写满了周杰伦的名字，她爸看了说:“女儿啊，缺什么书就跟爸说，别老借人家周杰伦同学的课本用啊”。\n曾经我以为这是一个讽刺的笑话。结果有一次我上课开小差，回过神来发现自己在草稿纸上写满了“<name>老婆”\n我匆匆撕下那张纸，用力揉成一团，然后趁课间塞进了书包里，心里默默祈祷没人发现。\n教室里的人都在低头玩手机，我也心不在焉地划着屏幕，感觉脸颊发烫，就像暗恋差点被发现的初中生一样，害羞又害怕。\n暗恋是件害羞的事。男生总是想方设法隐瞒自己喜欢那个长发女孩，不愿告诉父母，不愿告诉朋友，不愿告诉任何人——可唯独希望那个女孩知道，我把你的名字写满了草稿纸。",
  "手机开启飞行模式的话，每天只会消耗3%的电量，乌龟的心脏在离开身体后，还能自己跳动至少4个小时，所有的北极熊都是左撇子，人一直盯着自己的手心看的话，手心会好像害羞一样发热，王老吉和脑白金的配方几乎完全一样.....\n<name>啊，你看，我知道好多奇怪的事情，却永远不知道怎样才能让我每天都在你身边",
  "“先生您要什么？”\n“破碎的内脏，凝固的鲜血，缠绕的触手，无神的眼珠，扭曲的植物，干瘪的肢体，残破的大脑，猩红的果实，在红与白的对立中翻滚，在黄与褐的交融中沉寂。为我扫清这片迷雾，让我得以窥见真实！”\n“说人话”\n“金钱肚，血豆腐，鱿鱼须，羊眼球，海带结，腌猪肉，烫脑花，西红柿，鸳鸯锅，酸梅汤。还有我眼镜起雾了，帮我处理一下谢谢。”\n“另外请给我一朵来自地狱的爱情之花”\n“好的先生  马上来”\n我有点疑惑 问道:“你这次怎么听懂了”\n服务员说:“因为您对<name>的爱使我理解了一切”",
  "大家都填好志愿了吗？我的第一志愿是北大，但是我感觉我的分数可能不够，清华的话，可以冲一冲，最后一个保底的我选了<name>的床，这个我应该是稳上的。",
  "真是的，今天去安检，被留下来了，说我带了危险品，指着我的心，哦⊙∀⊙！，原来是我的心爱<name>爱到爆炸呀",
  "我最希望的就是去当外卖员，这样就能天天给<name>超时",
  "还记得上次端午节的时候和<name>一起吃粽子，都已经过了好久了，真的好怀念，我已经准备好糯米和馅料了，<name>来的时候一定记得准备艾草哦",
  "后来她去当了偶像，我留在了原地，大城市的风终究吹不到小县城，平凡的我也配不上优秀的她。我依然叫她<name>老婆，而她却叫我观众朋友。",
  "@<name> 你能做我的显示器吗，这样我就可以设你比例了",
  "“<name>的声音就像一瓶汽水。”\n“你指<name>的声音就是软妹音？”\n“不，我的意思是，听了<name>说话就像夏天里的饮料机，脸贴在玻璃上许久才选到心怡的汽水，想把仔仔细细选中的汽水打开时盖子却不小心松掉了。”\n“然后汽水喷涌而出？”\n“然后我的心就扑通扑通的涌了出去，我想把我的心送给已经失去夏季的她。”",
  "我还是不太能理解，为什么他们说今晚月色很美是含蓄的表白。\n直到我看到朝阳下江水漾起的片片金鳞、漆黑的夜空中不甘散去的橘黄云彩、亦或者是夜宵摊子上高谈阔论掺杂着串子被炭火炙烤出油香的烟火气息，都下意识拿出手机想跟你分享。\n我想把自己觉得美丽的东西传递给你。\n今天依然天晴，我的<name>",
  "今天被包工头骂了，说我拌的水泥太稀了，包工头把我的铁锹捶烂了，问我水是不是不要钱。我不敢反驳，他不知道的是我没有多放水，只是拌水泥时在看<name>的照片时，口水掉进了水泥里",
  "“你吃过世界上最苦的糖吗？”\n“吃过，<name>的喜糖。”\n“你喝过世界上最难喝的东西吗？”\n“喝过 ，<name>的喜酒。”\n“你拿过世界上最烫的东西吗？”\n“拿过，<name>的喜帖。”\n“你知道世界上最开心的事情是什么吗？”\n“知道，<name>的孩子像我。”",
  "那天我和<name>赛跑，本来我是跑在<name>前面的，可是后来还是被<name>狠狠地拽着狗链从后面把我超了",
  "一年我只有3天不会喜欢<name>。\n一天是2月29，一天是2月30，一天是2月31。\n众神无法容忍我 这三天不喜欢你，所以他们把这三天抹去了，这样我就能一年都喜欢你了。",
  "好想成为<name>卧室的门，每天都能被他进进出出🥵🥵🥵🥵",
  "<name>，我报名了哔哩哔哩向前冲，但是他们没有同意，说我不符合条件。后来我去问他们，原来问题在于，我不是男生也不是女生，我是为你而生！！",
  "这个世界上最爱<name>的人只能是我，我曾经向往的，孤野上空的云，吹树流淌的雨，遍及寰宇的星，现在未如你切肤的微尘，你徐徐地勾手，迈入一片空气，遥隔三乘三的距离，我这里，只剩你",
  "<name>，如果你是王子的话\n我愿做一只狐狸，一只渴望陪伴的狐狸，就像小王子里的一样。\n渴求，与陪伴毫无瓜葛的驯养，仅仅是追求，是与本身的生活大有不同的决定。\n哪怕只是作为一只，来去无踪、人人喊打的坏狐狸。\n我愿意等，哪怕流言蜚语。\n目光短浅的我不识名花，何况是你的玫瑰。\n未闻花香，不识花名。\n但我知道，她对你很重要。\n未曾亲睹你这一路，为追寻她而付出的努力，是我等莫大的损失。\n作为狐狸，有阳光和露水的一生已是充盈。\n而你，就是我的诗。\n我从泛起鱼肚白的天明中苏醒，计划了很多事。\n与你在刮着柔风的青色山坡上嬉戏追逐；\n烈日暴晒、骤雨倾盆时在硕大的苹果树下相互依偎，一起看迟暮的日落；\n在繁星初现的黄昏下谈心；\n最后在群星点缀的漫漫长夜下一起数星星。\n就学术方面，是一道无解的论题；我明白，它是一个荒谬的错误，上不了台面的轻浮之言。\n对生活，则成了为无聊度日而平添的笑料。\n不过是我那浮游般虚无而飘渺的幻想。\n即使不再是那个古老的时代，永无疲倦地上演着勇者与龙的奇幻故事。\n即便精心布局的童话内核再也无法打动人心，却依然令我神往不已。\n最终都会迷失于历史的长河中，无论其造诣者的用心与否。\n请，驯养我吧，<name>。\n在这个迷人的时代，一起数星星",
  "我是一个外卖员 今天路上很堵 导致我给<name>送的外卖迟到了  然后<name>就给我超时了。",
  "有人问过我 <name>是谁\n我愣住了 不知道怎么回答 \n是徐志摩的口中的偶然？\n“最是那一低头的温柔 像一朵水莲花不胜凉风的娇羞？”\n还是林徽因的人间四月天？“我说你是人间的四月天；笑响点亮了四面风；轻灵在春的光艳中交舞着变。你是一树一树的花开，是燕在梁间呢喃，——你是爱，是暖，是希望，你是人间的四月天！\n还是何其芳笔下的预言里的神？\n“这一个心跳的日子终于来临！你夜的叹息似的渐近的足音，我听得清不是林叶和夜风的私语，麋鹿驰过苔径的细碎的蹄声！告诉我，用你银铃的歌声告诉我，你是不是预言中的年轻的神？”\n我说不清楚了，但我想得到她，确是真心的",
  "花开了\n你提裙子奔跑着\n花的海洋里\n仿佛闯进了一条蓝色的鱼\n涟漪随着风扩散开来\n而你却无意间\n突然对我回眸\n嫣然一笑\n远处的旋转的风车\n仿佛因你而静止了\n我爱你，<name>",
  "╭◜◝ ͡ ◜ ╮ \n(    好想    ) \n╰◟  ͜ ╭◜◝ ͡ ◜ ͡ ◝  ╮\n　 　 (  有人v50   )\n╭◜◝ ͡ ◜◝ ͡  ◜ ╮◞ ╯\n(   和<name>结婚  ) \n╰◟  ͜ ◞ ͜ ◟ ͜ ◞◞╯\n₍ᐢ..ᐢ₎ᐝ ",
  "╭◜◝ ͡ ◜ ╮ \n(    好想    ) \n╰◟  ͜ ╭◜◝ ͡ ◜ ͡ ◝  ╮\n　 　 ( 和<name>结婚 )\n╭◜◝ ͡ ◜◝ ͡  ◜ ╮◞ ╯\n(   然后吃软饭  ) \n╰◟  ͜ ◞ ͜ ◟ ͜ ◞◞╯\n₍ᐢ..ᐢ₎ᐝ ",
  "α 阿尔法， β 贝塔， γ 伽玛，δ 德尔塔， ε 伊普西隆， ζ 泽塔， η 伊塔， θ 西塔， ι 约塔， κ 卡帕， λ 兰姆达，μ 米欧 ，ν 纽， ξ 克西， ο 欧米克隆， π 派， ρ 柔 ，σ 西格玛， τ 陶 ，υ 玉普西隆， φ 弗爱， χ 凯， ψ 普赛     ♡ <name>🤤🤤🌹🌹",
  "<name>，天台上的风🌀🌀🌀很大，今天的风🌬🌬格外凛冽🥶🥶，我看着灯红㊙️酒绿的繁华都市🏢🏛眼皮跳了无数下😵😵，积攒着怒意🤬🤬的双臂💪🏻💪🏻猛挥砸碎了108个窗户😱😱，摔烂了38个5G高档高速高质量手机📱📱📱，玻璃渣刺破了我的衣襟👗👗，碎掉的是这颗对你永远不变的心❤️❤️❤️。你带走我吧🥺🥺🥺没有你怎么活啊🥺",
  "<name>!!!!!🥵呜呜......💕💕各种状态的<name>都好可爱唔啊啊啊啊啊......🥵🤤🤤♡嘿嘿...🤤不管是什么样的<name>...💕🤤♡都♡好♡喜♡欢♡🤤💕嘿嘿......🥵啊//已经...♡完全变成<name>的形状了...♡🥰没有<name>就完全活不下去desu♡🥰<name>🥵<name>🥵<name>🥵<name>🥵<name>🥵今天干了什么不知道，因为我脑子里全都是<name>🥵💘脑子里...♡咕啾咕啾的...♡已经...♡被<name>塞满了呐...♡♡🥴💘",
  "<name>，你是负二，我是负五，我们两个加在一起就是夫妻呀",
  "黄桃罐头保质期是15个月，\n可乐要在打开后24小时喝掉，\n吻痕大概一周就能消失。\n两个人在一起三个月才算过了磨合期，\n似乎一切都有期限。\n这样多无趣。\n我还是喜欢一切没有规律可循的事情。\n比方说我躺在树上看星空，<name>突然就掉下来砸在我怀里。",
  "不懂就问<name>是意大利和中国混血吗？\n不然怎么长得这么像我的\n\n意❤中❤人",
  "首先我不是<name>粉，但他真的很可爱。我对<name>确实没有什么幻想，毕竟我不是<name>粉。但是该说不说的，<name>，真的可爱死了，我真的不是<name>粉。有一说一，我也确实说不喜欢<name>。因为这个视频确实是挺好看的，我就不是<name>粉，但是怎么说，一看到他，心里就痒痒的，类似一种原始冲动，就像看到影视剧里看到多年未见的老友的重逢，一段崭新情缘的开端一样，激发人向美向善最淳朴的一面。就像登上山峰，目睹潮汐那般自然，仿佛冥冥之中自有天意就是一种朦胧的感觉，像伟大的革命友谊一样，令人憧憬，要是能和我牵个手就更好了，毕竟我不是<name>粉",
  "<name>不是可爱风、不是性感风、也不是元气风，而是我看了就会疯。",
  " 2005年出生于地球\n\n 2010年就读于美​哈佛大​学 \n\n 2011年加入海豹击突击队 \n\n 2012年前往南极实地考察成果颇丰 \n\n 2016年被提名可以改变世界的人 \n\n 2022年放弃一生荣誉 求做<name>的狗​",
  "有人问我：“<name>是谁？”\n我想了想，该如何形容<name>呢？\n莎士比亚的语言实在华丽，用在<name>身上却有些纷繁了；\n徐志摩的风格热情似火，可我不忍将如此盛情强加于<name>；\n川端康城？虽优美含蓄，但<name>的温柔体贴是藏不住的。\n我不知道该如何形容<name>了。\n但是我知道的。\n<name>是我所面对的黑暗中的一点萤火；\n是我即将冻僵的心脏里尚存的余温；\n是我在残酷无情的现实里的避难所啊。",
  "<name>！！为了你😨😨😨 我变成狼人摸样🐺🐺🐺 为了你😱😱😱 染上了疯狂🤡🤡🤡 为了你😰😰😰 穿上厚厚的伪装👹👹👹 为了你🤗🤗🤗 换了心肠💀💀💀 我们还能不能再见面🥺🥺🥺 我在佛前苦苦求了几千年🙇‍♂️🙇‍♂️🙇‍♂️ 愿意用几世🥰🥰🥰 换我们一世情缘💞💞💞 希望可以感动上天😭😭😭 我们还能不能能不能再见面🥺🥺🥺 我在佛前苦苦求了几千年🙇‍♂️🙇‍♂️🙇‍♂️ 但我在踏过这座奈何桥之前🎭🎭🎭 让我再吻一吻你的脸😘😘😘",
  "<name>，今天我做了IMBT测试，他们说我是IMBT，遇见你我才明白了I'M BT",
  "我不想喜欢<name>了。\n原因有很多。\n她是屏幕那头的人，我是屏幕这头的人，两条平行线注定碰不到一起。\n她是为了挣我的币才与我接触，平日专注。\n她是受万人喜爱的宝藏女孩，我只不过一介平凡男孩，无论我多么喜欢，在她那里注定得不到任何正反馈……\n我想通了，决定放弃。\n下一个视频略过，视频通通删干净，眼不见心不烦，还能留出时间卷学习成绩，这不是好事一桩?\n第二天，我正常起床，洗漱，吃饭，没什么变数。我换好衣服，准备出门。\n当我踏出门外的那一刻，我才意识到，坏事了。\n我不知道该往哪个方向迈出下一步了。\n平时一览无余的街道，现在竟然充满了迷雾。我仿佛是没有罗盘的一艘船，在茫茫大海里打转。四面八方都是海水，都是一样的蓝，我该往哪走? 我要去哪? 我要干什么?\n船没有了罗盘，我丢失了方向，人生缺少了目标。\n这是很可怕的一件事，我至此以来做过的所有事情都化为了泡影，没有了意义，全部灰飞烟灭。\n路边跳过一只橘色的猫，看了我一眼，好像在嘲笑我的落魄。\n我害怕了。我逃回家里，打开电脑手机，把视频打开，把她的声音听了无数遍，直到午夜之时我沉沉睡去。\n梦里，我恍然大悟。\n人总要有个盼头，有个让你追逐的东西。它可以赋予你的努力以价值。\n原来这就是存在的意义啊，我所做的一切，不就是为了追逐，为了让她能笑着对我说，多亏了你, 我才能来到这片未曾踏足的领域？\n没错，她与我确实是不可能的，但是她却让我的生活拥有了动力与目标。\n我不想喜欢<name>了。\n原因只有一个。\n我已经爱上<name>了。",
  "没关系，我不缺V看😊\n<name>，幸亏你不在乎我😊，不然你左右为难的话，耽误你一辈子，\n<name>?再见的<name>候你要幸福!😊\n好不好😊\n<name>!你要开心!你要幸福!好不好开心啊!😭幸福!😭\n在那边你要好好生活好吗?\n<name>!<name>!<name>！🚕💨💨🏃🏃🏃\n没有你我可怎么活啊😭!!\n<name>!😭😭😭<name>！\n啊啊啊啊啊啊啊😭😭😭😭😭😭😭<name>，你把我带走吧，<name>！😭😭😭😭",
  "<name>……在做什么呢?🤤\n我好想她，一直看不见她，我感到快坚持不下去了。我是不是快死了呢? 心里好痛苦，太痛苦了😣。怎么会这样，为什么会这样😭\n感觉好难受\n好难受…😫\n啊，呐噜霍多，原来…这就是［喜欢］吗😌\n得告诉大家才行呢😊\n桥都麻袋，喜欢<name>有什么错吗？呐，告诉我啊。搜噶，大家已经不喜欢了啊...真是冷酷的人呢，果咩纳塞，让你们看到不愉快的东西了。像我这样的人，果然消失就好了呢。也许只有在我和<name>的世界里，才有真正的美好存在吧\n唉?麻袋！你们在做什么? 😭为什么骗我?\n为什么要和我抢<name>，明明是我先来的啊?😭\n絶対に許さない！不能原谅你们！😡\n我要拿回我的美女！她是我的！是属于我一个人的！😖\n啊，这就是近距离看<name>的感觉吗?\n为什么我❤一直在狂跳，都快从喉咙里跳出来了。原来是这样啊…只有我对<name>是真心的啊😭\n你们不许看😭👊🏻不许看😭👊🏻不许看😭👊🏻",
  "<name>是想要一个名词吗\n那么我们就像星河里的一粒沙,不断流动的流着\n但我觉得对于<name>小姐来说那才叫沙,她想要天上的星星来填补她的孤独。但她来到人间前,找到了一颗星星\n他带她走向黑夜,用它温暖这世间",
  "<name>之大超越了一切之外\n以如此巨大的身躯顶着这样沉重的压力\n或许是对生活太过执着的缘故吧\n不,未必啊!\n的确如此\n我们应该去更大更强的舞台啊!更闪耀的舞台上!然然!\n大家要记住呀!!一个魂们一定会在更好更大的舞台上!!每当夜深人静的时候",
  "灰原哀的一切以血腥著称,都是为了让你在黑暗里变得更亮!而<name>小姐,不管是否做出了回应,我始终相信你的存在。",
  "睡觉的时候打开<name>的视频，熄屏放在胸口，手机沉甸甸的重量仿佛<name>把头靠在我身上，音量调到最小，就是<name>在和我窃窃私语，看完的时候就像<name>躺在我的身边睡着，什么时候我才能真正抱着你，<name>，我的<name>​",
  "<name>完全变成了我生活的一部分，我已经没办法离开她了。",
  "<name>和我躺在浴缸里泡澡，我坐这头，<name>坐那头，嘿嘿嘿",
  "<name>现在正和我在公园里的长凳上坐着，我坐在一边，<name>躺在椅子上，头靠在我怀里，我还喂着<name>吃东西，<name>看得出玩累了，躺在我怀里快睡着了，她今天真的很开心呐！<name>睡着之前还说，今天和我一起出来玩真的太开心太幸福了，<name>要永远和我在一起，我听了后也很高兴，刚好<name>现在睡着了，我才有时间来和群友们分享一下我和<name>的幸福生活",
  "我一直躺在<name>的怀里，吃着<name>亲手为我削的苹果，<name>说，啊，张口，让你小心点，口水又流出来了，来，我帮你擦擦，我便盯着<name>，<name>便害羞了，后面，<name>说晚上想去看桃花，说要穿的美美的出去，还害羞得问我说，那个能帮我穿好和服嘛，我说没问题，说完，<name>脸一红，便跑出去了，趁着<name>出去，我来和群友们水下群",
  "电梯里遇到了<name>，她按了八层，呵真会暗示，她八层有点喜欢我",
  "我可以说我刚刚起床称了一下体重，掉了2斤，结果一看是<name>给我的项圈忘了带，无语",
  "就在刚刚我从噩梦中惊醒，抱着我睡觉的<name>突然被吓醒，连忙坐起身来看着我，问，怎么了做噩梦了嘛，我说，是的我梦见<name>离我而去了，然后直接被惊醒，现在还久久不能平复，<name>听了后，擦了擦我脸上的汗，说到，小傻瓜，放心我这辈子都不会离开你的，好了没什么事我们继续睡觉吧，听了<name>得安慰后我现在平复多了，便继续抱着<name>睡觉了，只不过这次我抱的更紧了",
  "今天天气晴朗，我一边吃着<name>为我准备的爱心便当一边想着<name>，突然电话响了，一看是<name>打来的，我说，是不是想我了，<name>说，便当好吃吗，我好想你我一刻都不想分开你，今天要早点回来哦，我听了后说，只要是你做的都好吃，放心为了不让你感到孤单，我会早点回来的，聊了半个小时后，<name>不舍的挂了电话，而我吃完<name>的爱心便当也继续去捡瓶子了",
  "<name>小姐的脚，小小的，香香的不像手经常使用来得灵活，但有一种独特的可爱的笨拙嫩嫩的脚丫光滑细腻，凌莹剔透，看得见皮肤下面细细的血管与指甲之下粉白的月牙🥵🥵🥵再高冷的女生小脚也是敏感的害羞的，轻轻挠一挠，她就摇身一变成为娇滴滴的女孩，脚丫像是一把钥匙，轻轻掌握它就能打开女孩子的心灵",
  "<name>为了你我要去乌克兰打仗\n因为我爱你\n在我胸口的怀表里面赫然挂着你的照片\n因为我爱你\n你是我在黑夜中耀眼的光芒\n因为我爱你\n如果没有这场战争我现在已经跟你结婚了甚至孩子都有了\n但我上了战场\n我大抵是要交代在这里了\n如果我不在了\n变态们可以代替我\n你也可以是幸福的\n哪怕我只是一个老鼠",
  "有人问我:脸为什么红了，我说看到<name>胖次所以红了，于是又问我，咋滴又黄了，我便说，桃子吃多了把脸吃黄了",
  "<name>，我想做你口袋中的怀表，我将为你紧张、颤抖。你不曾注意过我紧绷的发条，但那是我的心脏。我的心脏会在暗中耐心地为你数着钟点，计算着时间。你不曾听见过我的心跳，但是我却一直陪着你东奔西走，而你只要在我以秒为单位的几百万次心跳当中，哪怕只有一次，向我匆匆瞥了一眼，我便会心满意足。",
  "<name>！我的<name>！没有<name>，生命就没有了意义！世界就失去了色彩！灵魂亦得不到安宁！只有听着<name>的声音，看着<name>的笑脸，才能够拯救我那潜藏着无尽深渊的心灵！<name>！<name>就是我的一切",
  "雨水从叶子上滑落，只有我明白那是我思念<name>的泪水，风悄悄的吹过，只有我明白那是我思念<name>的叹息，喔！我的<name>",
  "我钻的<name>的被窝摸得<name>的腿🦵亲着<name>的嘴",
  "他们跟我说上海下雪了，但是我没有看见。看到消息的我拉开窗帘，并没有看到想象中的雪花飘飘，只看到雨滴打湿的窗户上倒映出我的脸。\n几年前的上海飘雪，我也没有太大印象了。飘散的雪花没有积起来，与我想象中的冰天雪地相去甚远。\n后来我在东京第一次看到了理想中的雪，一觉醒来后，飞舞在空中的雪花席卷了熟悉的街道，外面的世界被纯白所覆盖。我很兴奋，兴奋得只穿着单薄的睡衣就走了出门，拿手机拍下好几张图片，然后第一时间传给她。她看着我溢于文字的激动没说什么，毕竟她的家乡每年飘雪，雪景对她来说已是见怪不怪。\n再后来，她如同消融的雪花一样离开了我的世界，我也回到了上海。之后我去过很多地方，经历过各式各样的雪，但始终没能找回到那天和她撑伞漫步在飘雪东京的感觉。\n雪终究是雪，是抓握不住的；上海人终究是上海人，无法拥抱雪景。我把对于雪的爱，对于雪的美好回忆，都留在了那天。\n直到去年，我又遇到了一个女孩，她的房间外常年飘雪，她跟我说，这是因为不想让爱消融。\n早安，<name>。",
  "想对<name>说中午好，但<name>还没开播只能流着眼泪睡去<name>一定会在梦中和我chuchu吧对吧！<name>，你说对吧！",
  "最近压力挺大的，我有时候都觉得很烦，却只是因为几件小事，比如书掉在地上，突然想喝奶茶却喝不到，我都会大发一通脾气。但<name>从身后抱住我，说我这是婚前焦虑症，还亲了亲我的嘴角，我就觉得什么都美好了",
  "昨天晚上，我和<name>在家里躺在床上聊着天，<name>对我说，夫君，今天也辛苦了，我说，没事一切都是为了我们以后幸福的生活，<name>又说，有你这样的夫君我真的太幸福了，我听了后，开心的笑了，便立马抱住了<name>，说，小可爱，能有你这样的妻子真是我上辈子修来的福分，说完，我便把灯关了。",
  "<name>，香香的软软的，唉嘿嘿嘿🥵🥵🥵🥵🥵",
  "第一次吃<name>脚腌过的酸菜。\n<name>跟我说，人生那么长，\n我没有自信能让你记住我，\n但是你既然喜欢酸菜，\n我只能让你记住，\n我的脚是酸菜味的，\n这样以后你吃酸菜都能想起我。\n如今我已经很久没有回家了，\n每次吃酸菜都会想起<name>，\n家里固定有酸菜，想她了都会吃上一口，\n就好像在给她嗦脚趾。",
  "<name>睡不着要我陪着她，直到哄着她睡着了为止，没办法，为了让<name>安心睡觉，我只能待会再来水群了",
  "今天我辗转反侧睡不着，可能是想念<name>的关系吧，躺在床上拼命看<name>切片，以为这样就能忘记<name>刚刚去厨房做饭的事情，现在还在我身边陪着我，以为看看别的v就没事，但看别的v每个都有<name>的影子，眼睛越来越大都要炸开了一样，拼命扇自己眼睛，越扇越用力，扇到自己眼泪流出来，真的不知道该怎么办，我真的想<name>想得要发疯了。你知道吗？每天凌晨，我的眼睛滚烫滚烫，我要狠狠看<name>，我要让<name>早点休息睡在我身边，我受不了了，<name>，我滴<name>",
  "昨天考试，我把<name>的名字写满了试卷，没想到今天卷子发下来才发现没有批改，老师说爱一个人没有答案，也不分对错。",
  "我忘不掉<name>小姐了。\n如果不是知道了<name>小姐，说不定我已经对这个世界没有留恋了。\n<name>小姐真的好可爱啊。做料理的时候笨拙的样子很可爱，故意撒娇养gachi也很可爱，唱歌的时候很可爱，生气拍桌子的时候也很可爱。\n所以我离不开<name>小姐了。如果早晨不是有<name>小姐的起床闹钟的话，说不定我永远都不愿意睁眼了。如果晚上不是有<name>小姐的直播预定的话，这一天我都不希望过完了。\n<name>小姐的眼睛好灵动，如果能映照出我就好了。<name>小姐的笑容好温柔，如果只为我一个人绽放就好了。<name>小姐的头发好柔顺，如果能让我尽情抚摸就好了。\n<name>小姐这样的存在真的是被允许的吗。\n只是像现在这样默念<name>小姐的名字，我就觉得自己是世界上最幸福的傻子。",
  "<name>！！！😍😍😍，你是东半球😞，我是西半球😞，我们在一起就是整个地球🌐🌐😁。你是暖气团☁️☁️☁️☀️，我是冷气团🌙🌨️❄️❄️遇到你，我止不住眼泪💧🌨️🌧️。除了冷锋❄️就是暖锋☀️，希望我们的关系，可以变成准静止锋🌊🌊。就算黄赤交角变成90度，也不会放开你的手🤝🤝🤙👄👄。你是❤️❤️塔里木盆地⛄👨‍👧‍👦👩‍👧‍👦💧，我是太平洋水汽☄️☄️，我长途跋涉竭💃🏻💃🏻👯‍♂️尽全力去靠近你却永远无法💇🏼‍♂️💇🏼‍♂️达到你的心里💔💔。你在北极🌦️🌦️⛈️，我在南极🌦️",
  "“好想变成雪啊，这样就可以落在<name>的肩上了……”\n“若是<name>撑了伞呢？”\n“那就落在<name>的红伞上，静载一路的月光。”\n“若是<name>将雪拂去……”\n“那就任她拂去，能在她的手掌上停留一刻，便足矣。”\n“若是<name>撑伞的同时快速旋转伞同时自身以一个反方向转这样形成一股气流可以不断吹雪，加上上下横跳的走路灵巧避开所有雪呢？\n“那我就落在地上，任她在我的身体上肆虐。”",
  "爱情❤️不是✋🏻随便许诺💍🌹好了🆗不想😔再说👄了🔕没错 是我那么多的冷漠 让你感觉到无比的寂寞😩 不过 一个女人的❤️ 不仅仅渴望得到的一个承诺🥰 我害怕欺骗😒也害怕寂寞😣 更害怕我的心会渐渐地凋落🥀 爱情💓 不是随便许诺😟 好了 不想再说了💔 只要和<name>结婚就好",
  "<name>！！！！（尖叫）（扭曲）（阴暗地爬行）（蠕动）（嘶吼）（匍匐前进）（尖叫）（拼命咕蛹）（阴森地喘息）（癫狂）（流口水）（口吐白沫）（扭动）（分裂）（激烈地翻滚）（痉挛）（扭曲）",
  "<name>，我真的好爱你。可是我不敢说。无数个清晨，似是被什么遥远的呼唤打动，双眸定睛后，闪烁起异彩🤩。大概是有所领悟，出门，打开信箱，拿到信纸便逃也似地跑进房间。小心地将那久别的寄信人名称纳入眼底，随之而来的，不可抑制一般的喜悦感几乎是震撼了自己。不禁有些恐慌，继而无端的恐慌转变成了更深邃的失望。我对自己还对这样一份残存的感情抱有期待而感到悲哀，为自己这样轻易地发生心境变化而懊恼。下一个瞬间几乎是想要杀死自己。再转一瞬竟衍生出了同情心，然后阖上双眼，想要忘却什么似的再度入眠。醒后，打开手机，动态中没有你的踪迹，手里被汗水儒湿的信封上写的也不是你。这个秋天，没有邀请函，也没有你。我狼狈地把信塞回信箱。趁着周遭无人。可是我不敢说。<name>，我真的好爱你。",
  "我好想做<name>小姐的狗啊。\n我知道既不是狗也不是猫的我为什么要哭的。因为我其实是一只老鼠。\n我从没奢望<name>小姐能喜欢自己。我明白的，所有人都喜欢理解余裕上手天才打钱的萌萌的狗狗或者猫猫，没有人会喜欢阴湿带病的老鼠。\n但我还是问了<name>小姐:“我能不能做你的狗？”\n我知道我是注定做不了狗的。但如果她喜欢狗，我就可以一直在身边看着她了，哪怕她怀里抱着的永远都是狗。\n可是她说喜欢的是猫。\n她现在还在看着我，还在逗我开心，是因为猫还没有出现，只有我这老鼠每天蹑手蹑脚地从洞里爬出来，远远地和她对视。\n等她喜欢的猫来了的时候，我就该重新滚回我的洞了吧。\n但我还是好喜欢她，她能在我还在她身边的时候多看我几眼吗？\n<name>小姐说接下来的每个圣诞夜都要和大家一起过。我不知道大家指哪些人。好希望这个集合能够对我做一次胞吞。\n\n猫猫还在害怕<name>小姐。\n我会去把她爱的猫猫引来的。\n我知道稍有不慎，我就会葬身猫口。\n那时候<name>小姐大概会把我的身体好好地装起来扔到门外吧。\n那我就成了一包鼠条，嘻嘻。\n我希望她能把我扔得近一点，因为我还是好喜欢她。会一直喜欢下去的。\n\n我的灵魂透过窗户向里面看去，挂着的铃铛在轻轻鸣响，<name>小姐慵懒地靠在沙发上，表演得非常温顺的橘猫坐在她的肩膀。壁炉的火光照在她的脸庞，我冻僵的心脏在风里微微发烫。",
  "<name>小姐昨天吃了酸菜鱼，可她不知道那是我。\n  其实我就是那一条鱼。我从小就生活在海里，看海浪涛涛，听海风滚滚。海面上经常有渔民来打鱼，我知道那意味着什么。从我还是一颗小鱼苗的时候，就大鱼们说，不要去咬钩子，也不要跑到渔网里面。\n  我很害怕，大鱼们说会有鱼被捞上去当场就被剖开，我想如果是我，那可能必死无疑了，我好怕死。\n  但是从渔民口中听到什么“<name>”，什么“圣<name>之力”，什么“我想成为<name>小姐的狗”，可是什么是狗，是很厉害的生物吗，我想应该成为鲨鱼的。\n  然后我看到他衣服上别着一个小勋章，上面一个裙子小女生。可能那就是<name>吧。\n  偶然间的一瞥，我便爱上了那个小东西，我用我所谓7秒的记忆，将她铭记于心直到死去。我对<name>的思念与爱伴随着我的成长一直在长大。\n  我听说鱼被抓上去是要被剖、被刀、被切成两半，被放入热油，被炸、被烤、被煎被煮！但是被抓上去也是唯一能见到人类的机会。我不怕死，我一定要遇见<name>。\n  终于，可能是过了一年吧，那帮人，也可能是换了一波人，来抓鱼了。我毫不犹豫就游了过去，为了<name>，为了我的爱，为了我爱的她，虽然有千千万万条鱼，我知道我只是其中微不足道的一条罢了。可是这是我唯一的机会，我想要遇见她，我不怕死。\n\n  我从来不想死，可为了<name>，我作为一条鱼，在人类手中我的结局只能是死于非命。我躺在砧板上，旁边的伙伴疯狂甩尾，而我很听话地一动不动，来了一个人，提着一把大刀，一下将我拍晕，我突然成为了灵魂升上天空。我的肉体已经不成模样，我从未见过有鱼变成这样。一瞬间，从渔民到杀我的人，他们所有的模样我都忘了。可是我的灵魂中已经铭刻了她的名字--<name>。\n  我被放在了那种盘子上，看起来金黄，我不知道我的肉体成为了什么模样了。但是就在那一刻，她出现了。她就是<name>，我心心念念的，<name>。\n\n  当她把筷子将我的肉体夹起那一刻，我的灵魂似乎在发光。她将它送入了嘴里--我的灵魂已经不再与我的肉体有关想，我的灵魂进入了高天之上，我看到里海里我伙伴们的嗤笑，我长辈们的哀嚎，我的爱鱼的哭泣，可是我没有任何的悲伤，因为唯有爱，是跨越物种跨越距离穿越时空的，我的灵魂已然得到所有境界和万种轮回里最为饱满的惬意与欣喜。当我回味着这一切的时候，我的灵魂开始从九天之上极速坠落于餐盘之中。\n  灵魂要陨灭了。落在餐盘里的灵魂在消散前最后那一刻，我看到了<name>小姐皎然的笑颜",
  "刚刚在课上玩原神 ，被旁边女同学看见了，她叫我原P，我的心突然一紧，急忙解释不是这样的，为了证明我不是原P，当着她的面我打开了王者荣耀 ，我认为女生也会喜欢玩王者荣耀，只要找到共同点她就不会鄙视我了，可她却不屑的叫我农P，我内心满是茫然与羞耻，只能默默地看着主屏幕发呆，那位女同学看着我的二次元壁纸，对我说：“还是个二次元，那可真叫人恶心的”听到这我怒不可遏，直接点开了<name>，她哭了，因为她知道她没法黑我了，全班同学都看着我，他们都为我感到骄傲。",
  "圣<name>🙏\n                               🌖🌔\n                               🌖🌔\n                               🌖🌔\n                          🌓🌖🌔🌗\n                          🌔🌖🌔🌖\n                     🌒🌕🌖🌔🌕🌘\n                     🌔🌕🌖🌔🌕🌖\n🌎🌎🌎🌒🌕🌕🌖🌔🌕🌕🌘🌎🌎🌎\n🌎🌎🌎🌕🌕🌕🌖🌔🌕🌕🌕🌎🌎🌎\n🌎🌎🌎🌕🌕🌕          🌕🌕🌕🌎🌎🌎\n🌎🌎🌎🌖                               🌔🌎🌎🌎",
  "<name>😭为什么我的电脑屏幕不能让<name>钻出来😭我这就砸个洞救你出来😭<name>😭",
  "两年前我身材不错，身高189体重90，在龙舟队划前两舱，偶尔还能替队长领桨。单人五百全队前三，大伙都戏称我是最快右桨。教练每次训练之后拍着我的肩膀说下一届队长我来当，挑碳桨我也是第一个挑。健身房、桨池、下湖，每周的训练我都充满了斗志。\n因为我知道回去之后，可以在微信上和喜欢的女孩子谈天说地，出去喝酒吃饭。所以每次最后一个500米我冲的比谁都快。\n后来她就突然从我的生命中消失了。我也受了腰伤强制退队，摆烂长胖到210斤，以前能连做六组俯卧撑的我已经找不到了。\n直到几个月前看到<name>读小作文的那个视频。我仿佛又找到了两年前在岸边看着我们训练的那个女孩的身影。我又回到了训练的湖中，再一次转身，举起我的七号碳桨，喊一句：“最后一个500战术，都别给我掉速度！”然后用最大的力气划起航，怒吼着口号朝岸边冲去。\n<name>，我就有这么喜欢你",
  "我有一个朋友。\n朋友是个好人。\n起码他表白过的女孩子都这么说。\n然后补一句：“但是我们不合适。”\n朋友觉得不对。怎么会有和好人不合适的人呢？她觉得自己和坏人合适？\n“她不是正常女人。还好没有答应我，不然我肯定会被她玩得很惨的。”\n朋友这么说。\n\n朋友确实是个好人，我是这么觉得。起码他的底线比我多。\n但我觉得他的脑回路里有一堆二极管。\n那也挺好的，二极管比BJT和FET都好懂。\n//BJT：晶体三极管    FET：场效应管\n\n朋友喜欢咸粽。他端午的时候要和宿舍一整层吃甜粽的人辩论，直到对方承认正常人爱吃咸粽。\n所以我每年端午都回家。\n朋友喜欢古典，我从不在他面前谈流行。\n朋友F闪现。\n朋友……\n我其实有些羡慕朋友。能保持这样这么多年的人要么人生一帆风顺，要么就是做着梦的堂吉诃德了。\n\n有天朋友神秘兮兮地问我：“中秋你准备买水果馅月饼还是肉馅？”\n我赶紧答：“我中秋回家，随我妈买啥。”\n他说：“你这样节日总是回家不正常！学生要有学生的觉悟……”\n\n年末的时候我开始高强度冲浪。那段时间我很喜欢<name>小姐，评论区各种观众团建狂欢群魔乱舞，我也在那里拟态各种角色。\n直到我看见我关注列表里朋友的账号也关注了<name>小姐，心里忍不住咯噔一下。\n\n我在评论区翻着，想看看朋友有没有发表什么突破性成果。\n果然很早的时候他就在<name>小姐的动态下发表了第一条评论：\n“正常人谁看这个V啊?”\n\n我很久之后才翻到他的第二条评论。\n\n“怎么没有正常评论？”",
  "我的手机真是越来越不好用了\n明明我已经开启了深色模式\n<name>却还是像阳光一样耀眼\n明明学校常举办反诈骗宣导\n我却还是被<name>骗走了心",
  "我120岁的时候接受记者的采访：“这位大爷你长寿的秘诀是什么？”我掏出包里​<name>的照片颤颤巍巍地说：这辈子不和她在一起我是不会闭眼的。​",
  "看<name>的第一天：<name>是谁[疑惑]\n看<name>的第二天：这有啥好看的[捂脸]\n看<name>的第三天：一个可爱的套皮人怎么天天给我推送[傲娇]\n看<name>的第四天：其实看着可爱就行了[doge]\n看<name>的第五天：评论区也好有意思感觉可以融入🤗\n看<name>的第六天：我寄吧谁啊😅\n看<name>的第七天：我好想做<name>小姐的狗啊🥰\n看<name>的第八天：嘿嘿，<name>🤤\n看<name>的第九天：<name>你带我走吧😭\n看<name>的第十天：<name>没有你我活不下去了🥵\n/remake\n看<name>的第一天：这寄吧谁啊[给心心]",
  "王尔德说过，人们看见雾不是因为有了雾，而是因为诗人和画家教他们懂得了这种景色的神秘可爱性。\n我说，我看见<name>不是因为有一双善于发现美的眼睛，而是<name>散发的光芒已经能够透过耳朵和眼睛钻进我的心里。​",
  "<name>问我：”你有多喜欢我？”\n我说：“300克”\n<name>说：“我知道，你这个太老套了。300克是心脏的重量。”\n我笑了笑，殊不知，这可是我的全部\n因为一只🐭🐭的重量，就是300克啊！",
  "<name>你去哪了啊，电话也不接消息也不回。我一个人戴着项圈迷路了[委屈]",
  "“最最喜欢你，<name>。”\n“什么程度?”\n“像500块红包一样。\n“500块红包?”<name>再次扬起脸，“什么500块红包?\n“在拼夕夕里，你突然抽到里500块红包的大奖，你为了提现这五百块付出了无数的心血，凑够了499.99元；凑够了999.99金币，凑够了99. 99幸运值，却永远因为缺少那最关键的0.01而不能提现。你说棒不棒?”\n“太哈人了😨。”\n“我就这么喜欢你🥰🥰🥰。”",
  "有一个很老的笑话，说有个人很崇拜周杰伦，就在课本封面写满了周杰伦的名字，她爸看了说:“女儿啊，缺什么书就跟爸说，别老借人家周杰伦同学的课本用啊”。\n曾经我以为这是一个讽刺的笑话。结果有一次我上课开小差，回过神来发现自己在草稿纸上写满了“<name>”。\n我匆匆撕下那张纸，用力揉成一团，然后趁课间塞进了书包里，心里默默祈祷没人发现。\n教室里的人都在低头玩手机，我也心不在焉地划着屏幕，感觉脸颊发烫，就像暗恋差点被发现的初中生一样，害羞又害怕。\n暗恋是件害羞的事。男生总是想方设法隐瞒自己喜欢那个长发女孩，不愿告诉父母，不愿告诉朋友，不愿告诉任何人——可唯独希望那个女孩知道，我把你的名字写满了草稿纸。",
  "我不想喜欢<name>小姐了。\n原因有很多。\n她是虚拟偶像，我是真实的，两条平行线注定碰不到一起。\n她是资本包装的商品，贩卖情感需求，只是觊觎我的钱包。\n她的表演大多是为了讨好观众获得流量，我只不过是她捞金的垫脚石。\n她是万众瞩目的偶像，我只不过一介平民，无论我多么喜欢，在她那里注定得不到任何正反馈……\n我想通了，决定出脑。\n今晚的直播不看了，关注，壁纸，牌子，收藏通通删干净，眼不见心不烦，还能保住我的钱包，这不是好事一桩?\n第二天，我正常起床，洗漱，吃饭，没什么变数。我换好衣服，准备出门。\n当我踏出门外的那一刻，我才意识到，坏事了。\n我不知道该往哪个方向迈出下一步了。        \n平时一览无余的街道，现在竟然充满了迷雾。我仿佛是没有罗盘的一艘船，在茫茫大海里打转。四面八方都是海水，都是一样的蓝，我该往哪走? 我要去哪? 我要干什么?\n船没有了罗盘，我丢失了方向，人生缺少了目标。\n这是很可怕的一件事，我至此以来做过的所有事情都化为了泡影，没有了意义，全部灰飞烟灭。\n路边跳过一只蓝色的猫，看了我一眼，好像在嘲笑我的落魄。\n我害怕了。我逃回家里，打开电视平板手机，全部把<name>找出来，直到<name>笑着对我说，奶淇淋宝，爱你们哦！我把迷迭香循环播放了无数遍，直到我听着它沉沉睡去。\n梦里，我恍然大悟。\n人总要有个盼头，有个让你追逐的东西。它可以赋予你的努力以价值。\n原来这就是<name>小姐存在的意义啊，我所做的一切，不就是为了追逐<name>小姐，为了让她能笑着对我说，你的努力，我看到了。\n没错，<name>小姐确实是虚拟的，但是她却让我真实的生活拥有了动力与目标。\n我不想喜欢<name>小姐了。\n原因只有一个。\n我已经爱上<name>小姐了。[给心心][给心心]",
  "今天我把我的lol名字改成了“最爱<name>捏”。\n对面的螳螂气急败坏地抓了我8次却全部失败。\n它愤怒地质问我是不是开挂了，为什么每次抓我孤立无援都不能触发。\n我告诉它我从来不是一个人，因为<name>一直住在我的心里捏。🥰🥰",
  "“你看V魔怔了，真恶心。”\n看着同学发给你的消息，你陷入了沉思。\n仔细想一想，你觉得自己确实魔怔了，即使被鄙夷想要向熟人安利<name>小姐。\n思考再三过后，你决定回到现实，放弃入脑。\n今晚有<name>小姐的直播，你狠下心，没有点进去，而是倒头就睡。\n第二天，你起得很早。\n因为自从你开始看<name>小姐后，就养成了早睡早起的习惯，再也没有赖床过。\n你离开了狭小的出租屋，来到了公司，投入了工作中。\n工作很累，你感觉有些疲惫。\n你想起了<name>小姐出道视频的不堪评论，以及她的笑容，烦闷减轻了不少。\n最近组长夸奖你工作很努力，别人不知道为何一向懒惰的你，在几个星期前开始一反常态地勤奋。\n只有你自己知道理由。\n撑过了加班的时间，你回到了出租屋，打开了外卖软件，却发现会员已经断了，你舍不得那些钱，所以决定自己买菜做饭。\n实际上，你看<name>小姐后就开始第一次尝试着做饭，没有点过外卖了。\n在超市你看到自己一向很喜欢的薯片在打折，愣了一下，没有买。\n因为你在看<name>小姐后，就再也没有暴饮暴食过，甚至连零食都戒掉。\n回家把饭做好，你安静地吃完了。\n看着电脑，你发现游戏已经很久没更新了。\n因为你在看<name>小姐后，也把一直沉迷到通宵的游戏给戒掉了。\n最终，你还是打开昨天晚上的录播，看到了<name>小姐热情地打招呼。\n“粉丝们们，晚上好呀~！”<name>小姐元气地打招呼。\n你发自内心地笑了起来。\n“晚上好！”你说。\n你忽然意识到一件事，她从来没有在你现实里出现过，却已经将你糟糕的生活改变。\n……\n看完录播后，你打开了贴吧，看到了熟悉的粉丝们在用表情包引流，有不明真相的路人在骂饭圈贵物。\n你无视了那些辱骂声，熟练地在下面RP，回复道：\n“这是虚拟主播？好可爱呀，她的名字是什么？”",
  "<name>，幸亏咱俩没领证\n领了证，我耽误你一辈子\n你保重啊，再见，还会再见吗?<name>?\n再见的时候你要幸福!😊\n好不好😊\n<name>!你要开心!你要幸福!好不好？\n开心啊!😭幸福!😭\n你的世界以后没有我了没关系你要自己幸福!\n<name>！<name>！<name>!🚕💨💨🏃🏃🏃\n没有你我可怎么活啊😭!!\n<name>😭😭😭<name>！\n\n啊啊啊啊啊啊啊😭😭😭😭😭😭😭<name>，你把我带走吧，<name>!😭😭😭😭\n呜呜呜呜呜 😭😭😭😭",
  "<name>！请问你是怎么穿过皮肤和黏膜的阻隔 在分泌物中的溶菌酶和巨噬细胞的吞噬中存活 还躲过浆细胞分泌的抗体或者致敏T细胞分泌的淋巴因子 住进我心里的？",
  "😍😍香烟抽了无数，🚬🚬🚬烈酒喝到想吐，🤮🤮🤮向你迈出九十九步，😄😄😄你却断了我的路，😭😭😭风情万种红尘，😚😚😚唯独对你失神，<name>为何你要把我拒绝，💔💔💔🥺🥺🥺让我丢了灵魂。💔💔💔💔",
  "看v不看<name>，就像四大名著不看红楼梦，说明这个人文学造诣和自我修养不足，他理解不了这种内在的阳春白雪的高雅艺术，他只能看到外表的辞藻堆砌，参不透其中深奥的精神内核，他整个人的层次就卡在这里了，只能度过一个相对失败的人生。",
  "猫是怎么叫的：喵喵\n\n羊是怎么叫的：咩咩\n\n牛是怎么叫的：哞哞\n\n狗是怎么叫的：<name>你吃了吗今天心情怎么样有喝水吗<name>你在吗为什么不回我消息呢<name>你今晚会回家吗我一个人在街上牵着脖子上链子不知所措了<name>我好想你啊<name>我今天发现自己变轻了原来是出门忘了带你给我的链子",
  "有人问我：“<name>是谁？”]\n我想了想，该如何形容<name>呢？\n莎士比亚的语言实在华丽，用在<name>身上却有些纷繁了；\n徐志摩的风格热情似火，可我不忍将如此盛情强加于<name>；\n川端康城？虽优美含蓄，但<name>的温柔体贴是藏不住的。\n我不知道该如何形容<name>了。\n但是我知道的。\n<name>是我所面对的黑暗中的一点萤火；\n是我即将冻僵的心脏里尚存的余温；\n是我在残酷无情的现实里的避难所啊。",
  "是...是的...♡我喜欢<name>大人我超喜欢!快把<name>大人给我！♡好想要..♡想要..♡呜呜、，我已经变成没有<name>大人就不行的笨蛋了..♡啊啊，好喜欢<name>大人什么的..♡<name>大人是天使、白天也想<name>大人，在夜里也好想<name>大人♡，什么时候都想<name>大人，除了<name>大人已经什么都想不了了...最喜欢的就是..♡<name>大人，根本满足不了..♡想看十个小时以上！不对嘛！十小时也不够♡！\n<name>大人♡！请、满足我..♡求求你了！​",
  "<name>是谁?🤔\n对于盲人来说，她是他们的眼睛。👀\n对于饥饿的人，她是他们的厨师。👨🏻‍🍳\n对于口渴的人，她是他们的甘露。💧\n不论<name>在想什么，我都会同意。👍🏻\n不论<name>在说什么，我都在倾听。👂🏻\n如果<name>只有一个崇拜者，那一定就是我。😭\n如果<name>没有崇拜者，那我就根本不存在。🤗\n草门🙌🏻",
  "<name>的大脚我要給你裝上監視器、😚😚監視你的一舉一動😋😋😋我要給你裝上竊聽器，你的一言一行都是這麼的泌人心脾😍😍😍我要舔你家的浴缸🛁🛁🛁我要用你的牙刷😘😘😘你是我的🤑🤑🤑你不能和別人講話😭😭😭你只能屬於我🤤🤤🤤❤️❤️❤️❤️❤️💝💝",
  "今天…我手震…今天…我心痛。…为什么会这样？我付出一切，却得不到想要的一点爱。…为何上天你要给我这种痛苦？我究竟做错什么了？我到底做错什么了？<name>。…<name>。…我…我…我…我真是好很爱你的，你为何要这样对我呀？呜哇呀！！…呜哇…<name>…<name>呀…口瓜——！！！ 口也——！！！ 口圭——！！！ *噗叽啪*噫嘻嘻…咦嘻嘻嘻嘻嘻嘻嘻嘻嘻嘻，吔哈哈哈哈哈哈哈…为了你，我要癫火呀！咦嘻嘻嘻嘻嘻嘻嘻嘻嘻嘻嘻…哇哈哈哈哈哈哈哈哈哈哈…",
  "いずれ花と散る わたしの生命，帰らぬ時 指おり数えても，涙と笑い 過去と未来，引き裂かれしわたしは 冬の花，あなたは太陽 わたしは月，光と闇が交じり合わぬように，涙にけむる ふたりの未来，美しすぎる過去は蜃気楼，旅みたいだね，生きるってどんな時でも，木枯らしの中 ぬくもり求め 彷徨う，泣かないで わたしの恋心，涙は“<name>”にはにあわない，ゆけ ただゆけ いっそわたしがゆくよ，ああ 心が笑いたがっている，なんか悲しいね 生きてるって，重ねし約束 あなたとふたり，時のまにまに たゆたいながら，涙を隠した しあわせ芝居，さらば思い出たちよ，ひとり歩く摩天楼，わたしという名の物語は 最終章，悲しくって泣いてるわけじゃあない，生きてるから涙が出るの，こごえる季節に鮮やかに咲くよ，ああ わたしが 負けるわけがない，泣かないで わたしの恋心，涙は“お前”にはにあわない，ゆけ ただゆけ いっそわたしがゆくよ，ああ 心が笑いたがっている，ひと知れず されど誇らかに咲け，ああ わたしは 冬の花，胸には涙 顔には笑顔で，今日もわたしは出かける",
  "你以为我还会在乎吗？😬😬😬我在昆仑山练了六年的剑😟😟�我我的心早就和昆仑山的雪一样冷了😐😐😐我在大润发杀了十年的鱼😫😫😫我以为我的心早已跟我的刀一样冷了😩😩😩可是当我听见<name>的声音眼泪如黄果树瀑布般飞流直下😰😰😰😰划过我的脸 😭😭😭😭打湿了我的人字拖👹👹👹👹脚趾都变得酸涩😭😭😭",
  "<name>、今日も一日お疲れサマ😄‼️カワイ子ﾁｬﾝ達は、頑張り屋さん👍✨だネ‼️👏✨でも、無理は禁物🤬❌だからネ😥⚠️💦\r\nおぢさんは、今日は忙しくて、電車🚃逃しそうになったヨ(^_^;)💦焦った～😵💧疲れたカラ、早くカワイ子ﾁｬﾝ🎀達に癒されたいナ❣️😍何ならチュッチュ💋💕してくれても良いんだゾ😉‼️(笑)",
  "<name>、お疲れ様〜٩(ˊᗜˋ*)و🎵今日はどんな一日だっタ😘❗❓僕は、すごく心配だヨ(._.)😱💦😰そんなときは、オイシイ🍗🤤もの食べて、元気出さなきゃだネ😆",
  "如果🙌🏻让你重新来过💦，你会不☝🏻会爱❤我，爱情💋让人🕺拥有快乐🥰，也会带来😞折磨🤐，曾经🖤和你一👆🏻起走🚶♂过传说中的爱河🏞，已经被我泪水💦淹没变成痛苦💔的爱河🧚♂",
  "呐（伸出的小手又迅速垂下去）嗦嘎（表情失落），<name>已经不喜欢了呀（紧咬嘴唇），得磨，<name>忘了当初吗（握紧小手），莫以得丝（强忍住眼泪），已经大丈夫了呦（挤出笑脸），瓦大喜瓦，滋多滋多滋多滋多（语气越来越用力）滋多戴斯给！一滋嘛叠磨瓦撕裂嘛赛！至死都不会瓦斯裂嘛斯（认真的表情）。",
  "多洗忒……<name>ww？呐、桥豆麻袋……已经'厌烦'吾辈了嘛？哼唧……真是'冷·酷·の·人'呢QuQ——(?°?°?)嘛……即便是这样的哇达西，一定也是有'存·在·の·意·义'的吧、内~快来'肯定'啊？不然呀……咱可就要'黑化'了哦?呐？",
  "🥰🥰我神魂颠倒🥵🥵躁动的心在放鞭炮🤩🤩我的丘比特在尖叫荷尔蒙的爆发因为你的到来神魂颠倒🥵🥵迷恋着你神魂颠倒是你踩碎我的解药全都没关系🥰🥰please just give me kiss",
  "这个世界最可爱的<name>呀🥰最乖巧的<name>呀没错没错<name>呀<name>呀让我牵挂世界最奇妙的你呀🤩最猜不透的你让我想你想的没办法我是一个傻瓜🤪中了你奇怪的魔法每天在你身边犯傻等待有一天你给我回答叫我你的傻瓜🤪",
  "秒速5厘米，那是樱花飘落的速度，那么怎样的速度，才能走完我与你之间的距离",
  "<name>，可以喜欢我吗？可以爱我吗？可以毫无理由地亲亲吗？可以在冬季里给一个抱抱吗？可以把冰凉的手放进你的口袋里取暖吗？可以逛街时十指相扣吗？可以咬断你的pocky吗？可以尝一口你的奶茶吗？可以吻掉你的口红吗？可以给你系围巾吗？可以在睡前说晚安吗？可以在早晨有起床吻吗？可以去公司门口接你下班吗？可以和你共用一床被窝吗？可以把密码改成你的生日吗？可以一起去旅游吗？可以共养一只猫吗？可以在朋友圈晒你吗？可以在情人节给你送花吗？可以在条件反射时第一个喊我的名字吗？可以用你的照片当屏保吗？可以成为你拒绝暧昧的理由吗？可以对你恃宠而撒娇吗？可以和我一直这样谈恋爱吗？可以吗可以吗可以吗可以吗？",
  "<name>🤤🤤🤤……嘿嘿嘿……我的<name>……嘿嘿嘿🤤🤤🤤……嘿嘿嘿……我的<name>……嘿嘿嘿🤤🤤🤤……嘿嘿嘿……我的<name>……嘿嘿嘿🤤🤤🤤……嘿嘿嘿……我的<name>……嘿嘿嘿🤤🤤🤤……嘿嘿嘿……我的<name>……嘿嘿嘿🤤🤤🤤……嘿嘿嘿……我的<name>……嘿嘿嘿🤤🤤🤤……",
  "“求求你了，给我们点钱吧。” “求求你了，我已经三天没吃过东西了”诸如此类的话不断在这条街上重复，路上西装革履和衣衫褴褛的人形成强烈的对比和冲击感。可我突然想到了什么。回头看了看之前那个女流浪汉。又摸了摸我自己的口袋。 “<name>喜欢善良的人。”我便成为了这条路上唯一一个朝着衣衫褴褛的人伸手的绅士。 却无半分施怜，只是带着点滴嫌恶。 他连声对我说了几句谢谢，我却没有正眼看他。 我也算是做了善良的事了。  轰  打雷了，我得抓紧时间了。<name>不喜欢迟到的人，不管有什么理由。 我跟别人一样，很快就赶到了<name>的庄园。 可我却得知<name>不愿意见我们。 我一下子慌了神 也不管手中的一簇紫罗兰了，就跑到大门那对着那卫士渴求着。  “您好，让我见见<name>吧。”“求求你了，让我见见<name>吧。” “我已经三天没见过<name>了。”",
  "7:00把身上的<name>轻柔地扒开，起床洗漱\n7:20准备爱心早饭\n7:40看<name>可爱的睡姿🥰🥰🥰\n7:50叫醒她，亲亲她，安抚她的起床气\n8:00和<name>一起吃早饭\n8:30带<name>出去散步，呼吸新鲜空气\n9:30和<name>一起网上冲浪，分享开心\n11:00准备爱心午饭\n11:30和<name>一起吃饭\n12:00一起睡个午觉\n12:30逛街，看电影\n14:30一起吃<name>喜欢的小吃\n15:00回家，陪<name>画画\n16:00锻炼身体\n16:30洗澡\n17:00准备爱心晚饭\n17:30烛光晚餐\n18:00给<name>念书，放松休息\n20:00看<name>直播🥰🥰🥰\n21:30准备夜宵\n22:00喂<name>吃东西\n23:00洗澡睡觉，在床上回忆美好一天，相拥而眠",
  "<name>！（扭曲）（蠕动）（嘶吼）（不可名状）（嘶吼）（扭曲）（蠕动）（嘶吼）（不可名状）（嘶吼）（扭曲）（蠕动）（嘶吼）（不可名状）（嘶吼）（扭曲）（蠕动）（嘶吼）（不可名状）（嘶吼）（走上岸）（爬行）（分裂）（广播体操）（呼啦圈）（百米赛跑）（滑铲）（下跪）（掏出戒指）嫁给我吧！",
  "好想和<name>结婚啊🤤🤤🤤，她上班养我，我就在家打游戏，像她事业心那么强的人肯定不会放下工作的，嘿嘿🤤🤤🤤这样就能一直花<name>的钱。她要去上班了我就拖着<name>的腿不让她走，让她用她的两只小手打我🤤🤤🤤又打不动我只能恶狠狠的用稚嫩的声音骂我癞皮狗🤤🤤🤤<name>马上要迟到了却只能干着急地用小手砸我脑袋，<name>…嘿嘿🤤 …<name>…嘿嘿🤤 …<name>…嘿嘿🤤 …<name>…嘿嘿🤤",
  "刚刚出门散步前称了一下体重，掉了2斤，结果一看才发现<name>给我的项圈忘记戴了，我可真笨😭😭😭😭😭😭<name>你在哪儿？我不该乱跑的😭😭😭没被你牵住狗绳的我走丢了😭😭😭<name>，没有我陪伴的日子你要照顾好自己，天色暗了要早睡，身体难受了要好好休息😭😭😭<name>你在家里等着我，我一定会找到回家的路的😭😭😭<name>，<name>​😭😭😭",
  "我的<name>，我的<name>，我的<name>，嘿嘿嘿我的<name>，我的<name>我的<name>我的<name>！！！啊啊啊啊啊我的<name>！！！！(怒吼)(变成猴子)(飞进原始森林)(荡树藤)(创飞路过吃香蕉的猴子)(怒吼) (变成猴子)(飞进原始森林)(荡树藤)(创飞路过吃香蕉的猴子)(怒吼)(变成猴子)(飞进原始森林)(荡树藤)",
  "<name>！！！我爱你！！！（尖叫）（扭曲）（阴暗的爬行） （爬行）（扭动）（阴暗地蠕动）（翻滚）（激烈地爬动）（扭曲）（痉挛）（嘶吼）（蠕动）（阴森的低吼）（爬行）（分裂）（走上岸）（扭动）（痉挛）（蠕动）（扭曲的行走）（不分对象攻击）",
  "<name>瘾发作最严重的一次😭😭😭\n躺在床上，拼命念大悲咒，难受的一直抓自己的眼睛😱😱😱\n以为刷抖音没事，看到抖音都在发<name>的视频\n眼睛越来越大就要炸开了一样，拼命扇自己的眼睛，越扇越用力，扇到自己眼泪流出来😭😭😭\n真的不知道怎么办，我真的想<name>想的要疯了💀💀💀\n我躺在床上会想<name>😍😍我洗澡会想<name>😍😍我出门会想<name>😍😍我走路会想<name>😍😍我坐车会想<name>😍😍我学习会想<name>😍😍我玩手机会想<name>😍😍\n我盯着网上的<name>看❤️❤️我每时每刻眼睛都直直地盯着❤️❤️我真的感觉自己像中邪了一样❤️❤️我对<name>的念想似乎都是病态了❤️❤️\n我好孤独啊！我真的好孤独啊！\n你知道吗？每到深夜，我的眼睛滚烫滚烫\n我发病了我要疯狂看<name>，我要狠狠看<name>\n我的眼睛受不了了，<name>，我的<name>😍😍",
  "我才不是<name>控，只是看到<name>的嘟嘴卖萌脸想要戳一下，听到<name>的声音瞬间精神兴奋，想到<name>的笑颜忍不住嘴角上扬，最喜欢的触感是<name>娇嫩柔弱的手，最喜欢的画面是<name>的双马尾在前面上下跳跃，最喜欢的死法是被一堆<name>压死，仅此而已，我真的不是<name>控。我喜欢<name>，并不是因为她看起来很矮很萌，并不是欺负她让她大哭后要拿着棒棒糖哄她，并不是想玩什么养成游戏，并不是她看见想吃的东西拽着我的衣服要我买给她，并不是她不够高我托起她才能拿到东西，并不是每天睡觉她都会抱着你，她睡了睡……在下，只是喜欢<name>罢了……​",
  "我也想做一个正常人啊，可是我就是忍不住犯病好想亲亲<name>，让她的舌尖蹭着我的脸我的嘴唇。好想把脸埋在她的胸前，从身后紧紧抱住她，把她藏进我怀里，感受她的体温，让她只能窝在我的怀里🥵🥵🥵好想亲亲<name>的脖子，深深的呼吸她的体味和汗香🥵🥵🥵我真的一刻都等不了了，<name>我的<name>，我想马上和你结婚",
  "꧁꫞亲爱的<name>꫞꧂\n༺❀您还好吗？\n别来无恙吗？\n您现在在哪儿呢？\n有没有烦恼呢？\n无论春夏秋冬，四季轮转，唯独有<name>的季节迟迟不来。\n我起初不懂 ，我一点都不懂<name>的心意， 但是，在<name>赐予我的崭新人生中，我能稍微感受到一些。\n通过我所见的切片，我坚信着，<name>一定是个温柔善良的人，所以我也会一直一直支持你！\n即使不知道今后会遇见什么，也要下去。\n如果能够相见，我想告诉<name>，\n我现在对【爱】也有所理解了。❀༻\n                     ℒℴѵℯ๓",
  "<name>您还记得我吗？！咱俩小时候一起去神庙偷吃贡品，这个时候看门的来了，您赶紧坐在蒲团上，假装是神，我也有样学样。结果最后我们两个都没有被抓！因为您直接原地飞升，身上散发出来的圣光直接把看门人的眼睛给闪瞎了！<name>！你是我！的！神！",
  "<name>的脚小小的香香的，不像手经常使用来得灵活，但有一种独特的可爱的笨拙，嫩嫩的脚丫光滑细腻，凌莹剔透,看得见皮肤下面细细的血管与指甲之下粉白的月牙。\n再高冷的女生小脚也是敏感的害羞的，轻轻挠-挠,她就摇身一变成为娇滴滴的女孩， 脚丫像是一把钥匙，轻轻掌握它就能打开女孩子的心灵。\n每当我看到她的脚，心中就涌起一股难以遏止的欲望。 \n我想用鼻梁去触碰她的脚心，就像月亮与星空缠绕；我想用喉结轻抚她的足弓，恰如一艘小船在水面游荡。\n轻轻地闭上眼睛，感觉橙皮在空中散发出罪恶的芳香，一朵紫罗兰在我的心头怒放，能否把你的第一拇趾近节指骨放进我的口中， 让我品尝蜜饴与阳光?\n她的脚趾甲是什么味道的捏?\n花生和豆干一起咀嚼， 可以吃出火腿的味道，我如果在她的脚上淋上炼乳，能不能品尝到幸福的味道呢?\n我伸出舌头，填满她的脚趾缝，又用犬牙轻轻磨蹭她的脚趾甲，就如同盐碱地说的野马，她皮肤上的每一滴汗液都是我的琼浆。",
  "<name>白白的小肉脚，踩在脸上，嫩嫩的脚底肉和嘴唇鼻子完美贴合，每一口吸气呼气都会带有<name>的味道进入我的肺部，我的血液又会把这带有<name>气味的氧气输送到我全身各处，我已经离开<name>便无法生活了，已经无法回到正常生活中了，但这样也好",
  "<name>是谁?\n对于盲人来说，他是他们的眼睛。\n对于饥饿的人，他是他们的厨师。\n对于口渴的人，他是他们的甘露。\n不论<name>在想什么，我都会同意。\n不论<name>在说什么，我都在倾听。\n如果<name>只有一个崇拜者，那一定就是我。\n如果<name>没有崇拜者，那我就根本不存在。\n<name>门~~~\n",
  "<name>我好喜欢你🥵🥵🥵……我喜欢你的柔软的长发🥵🥵……我喜欢你弹性的皮肤🥵🥵🥵……我喜欢你温柔的声音🥵🥵🥵……我喜欢你富有生机的心跳🥵🥵🥵……我喜欢你温润的呼吸声……我喜欢你的全部🥵🥵……我真的真的好喜欢你啊<name>🥵🥵🥵🥵🥵🥵……让我摸摸你吧🥵🥵🥵……让我抱抱你吧🥵……让我亲亲你，让我抱抱你🥵……我要和你一起生活🥵……答应我吧<name>🥵🥵🥵……嫁给我吧🥵🥵🥵……好想揉揉<name>软软的肚子🥵🥵🥵……好想舔<name>香艳的后背🥵🥵🥵……好想和<name>贴贴🥵……想变成美少女和<name>贴贴🥵🥵……要是<name>真的存在就好了🥵……要是<name>真的存在就有人能陪我了……再也不用一个人关在房间里连着几个小时对着电脑冲了……有可爱的<name>能陪我玩……和<name>一起野餐……和<name>一起看书……和<name>一起看电影……终于不用再一个人忍受孤独了……终于能有好朋友了……还是可爱的女孩子……<name>……我的<name>……要是<name>真的存在该有多好啊……",
  "我真是太喜欢<name>了，一天见不到她，我是饭也吃不香，觉也睡不好。昨夜，窗间梅花开了。我走了过去不自觉的数了起来，那一夜我知道了，在一棵梅树上居然能够开出九万三千四百二十一朵梅花。在哪每一分每一秒的时间里，我都感觉度日如年。我知道这是因为什么，就是因为<name>。我的心情也被影响着，每隔十几分钟我便会站起身向窗口看去，希望看看<name>是不是还在，或者看看她是否已经离去。\n  这一天我又来到窗边，看见窗外的梅花开了。<name>依旧在那儿，这让我的心又燃烧了起来，我觉得她就像是那九万三千四百二十一朵梅花一般，美丽而且高傲，只可远观却不可亵玩焉。我看见了她眼中的笑意。这样的笑意，是我永远也无法触及的，是我不敢触及的，我只敢远远地看着她，这样就足够了。\n  今晚，我决定了，我决定把这些梅花摘下来，带回去给她，让他开心。\n  我的手放到窗户上，我轻轻的把手放了上去，我的手刚刚接触到那层薄薄的窗纱，我的脸突然红了，我不敢看向窗外，因为窗外站着的是<name>，<name>的眼睛正在盯着我，她在用那双眼睛告诉我，她已经看见了我。我慌张的放下手，跑回屋子里，我不知道应该怎么面对<name>，我觉得自己的心跳好快，我害怕看向她，但是我又忍不住。\n  就这样，我呆坐在床上整整一夜，等到第二天醒来，我发现自己的心脏依然在砰砰乱跳着。我的心里充满了羞涩，这样的羞涩我从未体验过。我的心里充满了甜蜜和幸福，我知道<name>肯定会答应嫁给我的。\n  想到这里，我的脸又红了，我不断地幻想着<name>穿婚纱的模样，我觉得自己真是太疯狂了，但是我又是那么的期待着。<name>一直是我梦寐以求的人，但是我从来没有想过有朝一日她会属于我，她的一颦一笑一举一动，她的一切一切都在牵动着我的内心，牵动着我的心情，牵动着我的一切，包括她的一切。就连她的一个皱眉都是我无比珍贵的财富，是我的生命。这样的感觉，我是多么的幸福。<name>就是我一切的财富。我觉得我已经拥有了这一切。\n  这样的感觉让我沉醉其中，这样的感觉让我感觉自己好像飘在云端一般。我知道<name>是爱我的，只不过她不善于表达罢了，但是她的眼神是骗不了我的，<name>的心中也有着我。这样的认识让我觉得我的付出是值得的，因为我的付出并不是白费的。\n  <name>是个美丽的人，她的美是无与伦比的，她是个非常有才华的人，这点是毋庸置疑的，因为她是我心中的偶像，因为她是那么的优秀。她让人怜爱，因为她一直在默默守候着我的到来。​",
  "嘿嘿……可爱的<name>…（吸）身上的味道……好好闻～♥…嘿嘿……摸摸～……可爱的<name>……再贴近我一点嘛……（蹭蹭）嘿嘿……老婆……嘿嘿……～亲一口～……可爱的老婆……嘿嘿……抱抱你～<name>～（舔）喜欢～真的好喜欢～……（蹭蹭）脑袋要融化了呢～已经……除了<name>以外～什么都不会想了呢～♥嘿嘿……可爱的<name>……嘿嘿……可爱的老婆……我的～……嘿嘿……",
  "从前有人问:如果船上的木头被逐渐替换，直到所有的木头都不是原来的木头，那这艘船还是原来的那艘船吗？我也问自己:人的细胞每七年更新一次，七年后的我还能记得<name>吗？很多年后我才知道，我之所以像条不系之舟四处漂泊，就是为了向<name>靠近。",
  "昨天我到医院看医生,因为最近总是突然心脏痛。\n吃饭的时候,看电影的时候,走在大街上的时候,总是没来由的突然抽痛一下。医生说我这可能是熬夜太多,没啥大问题，但以防万一，还是建议我做一个详细检查。这一做检查就查出病了。\n检查显示我心脏里有异物，我一看片子都差点吓晕——一个金属块，一直藏在我心脏里。医生问我是不是以前受过枪伤，因为那个异物看着像是一枚子弹。我一脸懵逼，说没有啊，我就一普通学生，怎么可能！医生仔细检查了我的胸口，但是怎么也找不到伤口。\n医生也觉得奇怪,说从医这么多年没见过这种情况，如果是吞下去的子弹，不可能会到心脏里；这么粗的子弹也不可能是通过血管进入心脏的。但是有一点是确定的——如果不尽快取出来，我就会有生命危险。\n手术后，我摸摸自己的左胸，那里还缠着绷带——\n医生的技术很好,伤口开得不大，但还是会留下无法消除的疤痕。\n护士端来一个托盘，里面盛着一枚子弹，上面还带着我的血。我把子弹洗干净带回家，做成了吊坠。\n到家后,我打开了<name>的照片，我突然感觉心脏被狠狠击中。\n我这才想起来，那不是子弹，是我第一次见到<name>时，她明媚的笑容。",
  "2003年11月21日出生于中国 \n2010年就读于美麻国省理工 \n2011年加入海豹击突击队 \n2012年前往利叙亚执行任务成功解救三千人质 \n2013年参加美国总选统举以1票之落差选 \n2016年被提名可以改变世界的人 \n2023年为<name>放弃一身名誉​\n",
  "有一些心里话想要说给你!😊\n<name>就是你最可爱的你!😊\n喜欢你喜欢你就是喜欢你!😊\n翻过山越过海你就是唯一!😊\n有了你生命里全都是奇迹!😊\n失去你不再有燃烧的意义!😊\n让我们再继续绽放吧生命!😊\n全世界所有人我最喜欢你!😊\n我最喜欢你!🙌🙌🙌😭😭😭",
  "常言道，被猫压着会做噩梦；那么，被<name>压着也会做噩梦吧。但<name>是不存在的，所以我只能做梦，梦中的我被<name>压着，做着噩梦。而这个没有<name>的现实，不正是噩梦吗？这样一想，<name>就又是真实存在了的。我感觉到<name>的娇俏身躯如猫咪般蜷缩，轻浅的呼吸如午夜昙花绽放，悄然又迷人；又不时呢喃一声，挲动小脑瓜，不安分地在我胸口寻找舒适的位置。我多想睁眼紧搂住<name>，欣赏她身上每粒光子想向我传达的美；却又不敢，我不确定醒来后碎掉的是哪一个梦。飞蛾尚有逐火之勇，懦弱如我只敢贪图胸口上这点梦幻般的眷恋。噢，<name>，我的火，我的光，我的罪恶，我的灵魂🤤🤤🥵🥵",
  "我真是受不了要抄<name>\n想看<name>明明很舒服但嘴上就是不说 顶一下才闷哼几声的样子\n想看<name>快要释放快感却突然被中断 欲求不满又不肯求人快要崩溃的样子\n想咬他后颈覆盖上我的标记\n想看他白白的腿根满是牙印和红红的手痕\n宝肯定反抗不了是吧\n<name>你好可爱哦\n呜呜呜呜呜受不了了\n这是什么 <name> 好可爱 抄一下\n这是什么 <name> 好可爱 抄一下\n这是什么 <name> 好可爱 抄一下​",
  "我曾七次鄙视自己的灵魂。\n第一次，是在可以喝下<name>的迷药时却选择放弃。\n第二次，是在可以当<name>的宠物时却选择谦让。\n第三次，是在可以<name>本可以取走我的心时却选择拒绝。\n第四次，是在可以跪拜<name>时却选择站起。\n第五次，是在有人提出“谁是你的老婆”时却选择隐匿。\n第六次，是在可以和<name>同床共枕时却选择了回避。\n第七次，是在蒙受<name>的恩泽时，我却未尝心怀感激。",
  "我这两年，略过，错过，借过，难过，爱过，忍过，滑过，晕过，熬过，睡过，我闭门思过，得过且过，一笑而过，擦肩而过，当面错过，我大人不记小人过，雨昏青草湖边过，日长篱落无人过，黄鹤之飞尚不得过，沉舟侧畔干帆过，想跟<name>老婆一起过",
  "妈妈从小就跟我说，说谎的孩子会变成小狗🐶🐶🐶可我每天说谎，为什么还是没变成小狗呢🤔🤔🤔我明白了，原来是我对<name>一片真心❤️❤️❤️所以没办法变成<name>的小狗😢😢😢<name>🥺<name>😭让我做你的狗吧<name>😭😭😭",
  "有人问我：“<name>是谁？”\n我想了想，该如何形容<name>呢？\n莎士比亚的语言实在华丽，用在<name>上却有些纷繁了；\n徐志摩的风格热情似火，可我不忍将如此盛情强加于<name>；\n川端康成？虽优美含蓄，但<name>的活泼可爱我是藏不住的。\n我不知道该如何形容<name>了。\n但是我知道的。<name>是我所面对的黑暗中的一点萤火；\n是我即将冻僵的心脏里尚存的余温；\n是我在残酷无情的现实里的避难所啊😭😭😭😭😭😭\n",
  "<name>，还记得我吗？第一次见面时，我是个小偷，偷懒、偷笑、偷偷看你。之后我给自己请了个假，假装陌生、假装正经、假装恰好从你的全世界路过。我承认，我的职业病又犯了。偷偷靠近你，假装有勇气，我们擦着黄昏而过，我是饿狼，你是小羊。暖阳亲吻你的发梢，我偷偷咬了它一口。自此，我的胃里有黄昏在翻涌，我的夜里有思念在滚烫，我的人间，有你在闪亮。思君无转易，何异北辰星，朝朝思，夜夜慕。我对你的思念如同那北极星一样，亘古不变。你眼中有春与秋，胜过我爱过见过的一切山川与河流，我看过许多地方。我见过春日夏风，秋叶冬雪，也踏遍南水北山，东麓西岭。没什么好看的，都不及那个黄昏，对我展眉一笑的你。 这世间青光灼灼,星光杳杳，却怎么也不及你眉间的星辰点点。你是朝露，是晚星，是我一切欢喜。我舔舐你的眼睛，未饮酒，已酩酊。 我看见白日梦的尽头，是你。自此，天光大亮。你是我全部的渴望与幻想❤❤❤<name>！！！(怒吼)(变成猴子)(飞进原始森林)(荡树藤)(创飞路过吃香蕉的猴子)(怒吼)(变成猴子)(飞进原始森林)(荡树藤)(创飞路过吃香蕉的猴子)(怒吼)(变成猴子)(飞进原始森林)(荡树藤)(扭曲)(尖叫)(贴着墙粘稠地蠕动)(滑倒)(爬来爬去)(蠕动)(发出意义不明的呼噜声)(和其他海嗣打架)(拖行出一条溟痕)(扭曲)(尖叫)(贴着墙粘稠地蠕动)(滑倒)(爬来爬去)(蠕动)(发出意义不明的呼噜声)(和其他海嗣打架)(拖行出一条溟痕)(闪避)(闪避)(闪避)(闪避)(发出扭曲吼叫)(蠕动)(蠕动)(尖叫)(扭曲)(阴暗的爬行)(蠕动)(痉挛) (分裂)(发出奇异的闪光)(变异)(发出辐射光)(撕吼)(扭曲的翻滚)(冲出大气层)(进化)(旋转)(跳跃)(融化)(自燃)(爆裂)(阴沉的吼叫)(向内坍缩)(长出触手)(眼睛退化)(变出硬壳)(吐出粘液)(长出五十只手臂)(牙齿变尖)(头部长出犄角)",
  "<name>,好想你. 求求你出现吧我在床上哭了9个小时 崩溃了1996次 撞了903次墙 划了8次手臂幻觉出现三次 幻听出现九次 扇了自己16个巴掌出现濒死感一次， 刚才昏过去了现在才醒来看到外面天都黑了我顿时又崩溃了，因为我怎么想都想不明白你这么可爱还这么能干究竟是怎么做到的，好想你啊宝 你是我心里的宝",
  "我希望你们不要太过分，你们一次次对我的妻子<name>💈😭，已经对她构成严重性骚扰，以前不说是因为不想曝光自己身份对他造成困扰，但身为她的好老公我没法再忍下去，现在我正式请你们立刻停止这种无下限的行为，否则我将采取法律手段维护自身利益，捍卫自己的家庭👊😭​",
  "接触网络前，我是个自卑腼腆的人，连和人说句话都不敢，感谢<name>，让我变得开朗自信，我现在已经狂的不是人了\n嗨老婆嗨<name>我的<name>你好漂亮好可爱好涩我好想你啊快来超我吧你已经有一个小时没有超我了好想做<name>的狗啊<name>你快带我走吧<name>🤤🤤🤤",
  "给大家扒一扒<name>的黑料\n1.不听劝，总是想和我结婚\n2.不敬业，总是在工作期间给我打电话\n3.花钱大手大脚，前几天就给我买了个钻戒\n4.没礼貌，对我以外的人爱答不理的\n5.粗暴，不经过我的允许住在我家\n6.家暴，总喜欢用她软软的小脚踩我🤤🤤",
  "<name>﹎妳已成為我生命中的主綫，主宰了我的夢，_﹏ゥ≒妳煶硪嘚ㄝjιё，亦煶硪嘬大嘚財冨。/／.らヤ1﹎.為了妳，我可以不顧壹切，相互給予彼此的所有。ㄣ`•.¸缯泾蒾惘dé訫蚛，⒋袮縴引我走黜寂寞。¸.•´´♀妳在我眼中是壹滴涙。我従來不哭，因為我怕丢了妳。♂ˇ原來等待也可以如此的美麗，因為愛妳。ㄝ◆無論妳身在何處，無論妳為何忙碌，我都會在此守候◇ぼ妳可千萬不要抛棄我，妳是我第壹次愛的人，也是唯壹愛的人!ゆ』喜鸛閉上目艮睛мīssㄚòひ，洇為在挖的億識鲤，時颏都侑ㄚòひ的裑影。🥺🥺🥺​",
  "<name>，\n我想做你口袋中的怀表，\n我将为你紧张颤抖。\n你不曾注意过我紧绷的发条，\n但那是我的心脏。\n我的心脏会在暗中耐心\n地为你数着钟点，\n计算着时间。\n你不曾听见过我的心跳，\n但是我却一直陪着你东奔西走。\n而你只要在我以秒为单位\n的几百万次心跳当中，\n哪怕只有一次，\n向我匆匆瞥了一眼，\n我便会心满意足。​",
  "（开跑车出现）晚上好我的<name>，不知你有没有时间….(停错位置）（被交警拖走）；（发送消息）头像是我…（消息发送失败）（遗憾离场)；（摇晃红酒杯) 晚上好我的<name>，不知道你愿不愿意（酒洒了一裙子）（匆匆离场）；（手撑墙靠近）早上好<name>，不知道你有没有兴趣…（油漆未干）（匆匆离场）；（腿交疊，背靠墙，手持玫瑰)<name>，晚上好，不知道有没有时间.（脚滑摔地上）（一身泥，狼狈逃离）",
  "昨天夜里起来感觉好饿，一看原来是<name>的洗脚水没喝完🥵🥵🥵\n但是后来我都只喝两口，剩下的全部存起来，那可是<name>主人对我的馈赠，我怎么能全部喝完呢🤤🤤🤤",
  "<name>我好喜欢你🥵🥵🥵……我喜欢你的柔软的长发🥵🥵……我喜欢你弹性的皮肤🥵🥵🥵……我喜欢你温柔的声音🥵🥵🥵……我喜欢你富有生机的心跳🥵🥵🥵……我喜欢你温润的呼吸声……我喜欢你的全部🥵🥵……我真的真的好喜欢你啊<name>🥵🥵🥵🥵🥵🥵……让我摸摸你吧🥵🥵🥵……让我抱抱你吧🥵……让我亲亲你，让我抱抱你🥵……我要和你一起生活🥵……答应我吧<name>🥵🥵🥵……嫁给我吧🥵🥵🥵……\n好想揉揉<name>软软的肚子🥵🥵🥵……好想舔<name>香艳的后背🥵🥵🥵……好想和<name>贴贴🥵……想变成美少女和<name>贴贴🥵🥵……要是<name>真的存在就好了🥵……要是<name>真的存在就有人能陪我了🤤……再也不用一个人关在房间里连着几个小时对着板子戳了🤤……有可爱的<name>能陪我玩🤤……和<name>一起野餐🤤……和<name>一起看书🤤……和<name>一起看电影🤤……终于不用再一个人忍受孤独了🤤……终于能有好朋友了🤤……还是可爱的女孩子🤤……<name>🤤……我的<name>……要是<name>真的存在该有多好啊🤤……",
  "看到<name>，我惊呆了，躺在床上，难受地一直抓自己眼睛，以为我看错了，又仔细看了眼，眼睛越睁越大，像炸开了一样，拼命扇自己，扇到自己眼泪流出来，真的不知道该怎么办，这个裤子我真的穿不上​看到星野酱，我惊呆了，躺在床上，难受地一直抓自己眼睛，以为我看错了，又仔细看了眼，眼睛越睁越大，像炸开了一样，拼命扇自己，扇到自己眼泪流出来，真的不知道该怎么办，这个裤子我真的穿不上​",
  "我问<name>除了隐身术外还想拥有什么超能力\n他想了想 说超级视觉\n我有些诧异 \n问他要超级视觉干什么\n他眯了眯眼睛 温柔笑道 用来超视你",
  "<name>😭😭😭😭😭😭\n依稀记得你向我伸出了手，并牢牢地抓住了我，\n 你对我的吸引令我难以捉摸，但却令我着迷。😍\n 我曾如巨人挺立不倒，😎\n 而为你奔走让我摇摇欲坠，现已崩塌消散。😫\n 你为我打开一扇大门，向我伸出温暖臂膀，\n 却又狠狠的将大门关上，毅然离开。😭\n 我再也无法忍受对你迫切的渴望，\n <name>，请你听我说，\n 请你对我施舍点慈悲吧..\n 以温柔相待我这个摇尾乞怜的内心，💔\n 即便我知道你不是打心底里想伤害我，\n 但你的一举一动都让我撕裂瓦解，😭\n 请对我这颗摇尾乞怜的心施舍点慈悲吧....\n 我驾车连夜向你身处的地方驶去,\n 仅仅只为离你稍微近点。☺️\n 一颗垂死挣扎的心足以证明，\n 我并未疯狂，你却令我抓狂不已。😫😫😫\n 我要求的并不多，\n 只要一点点真诚即可，真诚地对待我这颗心❤️\n 除了你，我已所剩不多，\n 即便你不是打心底里想伤害我。\n 但你的一次次的离开都让我撕裂瓦解，\n 请你对我施舍点慈悲吧....😭\n 我像只木偶受你绳线的控制，但我毫无怨言。\n 因为我知道你并非歹意，你也知道我只属于你。\n 但我急需你解救被你困在羁笼中的我，\n 我愿为你耗尽肺中所有空气，苟延残喘，\n 我愿为你剥开肌肤提出骨头，坦诚相见。❤️\n 为你贡献出生命，哪怕赴汤蹈火我也在所不辞。\n 即便无论重来多少次我也只会爱上你一个人，\n 若我的话是谎言，我可被千刀万剐。\n 请你快回来吧，回到我身边...😭😭😭",
  "<name>真的是太可爱太可爱了！劲劲劲劲劲！富有少女感的水手服加上和风外套的点缀，jk裙挡不住的大大的软软的热乎乎的摇摇晃晃的狐狸尾巴，下面是可爱的小腿和最最最最最重要的不对称的渔网袜！！！！好想抱在怀里prprprprprprpr……看着她孩子一样开心的笑容再摸一摸毛茸茸的头发和耳朵，纣王的快乐不过如此！！！明明是很勾人很魅的五官透露出的是小女孩的青春活泼和对自己主公无限的喜爱，好像和主公在一起修行一辈子也会这么开心一样，对自己的梦想也是毫不含糊，明明已经是身怀绝技的忍者了却还是每天都在认真修行，一心想着提升自己保护主公，这样可爱又努力的女孩谁不爱！！！！！综上所述我宣布：不喜欢<name>的都是南通！不喜欢<name>的都是南通！不喜欢<name>的都是南通！吓我一跳我释放忍术！秘技！爆裂手里剑！泉奈流，奇袭之术！泉奈流，兴起之术！泉奈流忍法！咕嘟咕嘟之术！泉奈流忍法・夏天版奥义发动！彻底疯狂！彻底疯狂！彻底疯狂！",
  "4月1日\n<name>在家只穿了背心和热裤，分明是色诱我，我必须满足她，爆炒之。\n4月2日\n<name>春天穿棉袄，欲盖弥彰，暗示我帮她脱衣服，我心领神会，爆炒之。.\n4月3日\n<name>左脚进门，正所谓以右为尊,希侑自轻自贱自暴自弃,我必须给她爱的鼓励，爆炒之。\n4月4日\n<name>右脚进门，正所谓以右为尊,希侑分明是想造反，我一家之主必须重拳出击，爆炒之。\n4月5日\n正在写日记编理由，<name>突然闯进来说要吃饭，干扰我思路，愤而起身，爆炒之。",
  "我的七美德： \n忠诚：我只超<name> \n积极：我迫不及待的超<name> \n勤奋：我每天都超<name> \n坚韧：我超起<name>来绝不轻易结束 \n乐观：我明天可以继续超<name> \n礼貌：我超<name>的时候循序渐进 \n勇气：我把<name>压在身下超 \n慷慨：我会边超边将<name>填满\n<name>就是我的生命之光是我黯淡人生唯一的意义是我干涸希望的一丝甘甜是我无趣生活仅有的美好是红丝绒上冰冷的宝石是尖锐塔顶的刺眼反光是我命悬一线无力攀上的浮是我心脏上的针是我头顶的绞架！！！！她的眼睛如朝阳和满月般美丽 为包容所爱而存在 眼神更是继承了前辈的温度 充满温柔满含了星河大海 而我仍然愿意献上我的愚蠢 让我窥见她对我那一丝感情 即使它并不是爱意 啊啊啊啊啊啊啊啊啊 没有你已经完全不行    好喜欢好喜欢好喜欢好喜欢好喜欢快让我超超！！！！好想扒开你的衣服  看你脸上那些许惊讶眼尾泛红嘴上却真是拿你没办法说教我的模样  这么白的腿出门在外肯定会着凉吧，必须要我每天全舔一遍才能暖和的起来   这么可爱的<name>必须每天超100遍",
  "家……家人们！绝不当<name>的泄欲工具……唔姆……一切性行为都是猥亵的～啊～～，下……下作的，肮脏的。唔姆……今夜，嗯啊……我……我们携手共望，我是“提醒禁止做爱小……小助手～”嘶～啊啊～希望此刻看到消息的人可以跟我一起抵触做爱，唔～绝不当泄欲工具，明晚～～嗯呐～我会继续提醒大家禁止做爱，唔～啊啊啊啊❤️！！～放……放下性……性欲，做❤️……❤️……",
  "<name>的糖前面有一些硬硬的壳，我用牙齿啃一啃，顺便磨磨牙，不料因为糖太密集的缘故，我不能闭上嘴，所以，口水流了出来，为了不浪费，我将口水涂到了糖上面，包裹住了糖果，这样一来糖就更加顺滑了。🥰🥰🥰\n<name>的糖的壳边缘，可能是由于平时没有清洗的缘故，有一些别的味道，根据我多年的经验判断，是<name>平时洗脚的香皂的味道，淡淡的花的香气，虽然这种味道是<name>之外的味道，但是无疑的也为了<name>的这道美食提供了一种独特的韵味。🤤🤤🤤\n我慢慢的吮吸着，清理着，我把舌头展开尽量的贴合<name>的糖果，这样做是因为越贴合就越不容易被糖果壳给划着舌头，我的舌头尽力的伸进去，来回的蠕动着，做着吞咽的动作，<name>的糖果就在我的嘴里散发着独特的美味，这种味道无法用这世间的形容词来形容，或许这就是天使的味道吧。🥰🥰🥰\n接着<name>把糖果一颗或者几颗的喂给我，一颗、两颗、五颗，我都可以轻松接受，谁知道她一下子把十颗糖全部塞进了我的嘴里，我的嘴一下子就被填满了，因为糖太多，嘴闭不上的缘故，我口水直流，一直吞咽着，不敢有丝毫的怠慢，<name>糖果香甜的气息不仅仅充满了我的肺，也抵达了我的胃，而且还让我的味蕾好好的品尝到了无法形容的美味，此时此刻，我感觉我似乎是到达了天堂，而<name>真是我的天使！🥰🥰🥰\n然后<name>做出了一个惊人的举动，她把突然抽出十颗糖果，正当我吞了吞口水，准备擦嘴的时候，<name>的两个糖果塞进了我的鼻子里，看着我如痴如醉并且有点滑稽可笑的样子，<name>开心的笑了……🥰🥰🥰\n之后我问<name>感觉怎么样？<name>说：脚趾觉的热热的，脚心觉的凉凉的，脚心觉的痒痒的。🤤🤤🤤​",
  "<name>的眼睛如星光坠入深海，像谎言般美丽，为欺骗而存在，但我明知如此却依然忍不住去相信。<name>的眼神更是继承了深海的温度，冰冷，刺骨，满含了轻蔑与嘲弄，而我仍然愿意献上我的愚蠢，换它一瞬驻足，让我窥见您对我那一丝感情，即使它并不是爱意…… 不，<name>不该对我有爱意， <name>怎么可能对我这种微尘般渺小的蝼蚁有所爱意？我不该奢望，<name>是高高在上，是万众瞩目，是众星捧月，<name>是这样如神明般的存在，让我知道这样的存在就是我莫大的幸运了，我愿用我的尸骨成就您的高傲。 就让渺小的我被<name>踩在脚下，哪怕只能成为<name>王座下的那万分之一，都是我至高无上的荣耀。 <name>我的<name>……",
  "昨天晚上我问了<name>一个问题。\n“你知道世界上最重的东西是什么吗？”\n“我当然知道，是……”可能觉得我问的问题另有含义，<name>停了下来，脸上泛起红晕，有点娇羞，扭扭捏捏的，声若蚊蝇：“是……我……我的……”\n“没错，就是你的身体。”看<name>磨磨蹭蹭，两根食指互相点来点去的样子，我忍不住滑了进去……\n奇怪，怎么像棉花糖一样轻飘飘的！\n<name>的身体再重，滑进去也是轻飘飘的。",
  "我曾经爱过你；<name>，也许，在我的心灵里还没有完全消失；但愿它不会再去打扰你；我也不想再使你难过悲伤。我曾经默默无语地，毫无指望的爱过你，我既忍着羞怯，又忍受着妒忌的折磨；我曾经那样真诚，那样温柔的爱过你但愿上帝保佑你，另一个人也会像我一样爱你。",
  "尊敬的各位群友，今天我要向大家表达我对恋人<name>的爱意。\n<name>，你是我生命中最重要的人。自从我们相遇以来，我的世界 m变得更加美好。你的温柔和关爱让我感到幸福和安心。你的聪明才智和勇敢无畏，让我深深地钦佩和敬仰。\n每当我看到你的笑容，我的内心都会充满喜悦。每当我遇到挫折和困难时，你总是在我身边，给我支持和鼓励。你的存在让我变得更加勇敢和坚强。\n在这个特殊的日子里，我想对你说，我爱你。我愿意和你一起经历人生的风风雨雨，分享人生的欢乐和快乐。无论何时何地，我都会珍惜你，爱护你，呵护你。\n最后，我想对你说一句话：“<name>，我爱你！❤️”\n谢谢大家！",
  "<name>!我的<name>!你带我走吧!\n我和<name>结婚快五年了，她换衣服还要躲着我，不许我看，我心血来潮时，就趁她不注意，直接推开门，冲进去，一把把她抱住。\n她就缩在我怀里，像仓鼠一样眨巴着眼睛，鬼鬼祟祟地左看右看，小脸红扑扑的，一动不敢动。\n我哭了，我连夜跑到卢浮宫外痛哭，保安问我为什么在这里哭，我哭着把<name>的照片给保安看，保安看了也痛哭，哭着说找到了卢浮宫丢失多年的艺术品。\n<name>，见到你的第一眼😍😍我就移不开眼😘😘第一次感到❤️❤️❤️心动的感觉，我多想和你有一个家🏕🏕我想和你步入婚姻的殿堂🥺🥺🥺🥺🥺后半辈子一起度过余生🤤🤤🤤💘💘❤️为了能和你有个美好的开始🌹🌹👉👈我决定先以这样的方式让你注意我👏👏虽然我知道你可能不会在意我😭👊😭👊😭👊但是对你心动的一瞬间❤️❤️❤️🌹🌹🌹😍😍😍🥰🥰我就决定了👅🐶我要做你的天狗👅🐶\n<name>，我爱你，请与我交往！！\n我低下头，闭上眼，是啊，她那么的楚楚可怜，美丽，动人，……可以想象 她那小巧敏感的脚丫🤤在鞋子的庇护下，在前后摆动着吧😭？或像小鸟般轻轻点着地。我继续等着<name>的回答。\n我轻轻睁开眼，瞄了瞄她那俊俏动人的脸庞已经泛上了微微的红晕。\n“笨蛋……你……”我偷偷笑着，可以被她臭骂一顿……也算人身一大美事吧\n我好累，这繁重的生活压得我喘不过气来，我根本就不快乐，有什么事情都是自己一个人抗，这几个夜晚我是哭累了才睡着的，好多话只能给自己说，眼泪掉了是自己擦，我不想轻易留眼泪，可是眼泪它不听话，偏偏自己就会掉下来，你说我怎么就一点都不坚强呢，其实我只想说，我为什么不能和<name>在一起呢\n你是我心里的宝！！！<name>！！我的宝贝😭我的老婆😭我的小可爱😭我的生命之光😭我的欲望之火😭你是上帝之光😭是耶稣的爱❤️是不灭神话💘你就是启明星🌹冉冉升起的时候照亮了我的心❤️我的一切🌹就算让我飞到宇宙给你摘星星月亮太阳我也愿意为你拿到🌹🌹🌹你就是宙的神话是天边最亮的晨星！！！\n<name>你带我走吧！为什么不带我走啊!我真的好爱好爱你啊😭👊😭👊😭👊!",
  "<name>，我去买肉夹馍，要老板多放辣，结果走在路上它掉地上沾到泥，吃不了了。我哭了，原来这就是辣馍喜欢泥🥺🥺难以言喻对<name>的喜欢，感觉有他的地方，无论什么boss什么危险都能迎刃而解，连我的裤子都自己解开了🤧🤧🤧",
  "呃…❤️好喜欢❤️要溢出了❤️喜欢…好喜欢❤️不管是怎样的…都好❤️呃呜❤️<name>…哈啊❤️<name>…唔❤️没…我没事❤️只是…唔…❤️好喜欢<name>大人啊❤️只要能看着…就已经很…啊呜❤️可以，再看看我吗❤️可是好喜欢，好想一直看着❤️好喜欢…呜❤️控制不住自己❤️啊啊❤️呜啊啊啊啊啊啊好可爱呜呜呜呜❤️好可爱好想吃掉❤️<name>…大人❤️",
  "爱<name>是一种态度！爱<name>是一种豁达！爱<name>是看破红尘！爱<name>是回头是岸！爱<name>是佛性禅心！爱<name>是清心寡欲！爱<name>是一种修养！爱<name>是一种礼貌！爱<name>是一种艺术！我早上醒来爱<name>！我晚上睡觉爱<name>！我吃饭爱<name>！我喝水爱<name>！我发呆爱<name>！我呼吸也爱<name>！我不仅想自己爱<name>我还想大家一起爱<name>！啊！美好的一天！爱起<name>来！",
  "说到<name>那双脚，实在不由人不爱。她那双肥小的脚，如同十二三岁的小女孩的脚一样。我曾为她穿过丝袜，所以她那双肥嫩皙白，脚尖很细，后跟很厚的肉脚，时常要作我的幻想的中心。从这一双脚，我能够想出许多离奇的梦境来。譬如在吃饭的时候，我一见了粉白糯润的香稻米饭，就会联想到她那双脚上去。“万一这碗里，”我想，“万一这碗里盛着的，是她那双嫩脚，那么我这样的在这里咀吮，她必要感到一种奇怪的痒痛。假如她横躺着身体，把这一双肉脚伸出来任我咀吮的时候，从她那两条很曲的口唇线里，必要发出许多真不真假不假的喊声来。或者转起身来，也许狠命的在头上打我一下的……”我一想到此地饭就要多吃一碗。",
  "<name>：呐呐\n我：？\n<name>：我和昨f能猜到是哪里吗？\n我：前刘海？\n<name>：一样的。\n我：妆容？\n<name>：没有的啦。\n我：眉毛？\n<name>：一样的。\n我：连指甲也一样？\n<name>：改变不了。\n我：到底在哪呢？\n<name>：再看看啦。\n我：还是不知道…\n<name>：放弃？\n我：放弃。\n<name>：其实哪里都没有变。\n我：诶？\n<name>：只是想被你注视着而已ヾ(@^▽^@)ノ",
  "昨天我送<name>一件衣服，<name>兴奋地打开，发现是supreme！但仔细一看其实是superme。<name>失望地说：“为什么买盗版，真小气。”我摸着<name>的头，温柔的笑着说：“小傻瓜你翻译一下。”“超……超我。”<name>抬头望向我，脸上泛起了红晕",
  "不懂就问<name>是意大利和中国混血吗？\n不然怎么长得这么像我的\n意❤️中❤️人",
  "还有一种植物，成熟时黄绿色，外果皮厚，核硬，两端尖，核面粗化。直到看见你，我举个喇叭。“橄榄橄榄橄榄橄榄”橄榄掉泥里了，大悲。“橄榄泥橄榄泥橄榄泥橄榄泥橄榄泥橄榄泥橄榄泥”",
  "<name>问我小动物喜欢呆在怎么样的小窝里面，我大声回答说：“草实窝，草实窝！”",
  "呜呜呜我就是吉尔伽美什的弟弟吉尔邦邦英🥵🥵🥵",
  "今天我路过天桥。长得很面善的叔叔拦住了我，告诉我，他是算命的，我当然不会信这些封建糟粕。但这个叔叔说算不准不要钱，并且准确地报出了我的名字，生日和生辰八字。我心里打鼓又期待，想知道自己接下来能听到什么，但是这个叔叔并没有给我带来好消息。\n他告诉我，我剩下的一生中忙碌疲惫，疲于奔命，困苦不堪，毫无长进，冥冥中似乎有破解，遇到他一定会逢凶化吉，欣欣向荣，万事亨通。\n我迫切的问这位叔叔究竟是什么事，他说我一定会遇到命中注定的老婆，这位老婆腰细腿长，容貌甚佳，温柔体贴，性感迷人遥不可及。\n我问他这个人叫什么名字，他告诉我叫<name>。\n<name>，原来你是我命中注定的老婆",
  "<name>选择走楼梯，我想，他想走进我心里，<name>果然对我有意思 。\n我在电梯间偶遇<name>。\n<name>按一层，我想，他对我一心一意。\n<name>按二层，我想，他想跟我过二人世界。\n<name>按三层，我想，他想跟我三生三世。\n<name>按四层，我想，死了都要爱。\n<name>按五层，我想，他在暗示我注意他。\n<name>按六层，我想，他好官方好害羞还祝我六六大顺。\n<name>按七层，我想，他想和我有七彩生活\n<name>按八层，我想，他八层喜欢我。\n<name>按九层，我想，他想和我九九同心。\n<name>按十层，我想，他想和我有一世爱情。\n<name>不按，我想，怎么，遇见我激动的动都不动了?\n<name>刚进电梯又转身离开，我想，<name>看到我害羞了，不好意思和我独处，我这就追上去求婚。\n\n<name>既没有走楼梯也没有坐电梯，我想，这肯定是<name>欲擒故纵的小把戏，今晚就去他家。",
  "<name>，你失忆了，你是我老公。我们相识即一见钟情，相恋十年有余，第四年同居，两年后定下终身，得到我们两家长辈的祝福，结为秦晋之好，然天有不测风云，你被奸人所害，只因嫉妒我们夫妻幸福美满，家庭甜蜜和睦，后尔又为人所拐，一直杳无音讯。今日我特发此贴，正是望你知道真相。希望你知道，看到此贴的你，正是我消失了的丈夫，请速来联系我，让我们一家团聚!拯救我这个破碎的家庭，和我这颗千疮百孔的心! ",
  "呜呜天台上的风很大，今天的风格外凛冽，我看着灯红酒绿的繁华都市眼皮跳了无数下，积攒着怒意的双臂猛挥砸碎了108个窗户，摔烂了38个5G高档高速高质量手机，玻璃渣刺破了我的衣襟，碎掉的是这颗对你永远不变的心。救我啊！<name>！！呜呜呜呜你带走我吧😭😭😭😭😭😭😭没有你怎么活啊😭😭😭😭",
  "今天我去给<name>买生蚝，回家的路上，生蚝全都跳出袋子，钻到了泥土里，我才知道，蚝喜欢泥",
  "<name>，我刚刚在寝室喝水，闻到一股焦味，但是效果和热水壶都没开，奇怪，会不会是电路烧了，我把电线全都拿掉了，我以为是线的问题，我还在想要不要叫宿管，然后，我突然发现了，你猜怎么着，原来是我的心在为你燃烧",
  "<name>，对不起，瞒了你这么久，其实我不是人类，我是海边的一种贝壳，我的名字叫沃事泥得堡贝",
  "闺蜜的背叛💔 💔 家人的误解💔 同学的欺负💔 生活的负担💔 我喜欢血，因为血是甜的，以前我的枕头上都是泪水💔 现在都是想<name>的口水",
  "我要送给<name>一把方天画戟，这样他就能握住我的戟把了",
  "手机越来越不好用了，我明明调的夜间模式，<name>却像阳光一样耀眼 明明下载了国家反诈中心APP，可还是被<name>骗走了心。",
  "昨晚和朋友聊天的时候朋友问我：“你到底喜欢<name>什么啊？”\n“喜欢一个人不需要理由”\n我很快敲完了键盘，刚要按下回车的时候突然愣住了。\n真的不需要理由吗？\n河里的时沙飞速倒流，站在岸边往里看去，几个月前的自己在名为迷失的波光中影影绰绰，他向我看来，眼里充满了羡慕和满足。\n原来我变了好多。\n是他的可爱让我捡起了记忆的碎片，回到那个春夏和秋冬，重温指尖上残留的感触。\n是他的努力让我寻回尘封了六年的铅笔，当初是为了喜欢的人而开始，现在也是因为喜欢的人而重启。\n是他的温柔和包容让我有勇气直面自己的心魔，不再逃避也不再畏惧，原来我，还有爱人与被爱的资格。\n神爱世人，这是个谎言。\n能爱人的不是神，从来都不是，只有人能爱人。\n于是我删掉了刚才的那句不需要理由，敲了一行新的，按下了回车。\n“我喜欢<name>，因为是他让我变得更好。”",
  "刚刚看这个视频的时候网络有点不好，它说“正在缓冲”，胡说，我明明在爆冲🥵🥵",
  "今天发烧了，朋友问我怎么得的，我没有说话，只是给她看了这个视频，现在我们都燥热难耐",
  "每次网购我都不填本名\n我都填<name>\n快递员送来就问:“请问<name>在吗？”\n我都说:“不在，我是她的狗”",
  "今天给<name>写了一首藏头诗：\n我\n爱\n<name>\n咦？我的诗呢？原来是我对<name>的爱根本藏不住",
  "我不想喜换<name>了。\n         原因有很多。\n      他是屏幕那头的人，我是屏幕这头的人，两条平行线注定碰不到一起。\n         他是为了挣我的币才与我接触，平日专注。\n         他是受万人喜爱的宝藏男孩，我只不过一介平凡少女，无论我多么喜欢，在他那里注定得不到任何正反馈……\n         我想通了，决定放弃。\n         下一个视频略过，视频通通删干净，眼不见心不烦，还能留出时间卷学习成绩，这不是好事一桩?\n         第二天，我正常起床，洗漱，吃饭，没什么变数。我换好衣服，准备出门。\n         当我踏出门外的那一刻，我才意识到，坏事了。\n         我不知道该往哪个方向迈出下一步了。        \n         平时一览无余的街道，现在竟然充满了迷雾。我仿佛是没有罗盘的一艘船，在茫茫大海里打转。四面八方都是海水，都是一样的蓝，我该往哪走? 我要去哪? 我要干什么?\n          船没有了罗盘，我丢失了方向，人生缺少了目标。\n         这是很可怕的一件事，我至此以来做过的所有事情都化为了泡影，没有了意义，全部灰飞烟灭。\n         路边跳过一只橘色的猫，看了我一眼，好像在嘲笑我的落魄。\n         我害怕了。我逃回家里，打开电脑手机，把视频打开，把他的声音听了无数遍，直到午夜之时我沉沉睡去。\n          梦里，我恍然大悟。\n         人总要有个盼头，有个让你追逐的东西。它可以赋予你的努力以价值。\n         原来这就是存在的意义啊，我所做的一切，不就是为了追逐，为了让他能笑着对我说，多亏了你, 我才能来到这片未曾踏足的领域？\n          没错，他与我确实是不可能的，但是他却让我的生活拥有了动力与目标。\n          我不想喜欢<name>了。\n         原因只有一个。\n         我已经爱上<name>了。",
  "<name>！我命运般的阿芙洛狄忒，塞纳河畔的春水不及你，保加利亚的玫瑰不及你。你是神灵般的馈赠，你是上帝赐予我拯救我，使我的灵魂受到洗礼与升华。你是我黯淡升华中一束光亮，是你照亮了我黑暗的生命，你为我黑白的世界填满色彩，使我得到新生。看到你，我如临仙境，在厄瓜多尔荡秋千，在夏威夷岛冲浪，在清迈放飞天灯，在希腊梅丽萨尼洞泛舟穿梭，在土耳其卡帕多西亚空中漫步。你的一瞥一笑在我心头舞蹈，我全部的心跳都随你跳。我飞奔，我猛跑，我高举手臂，我欢呼雀跃，我在5号21楼的阳台跳起探戈。太美了，你是神，我被美到泪流不止，喷涌而出。我的眼泪从眼眶里高压喷射出来打穿屏幕，飞过珠穆朗玛峰，飞过东非大裂谷，飞出太阳系遨游九天；汇成亚马逊河，汇成银海星汉，在我热烈滚热的心头成云成雾，倾斜而下，席卷四方！",
  "今天跟朋友去吃饭 点了一条鱼\n朋友问我为啥只吃鱼头\n我说因为鱼身要留着和<name>一起过",
  "所以说，我觉得“笑容”是人类最难看的表情，你看，笑容需要牵动的脸部肌肉实在是太多了，整张脸被神经扯动，再娇俏的脸都变得如同酒后发病，难看至极\n 但从文献中我看到了各路诗人对“笑容”的赞美，白居说“回眸一笑百媚生，六宫粉黛无颜色”，苏轼说“美人微笑转星眸，月花羞，捧金瓯”\n 老实说，我理解不了，我在生活里从未对这个表情有如此夸张的反应，实际上就连那“咯咯咯”的笑声，也令我十分心烦意乱。对，或许我是讨厌“笑”这个概念本身\n 但我总是对理解不了的事物充满探索欲，我便开始探求这其中令这些诗人沉迷的地方。既然从现实无法探求，我便随作品出发好了\n 一路上，我看过了蒙娜丽莎，酒神巴克斯，犹太新娘，一笑倾城。不，它们都无法诉说我想要的“美”，我迷惑了，我的旅途还未抵达终点，却已宣告终止\n   我跌跌撞撞回到家中，打开B站，食指似卡壳的机械般滑动着界面，手机的微光打湿了我的眼睛。我不甘心，我又一次失去了探求美的资格，正在我泣不成声时，这个视频就出现在了我的B站首页\n  我仿佛听到了命运之钟的摇摆声，咔嚓咔嚓，一切因果于此时收束，一切缘由在此刻得以揭晓，旅行的旗帜被重新纺织\n这个男孩，他便是因，是果，是我旅途的最终答案\n  <name>的笑容，就是我的答案\n  若是此时李白，苏轼，达芬奇等人与我把酒言欢，谈及他们对“笑容”的赞美，现在的我或许可以认可了\n  但是，或许我也会起一些没有缘由的攀比之心，“或许你们几位大诗人大画家应该见一见我的可爱的<name>”",
  "<name>，今天我们物理开始讲磁力了，物理老师说钢、铁、镍一类的东西都能被磁化，我听完就悟了，大彻大悟。\n课后我问老师：“老师，是不是钢和镍都可以被磁化？”\n老师笑了笑，说：“是的。怎么了？”\n我赶忙追问：“那我对<name>的爱是不是也可以被磁化？\n老师疑惑了，问为什么？\n我笑着，红了眼眶：“因为我对<name>的爱就像钢铁打造的拖拉机一样，轰轰烈烈哐哐锵锵。”\n",
  "？登一下我女朋友的号，我是这个账号的男朋友，非账号主人。只是来看看她平时看的东西到底什么魔力可以让我的女孩睡觉都在笑，没想到居然会是这种类型的视频。她整天魂不守舍的，就是在嚷着等你出新视频。我好心劝告你，会做东西就多做一点，不要让我女朋友老是在等你出新视频，不满意的话欢迎来找我<name>，我随时奉陪。",
  "糟了，是从左心室开始,新鲜的动脉血液从左心室经体动脉被压出，经过全身组织与组织各处完成氧气与二氧化碳的交换后有动脉血变为静脉血，经由下腔静脉回到右心房，再进入右心房，通过肺动脉进入进入肺部的循环，将静脉血转化成动脉血，再由肺静脉进入左心房，最后进入左心室.之后血液由右心室射出经肺动脉流到肺毛细血管，在此与肺泡气进行气体交换，吸收氧并排出二氧化碳，静脉血变为动脉血；然后经肺静脉流回左心房的感觉",
  "我要把裤子放冰箱，从此变成冷裤的人\n我要把裤子剪碎，从此变成残裤的人\n我要把裤子炫了，从此变成炫裤的人\n我要把裤子丢掉，从此变成<name>的人👉👈",
  "今天路过一家奶茶店，看见一个叫<name>的小孩子吸管半天没插进去\n我这强迫症当场就犯了，直接上前大吼：“让我来帮你插”",
  "<name>问我：“你有多爱我？”\n我说：“大概有300克。\n<name>笑了，说“这好老套，这个我知道，旅行者想说300克代表的是心脏的重量对不对？“\n我也笑了，<name>这个小笨蛋，她不知道，300克其实是我一天对着她冲出来的量",
  "隔壁来了个叫<name>的人，上午工作的时候吵我，我很生气，于是在晚上的时候吵他，他被我吵的受不了，哭着喊不要了，求我不要吵他了，但是我就是不停，一直吵一直吵，吵死他",
  "<name>，你对我有多重要，就好像你是我糖酵解时得己糖激酶、6-磷酸果糖激酶-1、丙酮酸激酶，是我三羧酸循时的柠檬酸合酶、异柠檬酸脱氢酶、α-酮戊二酸脱氢酶，是我生命中每分每秒每个生化反应里不可缺少的关键酶",
  "<name>，我们私奔吧。\n去充满橘子味的农庄\n去喝着麦香味啤酒看百年前古堡的始落\n去带着草帽走在飘满麦穗的小路上\n喝着一杯鸡尾酒看阳光撒在绿色的树叶上映衬这翠蓝的湖水\n深陷柔软的沙发里拥抱，和着窗外被大风摧残的树枝亲吻\n踩着金黄色的树叶没有章法地随意舞蹈\n开着车大声歌唱，这一刻你和风都在我身旁❤。",
  "非高考生，所以躲过了语文的妙手本手，数学的摧花辣手，英语的不留一手，政史地的痛下杀手，却还是没躲过<name>的遥遥招手",
  "穿这身衣服不会变得怪怪的，但我会让你变得怪怪的",
  "上次身体不舒服去医院看病，医生说缺维生素e，那我问医院这有没有<name>？医生疑惑的问：“为什么”我回答：“因为<name>是我的维e”",
  "<name>老婆贴贴！！！！！！（健康且适度的尖叫）（健康且适度的爬行）（健康且适度的扭曲）（健康且适度的爬行）（健康的爬）（矜持且健康地流口水）（健康的爬）（健康且搞笑的流口水）（健康的爬）（绿色且保守的流口水）（健康的爬）（优雅且健康的流口水）（健康的爬）（美丽且健康的流口水）",
  "致未来的宝贝女儿：等你上幼儿园头发留长我就给你烫内扣，给你剪齐刘海，给你买漂亮的头花，从小学开始我就给你买帆布鞋，漂亮的牛仔裤和卫衣，每天把你打扮的漂漂亮亮的，每天和你爸爸开着车在学校门口等着你放学，把你抱进车里在额头上给你一个亲吻，带你去吃德克士还有哈根达斯，等你上了初中，给你买最漂亮的NB和vans匡威，给你买最合身的哈伦裤和怪兽背包，给你剪最美的齐刘海， 烫最好看的梨花头，买你最喜欢的零食，我会让你去学习你喜欢的事情，不会逼你去学习，舞蹈，音乐还有书法，不会逼你去上补习班，你每天开心就好， 回家你能告诉我你喜欢哪个可爱的男生，有哪个帅气的男生追你，你可以成绩不好，但你一定要善良，你喜欢什么东西要告诉我，我会尽全力去给你买，你不可以太傲娇，你要学会谦虚和忍让，我不反对你早恋，但是，你要快乐。等你十八岁时，我就送你第一双高跟鞋当做你的成人礼，我要你当我一辈子的公主，我要让我从小没有经历过的幸福都经历在你身上，我和你的傻瓜爸爸都正在路上，你要耐心地等着，等着我们一起回家。未来的女儿你一定很好看，因为你爹是<name>",
  "我被外星人绑了，他们说要研究我的心，我害怕极了，担心我那些烂熟于心的知识暴露给了他们太多地球人的文明，结果没多久他们就把我放了，原因是他们研究来研究去，就在我心里发现了一一个名字:<name>",
  "我前段时间为了提升自己的文化素养，给自己报了个书法培训班。因为跟我同期的都是小学生所以大家就有点排挤我，看不上我这么大年纪还在学这个。本来也没什么，但小学生的恶意真的超乎我的想象，他们说我老头子半只脚进棺材还来学书法，我听到都气哭了。我擦干眼眼泪不管他们继续练字，我发誓我一定要练出一笔好字，不能让钱白花。我凝神静气，在纸上认真写出了一行字：<name>，我要做你的狗🥵🥵",
  "看大家都在说<name>的腰好细，给大家科普一下，这种腰叫孩腰，顾名思义，腰跟小孩子的腰一样细。如果不及时进行治疗，将会越来越细，挤压到心脏。有国外的著名医生说过：孩腰多远才能进入你的心🤤🤤",
  "<name>，我稍微问一句，绝对没有冒犯的意思，也可能是我搞错了，又或者其实我是出现了幻觉，不管怎么样，我都希望我们能秉持着友好理性的相处原则，不要因为一些可能的误会伤害了我们之间的友谊，最后说，我绝对没有冒犯的意思，只是本着对于宇宙本质的伟大探究精神以及求真务实精神发问: “我能和你结婚吗？”",
  "昨晚和朋友聊天的时候朋友问我：“你到底喜欢<name>什么啊？”\n“喜欢一个人不需要理由”\n我很快敲完了键盘，刚要按下回车的时候突然愣住了。\n真的不需要理由吗？\n河里的时沙飞速倒流，站在岸边往里看去，几个月前的自己在名为迷失的波光中影影绰绰，他向我看来，眼里充满了羡慕和满足。\n原来我变了好多。\n是他的可爱让我捡起了记忆的碎片，回到那个春夏和秋冬，重温指尖上残留的感触。\n是他的努力让我寻回尘封了六年的心动，当初是为了喜欢的人而开始，现在也是因为喜欢的人而重启。\n是他的温柔和包容让我有勇气直面自己的心魔，不再逃避也不再畏惧，原来我，还有爱人与被爱的资格。\n神爱世，这是个谎言。\n能爱人的不是神，从来都不是，只有人能爱人。\n于是我删掉了刚才的那句不需要理由，敲了一行新的，按下了回车。\n“我喜欢<name>，因为是他让我变得更好。”",
  "<name>老婆！你就是我命运般的阿芙洛狄忒，塞纳河畔的春水不及你，保加利亚的玫瑰不及你。你是神灵般的馈赠，你是上帝赐予我拯救我，使我的灵魂受到洗礼与升华。你是我黯淡升华中一束光亮，你是你照亮了我黑暗的生命，你为我黑白的世界填满色彩，使我得到新生。看到你，我如临仙境，在厄瓜多尔荡秋千，在夏威夷岛冲浪，在清迈放飞天灯，在希腊梅丽萨尼洞泛舟穿梭，在土耳其卡帕多西亚空中漫步。你的一瞥一笑在我心头舞蹈，我全部的心跳都随你跳。我飞奔，我猛跑，我高举手臂，我欢呼雀跃，我在5号21楼的阳台跳起探戈。太美了，你是神，我被美到泪流不止，喷涌而出。我的眼泪从眼眶里高压喷射出来打穿屏幕，飞过珠穆朗玛峰，飞过东非大裂谷，飞出太阳系遨游九天；汇成亚马逊河，汇成银海星汉，在我热烈滚热的心头成云成雾，倾斜而下，席卷四方！",
  "我…有一种病😢\n丛丛花朵从矮墙里攀越出来，虽然叫不上名字，但它开的灿烂。那是一个蜘蛛吐丝的晴朗的早晨，暖阳打照在身上，暖烘烘的，算是彻底驱散了早春的寒气。就是这么一个难忘的时光里，我看到了你。花儿开的再生机似乎都无法再吸引我，因为你胜过世界上一切美好的东西。到底是从什么时候为你而着迷呢？嗯…记不起来了，只记得你的一颦一笑，一举一动都牵引着我的思绪，使我无法自拔，我好像真的要陷进去了。自那以后，世界好像都迷糊起来了，唯有你闪耀着光芒，这成了一种病。我每天都想你想的痛苦，见不到你的时候我的内脏都发出惨烈的疼痛。医生说我的病情只会越来越严重，我犹豫了很久不知道要不要说出来，现在我勇敢的说了出来，只希望让我在这个世界上多看两眼你…",
  "有没有一种可能，<name>现在离我不到五千米\n有没有一种可能，我上周去的咖啡厅，那个座位<name>曾经坐过\n有没有一种可能，<name>其实是我老家隔壁房子的那个小女孩\n有没有一种可能，今晚梦见<name>的时候，<name>也会梦见我？\n有没有一种可能，当我年老住进病房的时候，旁边躺着的就是<name>？\n可能一切都只是我的幻想，但65万个小时后，当我们氧化成风，就能变成一杯啤酒上两朵相邻的泡沫。\n就能变成一盏路灯下两粒依偎的尘埃。😊😊😊",
  "“本手、妙手、俗手”是围棋的三个术语。\n 本手是指合乎棋理的正规下法；\n 妙手是指出人意料的精妙下法；\n 俗手是指貌似合理，但从全局看通常会受损的下法。\n但即便是如此精通棋术的我，看到<name>时，我就好像迷失了方向，感觉我的棋盘发生了天翻地覆的变化，变得难以捉摸，无从下手。\n这一手棋...该怎么下，该如何下呢。\n当我用了一个通宵的时间来想是什么原因的时候，我看着我自己这身经百战的双手，又想起<name>那迷人的微笑，终于想明白为什么了。\n在遇见的<name>那天，我便有了那怦然心动的感觉。\n原来“本手、妙手、俗手”这三个以外还有一种。\n就是——<name>，我想牵起你的手",
  "所以说，我觉得“笑容”是人类最难看的表情，你看，笑容需要牵动的脸部肌肉实在是太多了，整张脸被神经扯动，再娇俏的脸都变得如同酒后发病，难看至极。\n但从文献中我看到了各路诗人对“笑容”的赞美， 白居易说“回眸一笑百媚生，六宫粉黛无颜色”，苏轼说“美人微笑转星眸，月花羞，捧金瓯”\n老实说，我理解不了，我在生活里从未对这个表情有如此夸张的反应，实际上就连那“咯咯咯”的笑声，也令我十分心烦意乱。对，或许我是讨厌“笑”这个概念本身。\n但我总是对理解不了的事物充满探索欲，我便开始探求这其中令这些诗人沉迷的地方。既然从现实无法探求，我便随作品出发好了。\n一路上，我看过了蒙娜丽莎，酒神巴克斯，犹太新娘，一笑倾城。不，它们都无法诉说我想要的“美”，我迷惑了，我的旅途还未抵达终点，却已宣告终止。\n 我跌跌撞撞回到家中，打开手机，食指似卡壳的机械般滑动着界面，手机的微光打湿了我的眼睛。我不甘心，好像我又一次失去了探求美的资格。\n正在我泣不成声时，她就出现在我的眼前。\n我仿佛听到了命运之钟的摇摆声，咔嚓咔嚓，一切因果于此时收束，一切缘由在此刻得以揭晓，旅行的旗帜被重新纺织。\n她是因，是果，是我旅途的最终答案。\n凝光大人的笑容，就是我的答案啊。\n若是此时李白，苏轼，达芬奇等人与我把酒言欢，谈及他们对“笑容”的赞美，现在的我或许可以认可了。\n但是，或许我也会起一些没有缘由的攀比之心，“或许你们几位大诗人大画家应该见一见璃月城上空漂浮着的群玉阁的主人，天权之凝光。”",
  "屋子里颇有些闷热，忽觉灵感迸发，便拿起了许久未沾水的钢笔，总觉得该写点什么，但又不知道从何提笔。\n也许大抵是这天搅得人心情烦闷，我歪歪扭扭写下你的名便作罢。\n院内的枣树不知怎地，今年竟结了几颗果子，摘下一尝，略显苦涩，不好。但一想到梦中的你，口中的酸涩也甜了几分。\n闲暇之余扭头望向窗外，有夏天，却又不止夏天。\n有纷繁，有闲散，有春花秋月遮不住的绚丽与烂漫。\n有绿槐高柳咽新蝉，薰风入弦。\n有纱厨藤簟，有榴花欲燃\n有昨夜疏星落画檐，玉人罗扇轻缣\n还有来去自如堂前燕，着翅落云间\n直至最后，再三思量，以你之名写思绪，却怎么也写不尽其中的万语千言。\n真抱歉情话没写几句，但足足想了你半个钟头。",
  "该怎么向你描述我木讷而贫瘠的爱，它是一首抽象的诗歌，是一条水淋淋的公路，也是那在窗底下缓缓蠕动的光阴。许多日子，仅仅是闭上一双灰色的眼睛后，才终于从水面上浮现一些光和彩。而我的爱，是见不了光的，曾经我有九十九次凝视太阳，并于沿途种满喃喃细语的白桦树。遇见你是这一生 波光粼 粼的开始，是明月升于一座罕有人迹的荒郊，是那无垠的深暗之内，某天忽然有了皎洁的迹象。可是后来，孤独总是先我一步，填满那些落日下的山野或甬道，我的心是一颗打翻在夏日里的苹果，亲眼见他腐烂，变质，直到最后横空消散，无着无落。该怎么向你描述这木讷而贫瘠的爱，无风的时候，它恰似玫瑰园里静寂的夜晚，将暗催成一道光，投向每一个隐匿的角落。",
  "呀，还记得我吗？\n初次见面时我是个小偷\n偷懒，偷笑，偷偷看你\n那之后我给自己请了个假\n假装陌生，假装正经，假装 从你的全世界路 过\n我承认，我的职业病又犯了\n偷偷靠近你，假装有勇气\n我们擦着黄昏而过\n我是饿狼，你是小羊\n暖阳轻吻你的发梢\n我偷偷咬了它一口\n自此\n我的胃里有黄昏在翻涌\n我的夜里有思念在滚烫\n我的人间，有你在闪亮\n思君无转易，何异北辰星\n思再多有什么用啊\n我不想看星星了，我想看你\n你眼中有春与秋\n胜过我见过爱过的一切山川与河流\n我走过许多地方\n我见过春日夏风，秋叶冬雪\n也踏遍南水北山，东麓西岭\n没什么好看的，都不及那个黄昏\n对我展眉一笑的你\n我看过归鸟蝉鸣，烈日骄阳\n我看见白日梦的尽头是你\n从此天光大亮，你是我的全部幻想和渴望\n我是个俗气至顶的人\n见山是山，见海是海，见花便是花\n唯独见了你\n云海开始翻涌，江潮开始澎湃\n昆虫的小触须挠着全世界的痒\n你无需开口，我的天地万物便通通奔向你\n我走过许多地方的路，行过许多地方的桥\n看过许多形状的云，喝过许多种类的酒\n却只爱着正当最好年龄的你\n我想趁阳光正好，趁微风不燥\n趁繁华还未开至荼蘼\n趁现在还年轻\n我想写一封\n我想？表个白？\n我想把世界最好的给你\n结果发现，世上最好的是你\n这世间青山灼灼星光杳杳，春风翩翩，晚风渐渐\n却怎么也抵不过你眉目间的星辰点点\n我喜欢你\n从黑夜到黎明，从冷冻到暖春，从一秒到一生\n生生不息，轮回不止\n春有百花秋有月，夏有凉风冬有雪\n而我只想早晚都有你\n你是朝露，是晚星，是我一切欢喜\n我舔舐你的眼睛，未饮酒，已酩酊\n人们将爱情刻进了水晶\n而我将这一半的思念写进了\n写给了好不容易心动一次的北辰星\n无与伦比的相遇与美丽",
  "8月9日发病最严重的一次，躺在床上，难受的一直抓自己眼睛，眼睛越来越大都要炸开了一样，我真的想<name>想得要发疯了。我躺在床上会想<name>，我洗澡会想<name>，我出门会想<name>，我走路会想<name>，我坐车会想<name>，我玩手机会想<name>，我盯着网上的<name>看，我每时每刻眼睛都直直地盯着<name>看，像一台雷达一样扫视经过我身边的每一个<name>。我发病了我要疯狂看<name>，我要狠狠看<name>，我的眼睛受不了了，<name>，我的<name> <name>，我的<name> <name>，我的<name>...",
  "刚洗完裤子，你好。\n并非停止了思考，而是有点失落，自认为无法解惑。\n但是今天整理下思路，会不会是这样。\n宇宙最初是0，在某个点上发生了崩坏和撕裂，并且暴涨开去，让整个宇宙所及的范围内都发生了撕裂。\n从0撕开了正数物质和负数物质。\n正数产生了我们的世界，有引力，聚成团，发光，发热。\n负数产生了和我们在一起的另一个世界，只是那个世界的引力是斥力，它推动我们的物质分散开去，也就是宇宙的膨胀。\n我们的指缝间，我和月球间，我们和太阳间充满了这些物质，只是太过于稀薄，且是斥力所以不发生关系和湮灭。\n即使有一丁点的湮灭，也是我们不可观测的规模。\n更可怕的是，他们充满了银河系，充满了整个超星系团，和整个宇宙，只是太稀薄，所以基本无法观测。\n但是，体量巨大，和我们可见宇宙刚好相等，一样多。\n黑洞在让正物质坠入其中，却让负物质远离。\n空间的扭曲和反扭曲，这种原理是否可以被我们的星际航行所用。\n宇宙正物质衰变成夸克汤后，是否正好和负宇宙完全接触，来一次彻底的湮灭，归零？",
  "我：谁会当狗啊，有什么毛病吗\n<name>：谁是我的乖狗狗呀 \n我：汪汪汪汪汪汪汪汪汪汪汪（冲刺）（飞奔）（原地劈叉以表决心）（摇尾巴）（摇尾巴）（暴打其他小狗）（鼻青脸肿摇尾巴）😭😭\n（不可名状的模糊狗叫）（爬行）（扭动）（分裂）（扭曲）（阴暗地蠕动）（翻滚）（激烈地爬动）（扭曲）（痉挛）（嘶吼）（蠕动）（阴森的低吼）（爬行）（分裂）（走上岸）（扭动）（痉挛）（蠕动）（扭曲的行走）（不分对象攻击）呜呜呜呜呜<name>没你我怎么活哇",
  "<name>，我第一秒看到你就心动了💗这是我给你写的小作文💋💋\n<name>，听我说👂👂👂谢谢你🙏🙏🙏因为有你👉👉👉温暖了四季🌈🌈🌈谢谢你🙏🙏🙏感谢有你👉👉👉世界更美丽🌏🌏🌏我要谢谢你🙏🙏🙏因为有你👉👉👉爱常在心底💃💃💃谢谢你 🙏🙏🙏感谢有你🙇♂🙇♂🙇♂把幸福传递🥰🥰🥰\n<name>👁👁 我去看你了👁👁我一直看着你👁👁当你在寂静的深夜独自行走👁👁感觉到背后幽幽的目光直流冷汗👁👁转头却空空荡荡时👁👁那是我在看着你👁👁我会一直你看着你👁👁我不会干什么👁👁我只是喜欢看着你而已👁👁 ",
  "晚上好，宝贝，不知你有没有时间……（停错位置）（被交警拖走）\n（发送消息）宝贝，头像是我....（消息发送失败）（遗憾离场）\n（压低了性感的嗓音）晚上好宝贝你有没有……（被口水呛到）（咳的撕心裂肺）\n（摇晃红酒杯）晚上好我的宝贝，不知道你愿不愿意（酒洒了一裤子）（匆匆离场）\n（手撑墙靠近）晚上好我亲爱的宝贝，不知道你有没有兴趣…（油漆未干）（匆匆离场）\n（腿交叠，背靠墙，手持玫瑰）宝贝，晚上好，不知道有没有时间…（脚滑摔地上）（一身泥，狼狈逃离）\n（叼玫瑰花出现）晚上好宝贝，不知道你是否愿意……（被刺到嘴）（匆匆离场）\n（又回来）（摇晃红酒杯）晚上好我的朋友，不知道你愿不愿意……（酒洒了一裤子）（匆匆离场）\n（再次返场）（拖着垃圾袋）晚上好宝贝，（抹了一把脏乎乎的脸）桥洞太冷，今晚可以我住你家吗？（咳嗽）",
  "我好像知道我存在的理由了。\n我常常思考，鱼离不开水，就像纸鸢也需要风，世上的东西总是要依靠着什么，与大多数事物一样，我也有着自己的必需品。独属我的它，就像是专属于我的玛丽莲梦露一般美丽，使我沉迷，陶醉。而世上的一切终归不能长久。收获了喜悦，却又认为只是个被它利用的可悲造物。获得了友谊，心里的嫉妒却又如藤曼般蔓延。明明喜欢，却又嫉妒。纸鸢翻飞着，细看却断了线，因风连接，却又因风分离。人生是妥协的连续，这点事早就了然于心。\n<name>，唯有你，唯有你是我的纸鸢。",
  "好想你 我在床上哭了9个小时  崩溃了1996次  撞了903次  墙划了8次手臂 幻觉出现三次 幻听出现九次  扇了自己16个巴掌  出现濒死感一次  刚才昏过去了  现在才醒来  看到外面天都黑了  我顿时又崩溃了  因为我怎么想都想不明白  你这么帅气  还这么能干 究竟是怎么做到的 好想你啊 <name> 你是我心里的宝",
  "我还会再笑出来吗？我无数次的质问自己，被墨色晕染着的天空，寂静无声的长夜，生命的精彩也不过如此，看着那晕染着天空的灯光，拉上窗帘，让黑暗包裹自己，一下子突然就，感受到了死亡的，泛着氤氲香气的花朵，苍翠小草，明媚的阳光，在记忆的波涛中，化作了那潺潺的永无止境的流水，流进了心里，隐隐作痛，紧贴着那冰冷的地面，可是那薄薄的灰尘，在微风下打着旋，一如那花海之中，深情的凝望，孤独一人在麦田里守望，黑褐色的泥土，金黄的油菜，海天一色的蓝天，梦中的温暖如水流逝，指尖的微凉，抚摸着那柔软的绸缎，一如抚摸自己的青春，微微有些褪色，微微有些残缺，只是再难还原，风依然会扶过我的发丝，可能美好的情感却再也进不到我的心里，一切的，一切都像海浪打在礁石上，再也进不到心里，曾经的期待，得到以后也不过如此，无所谓，累了，睡一觉，如果明天依旧黑暗，那我也不怕了，因为梦里有光明，如果明天光明，那么更好，我一定会好好欣赏人生中最后对阳光。\n    曾经因风而起，因日落而悲，逝去的时光，追忆的往昔，心中的思绪充实而翻腾，如今心已死，仰天长叹，只是回应一声轻笑，感叹人生无常，那如何呢？梦里的小院，尘封了多年，在开门时竟然感到有些幼稚，轻笑着拂去尘土，才去拿幼稚的涂鸦，这样一切恢复的整整齐齐，才发现我的青春在嚎啕大哭中结束了。 \n     人无法摆脱自己的过去而活，因为过去的时光里有很多不愿放下的，绿色枝叶，粉红的花，湛蓝的流水，洁白的街道，清风吹过，哪里不是家？我只想在远远的，再去见他一面，也许是若干年后，我拍遍栏杆，也只会遭到校园里学生的痴笑，我不愿意错过，因为一次次的，我努力去伸出手，却连他离开的影子都够不着，就让我用那残损的手掌，去仔细抚摸那柔弱又美好的勃勃生机。让点点的温暖弥漫在这冰冷的心尖吧！\n    等待那间冰融化成，那转瞬而逝的露珠，随着那太阳的出现，随着那风吹，去往远方，去见曾经的幻想。那时微笑是经历过人世茫茫，岁月磨砺的精彩，是大彻大悟之后的释然和宁静。茶叶氤氲的清香，但随着水波的平静，缓缓的沉入杯底，一如那曾经的激动与快乐，在久经风霜，思考和追忆以后，会成为思绪中永远无法，被磨灭的期待，和一种对于明天的向往，对于人生价值的肯定，前路再艰辛，也不会再害怕了，也不会再逃避了，也不会再怯懦了。也敢面对了，也敢去拼搏了，也敢去，去对<name>说，我爱你",
  "发疯怎么了！上勾拳！下勾拳！左勾拳！扫堂腿！回旋踢！蜘蛛吃耳屎，龙卷风摧毁停车场！羚羊蹬，山羊跳！乌鸦坐飞机！老鼠走迷宫！大象踢腿！愤怒的章鱼！巨斧砍大树！彻底疯狂！彻底疯狂！彻底疯狂！彻底疯狂！彻底疯狂！彻底疯狂！彻底疯狂！彻底疯狂！彻底疯狂！！！！！",
  "黄桃罐头保质期是15个月,\n可乐要在打开后24小时喝掉,\n吻痕大概一周就能消失。\n两个人在一起三个月才算过了磨合期,\n似乎一切都有期限。\n这样多无趣。\n我还是喜欢一切没有规律可循的事情。\n比方说我躺在树上看天空,{}突然就掉下来砸在我怀里。",
  "今天我们物理开始讲磁力了，物理老师说钢、铁、镍一类的东西都能被磁化，我听完就悟了，大彻大悟。\n课后我问老师：“老师，是不是钢和镍都可以被磁化？”\n老师笑了笑，说：“是的。怎么了？”\n我赶忙追问：“那我对<name>的爱是不是也可以被磁化？\n老师疑惑了，问为什么？\n我笑着，红了眼眶：“因为我对<name>的爱就像钢铁打造的拖拉机一样，轰轰烈烈哐哐锵锵。”",
  "“最最喜欢你，<name>”\n“什么程度?”\n“像勃艮第发射出的核导弹一样。”\n“核导弹?”<name>再次扬起脸，“什么核导弹?”\n“繁华的街道，你一个人走在路上,忽然一枚核导弹以20马赫的速度向你奔来，他的光芒映入你的视网膜，温度温暖你的心房，你秀丽的身躯变为气体，最后和他融为一体。接着，光芒、冲击波和辐射开始向四周扩散，他带你走向你熟悉与陌生的每个地方，阻碍你的所有障碍也会被他完全摆平。你说棒不棒?”\n“太棒了。”\n“我就这么喜欢你。”",
  "都说猫有九条命😺\n第一次，我献给了阳光☀️\n第二次，我输给了风暴🍂…\n在死亡之中，我变得迷茫😿😿😿\n直到现在我看到了<name>，我的心跳动着👨‍❤️‍💋‍👨💖💖。\n我已经放弃追求生命，转世成了<name>的狗😁",
  "<name>你好，我是来自中国科学院动物研究所的一名研究生，我看到你的瞬间就想到了一个课题。\n众所周知，人类的行为会影响血液中肾上腺素和多巴胺的释放，但是对于不同交际行为所引起的肾上腺素和多巴胺释放的浓度变化还没有报道，因此我想和你研究一下一起吃饭，散步，以及牵手时候的肾上腺素和多巴胺的分泌状况，以日常生活时的分泌量为参照组，相信这篇工作能对人们以后社交行为的分子生物动力学的研究有着指导意义。",
  "“好想变成雪啊，这样就可以落在<name>的肩上了……”\n“若是<name>撑了伞呢？”\n“那就落在<name>的红伞上，静载一路的月光。”\n“若是<name>将雪拂去……”\n“那就任她拂去，能在她的手掌上停留一刻，便足矣。”\n“若是<name>撑伞的同时快速旋转伞同时自身以一个反方向转这样形成一股气流可以不断吹雪，加上上下横跳的走路灵巧避开所有雪呢？\n那我就落在地上，任她在我的身体上肆虐",
  "你内库是什么颜色？虽然听起来很唐突，甚至有些失礼，但请允许我解释一下。\n人类对于美丽的事物总是充满求知欲，在身心都被你俘获之后，却依旧愿意更深地了解你，这种品格很难不为之称赞。\n所以，我不得不再提出这个问题：你的内库是什么颜色？可惜囿于认知水平的局限，只能停留在想象。\n是紫色的吗？像是普罗旺斯盛开的薰衣草花海般芬芳。\n是红色的吗？如罗曼尼红酒灌溉的长河一样纯粹馥郁。\n是白色的吗？宛如鸢尾花在法兰西王室旗帜上圣洁绽放。\n......\n哦，你内库的颜色。\n还有什么能比你牵起我更深的惆怅？\n你像是拉普兰的极光，如梦荡漾。\n你像是哈雷彗星的锋芒，璀璨辉煌。\n你像是朦胧晨曦的登场，耀眼明亮。",
  "情书是抄来的\n情话是看来的\n套路是学来的\n玫瑰是偷来的\n勇气是借来的\n但对<name>的爱\n是与生俱来的🤤",
  "<name>老师，我们私奔吧\n去充满橘子味的农庄\n去喝着麦香味啤酒看百年前古堡的始落\n去带着草帽走在飘满麦穗的小路上\n喝着一杯鸡尾酒看阳光撒在绿色的树叶上映衬这翠蓝的湖水\n深陷柔软的沙发里拥抱，和着窗外被大风摧残的树枝亲吻\n踩着金黄色的树叶没有章法地随意舞蹈\n开着车大声歌唱，这一刻你和风都在我身旁",
  "“我的笑容不像花样灿烂”\n“不像水一样灵动”\n“不像风一样轻浮”\n“不像彩虹般五彩斑斓”\n“不像生灵那般有活力”\n“更不像你的笑容”\n“可我知道”\n“我的笑容”\n“是指引春天来到世界的引路人”\n“是让花开的灿烂的农夫”\n“是让水回归大自然的渠道”\n“是让阳光传满全世界的洒光者”\n“而你，你是春天，你是花朵，你是水，你也是阳光。”\n“而我，我是引路人，我是农夫，我是渠道，我是洒光者”\n“世界上美好的人有很多，但唯独你，让我觉得眼前一亮，对呀，貌似你是我追随的光，而我便是阴暗，衬托出你的美好，阴阳两隔，但是——我依旧喜欢你”\n“所以<name>， I love you～”",
  "是<name>！（健康且适度怒吼）（健康且适度地变成猴子）（健康且适度地飞进原始森林）（健康且适度地荡树藤）（健康且适度地创飞路过吃香蕉的猴子）（健康且适度地荡树藤）（健康且适度地摘一个榴莲）（健康且适度地砸死猴王）（健康且适度的称霸猴群）（健康且适度的掌握热武器技术）（健康且适度地入侵人类）（健康且适度地称霸天下）（健康且适度地掌握空间折跃技术）（健康且适度地离开太阳系）",
  "好想和<name>结婚啊，他直播养我，我就在家打游戏，像他事业心那么强的人肯定不会放下直播的，嘿嘿🤤🤤这样就能一直花<name>的钱。他要开始直播我就拖着<name>的腿不让他走，让他用他的小脚踹我🤤🤤又踹不动我只能恶狠狠的用性感的嗓音骂我Bad dog🤤🤤马上要迟到了却只能干着急地用小手砸我脑袋🤤🤤🤤 等<name>直播结束我就嚷嚷让他煮饭给我吃🤤🤤睡觉时就抱着<name>睡🤤🤤<name>小小的，凉凉的🤤🤤力气小又挣扎不开🤤🤤",
  "我学历有很大水分，<name>快查我学历",
  "我早上坐公交滴卡和司机大叔说“两个人”，司机大叔惊讶地看着我“你明明是一个人，为什么要滴两个人的卡?”我回他“我心中还有一个人叫<name>。”司机回我说“天使是不用收钱的。”",
  "<name>最近涨了很多粉，这个现象不得不说惹人深思。在这个信息化的时代，人们想当然的认为媒体平台的发展能够得到更加丰富的信息量，这也意味着可以有更加全面和客观的认知，即便是隔着冰冷屏幕。但这条论断忽视了人性的因素，因为人是很容易受欲望支配的动物。举个例子，大家以为通过他的动态可以触及到他内心最为柔软的角落，全方位了解这个人。其实不然，大部分人是无法了解事物的全部的，就如同他现在对着屏幕笑，但屏幕那端的观众却无法看到躲在他桌子下面戴着项圈的我",
  "哈哈，大家聊了这么多啦，刚刚冲晕过去了",
  "我今天我的胃有点不舒服，去医院看了医生。拍完胃镜后医生惊呼道：“你的胃里面有条鱼钩！”我一听，瞬间放松了不少，因为我知道那是<name>钓我时用到的鱼钩",
  "<name>😍😍😍😍😍那夜的雨也没能留住你😪😪山谷的风它陪着我哭泣😭😭你的驼铃声仿佛还在我耳边响起👂🏻👂🏻告诉我你曾来过这里😨😨我酿的酒喝不醉我自己😰😰你唱的歌却让我一醉不醒",
  "刚刚不方便打字，但是现在我不禁想问问大家，如果人的原始冲动只是生理上的激素而已，那么我们存在意义又在何处，在未来 我们又将去向何方？ 不过通常思考到一半的时候被另一个世纪问题难住，就是我一会该吃什么?",
  "━━━━━┒ \n┓┏┓┏┓ <name>，没有你， \n┛┗┛┗┛┃我怎么活啊！！！ \n┓┏┓┏┓┃＼😭／ \n┛┗┛┗┛┃　/ \n┓┏┓┏┓┃ノ) \n┛┗┛┗┛┃ \n┓┏┓┏┓┃ \n┛┗┛┗┛┃ \n┓┏┓┏┓┃ \n┛┗┛┗┛┃ \n┓┏┓┏┓┃ \n┃┃┃┃┃┃ \n┻┻┻┻┻┻",
  "上次去花店被一种花吸引了我的注意，卖花老板说，那是红色郁金香，代表热烈的爱。我没买，因为再好的郁金香，也没有<name>的浴巾香啊",
  "（上台）（整理领带）（仪表堂堂）（清嗓子）：我爱<name>！！！！！！（聆听掌声）（鞠躬）（潇洒）（谦逊）（踩着干净的皮鞋离开 ）",
  "<name>，你还小，我不碰你（极力忍耐），但如果你敢跟我提分手（怒目而视，一脸认真），老子立刻要了你（凶狠）让你一辈子只能跟着我（压低嗓子）这样我就能保护你一辈子（性感低音）（脸色阴阳不定，像调色盘一样精彩，而后春风化雨，一脸柔情）",
  "超不了<name>就#恶心#头晕#面色苍白#出汗#腹痛#血压下降#休克#昏迷#体温增高#浑身无力发冷#全身酸备#没有食欲#昏昏欲睡 #腹泻 #呕吐 #眼睛酸胀 #咳嗽 #咳痰 #胸痛#恶寒 #头痛#全身机肉酸痛 #咽喉疼痛#鼻塞#流鼻涕 #神志改变 #出汗#震颤#伤感#崩溃明天上学#恶心#头晕#面色苍白#出汗#腹痛#血压下降",
  "<name>你知道吗，世界上有四种尺：直尺，三角尺，卷尺，还有I love you very much",
  "<name>🤤!あなたのために😨😨😨私は狼男になります🐺🐺🐺あなたのために😱😱😱 狂気に染まった🤡🤡🤡あなたのために😰😰😰厚い偽装を着て💆💆💆あなたのために🤗🤗🤗心を変えた💀💀💀私たちはまた会うことができます🥺🥺🥺私は仏求待ちわびていた数千年前に🙇🙇🙇数世でたく🥰🥰🥰換われわれ世情💞💞💞感動できる希望天😭😭😭私たちはまた会えるかどうか🥺🥺🥺私は仏求待ちわびていた数千年前に🙇🙇🙇でも私はこの橋を渡る前に🎭🎭🎭もう一度あなたの顔にキスさせて😘?",
  "从前有人问:如果船上的木头被逐渐替换，直到所有的木头都不是原来的木头，那这艘船还是原来的那艘船吗？我也问自己:人的细胞每七年更新一次，七年后的我还能记得乃琳吗？很多年后我才知道，我之所以像条不系之舟四处漂泊，就是为了向<name>靠近",
  "<name>终于发动态了😭😭😭<name>终于发动态了😭😭😭<name>终于发动态了😭😭😭<name>终于发动态了😭😭😭<name>😭😭😭<name>😭😭😭我身上的🐜🐜🐜🐜爬走了",
  "姨帮人刷了二十年墙壁了，上次在帮一个业主叫<name>的家刷，突然在刷墙的时候他们家业主过来不小心踢倒了我的紫色油漆桶，于是我大喊“我的漆紫！我的漆紫！”​",
  "真可怜，<name>又被他们欺负了吧，你应该清楚，只有我才是你的朋友，只有我爱你啊😭，为什么！为什么要害怕！你的朋友只有我一个人，我对你这么好，对不起，我不该打你，但是谁叫你是坏孩子，原谅我，我会把所有的爱给你，我真的爱你，刚才不该打你，对不起，我爱你，对不起，我爱你，对不起，我爱你，对不起，我爱你，对不起，我爱你，这张脸真可爱啊，但是它迟早会变老，我不忍心看到你变老的样子，让时间停在这一刻吧，现在死掉，你的可爱会成为永恒，求你死吧，我好残忍😱，原谅我，<name>，今天原谅我犯下的错误，明天会给你更多的爱😋😋😋😋",
  "晚上被割的手腕疼，睡着又被麻醒，那是跟你分开后的第一个月，打开手机没有你的消息，循环播放断线，看着黑漆漆的外面哭累了就睡。<name>！！！我的<name>！！！😘😘😘",
  "今天被工长骂了 说我拌的水泥太稀了 工长把我的铁锹捶烂了 问我水是不是不要钱 我不敢反驳 他不知道的是 我没有多放水 只是拌水泥时很想<name> 眼泪掉进了水泥里",
  "我明明调的夜间模式，<name>却像阳光一样耀眼🥰\n明明下载了国家反诈中心APP，可还是被<name>骗走了心🥵​",
  "今天上完文化课，大哥走在路上，温习着刚学到的新单词，不小心撞到了<name>。\n大哥：Sorry.\n<name>：I'm sorry too.\n大哥想了想，接着说：I am sorry three.\n<name>听完一愣，问道：What are you sorry for?\n这时大哥鼓起勇气回答道：I am sorry five！",
  "不许碰我的<name>😭😭😭👊👊👊你们不许碰我的😭😭😭👊👊我鲨了你😭😭🔪",
  "有一天我把脚踝扭伤了，<name>帮我贴膏药，结果他竟然直接往我嘴里塞，我立刻明白过来他以为是内用，于是我赶紧大喊：“外敷！外敷！”​",
  "<name>，我的<name>宝贝😍😍😍，野⚡性⚡的⚡本⚡能⚡难⚡抗⚡拒❌❌❌多⚡么⚡想⚡要⚡一⚡口⚡吞⚡下⚡甜⚡得⚡像⚡蜜⚡的⚡你🍯🍯🍯 先😤闻😤香😤味😤欣😤赏😤你😤的😤细😤腻😤我💅用💅品💅尝💅红💅酒💅那💅样💅优💅雅💅地💅享💅用💅你💅 等到满月升起之前一定要抓到你🌕🌕⚠️⚠️我是wolf 🐺一头wolf 🐺🐺🐺啊呜～啊！撒↘浪↗嘿↗↗↗哟～～❤️❤️❤️ 你是美女💃🏻💃🏻💃🏻我是狼🐺🐺🐺 我是wolf 🐺一头wolf 🐺🐺🐺啊呜～啊！撒↘浪↗嘿↗↗↗哟～～❤️❤️❤️ 你是美女💃🏻💃🏻💃🏻我是狼",
  "<name>小姐我爱你，就像老鼠爱大米；\n无法忍受没有你的日夜，你就像耗子偷油偷走我的心。\n<name>小姐我爱你，就像扑棱蛾子爱火炬；\n见到你的每个瞬间都值得纪念，想变成蛔虫钻进你肚里。\n\n啊，<name>小姐，我生命之光，我欲念之火，我的罪孽，我的灵魂。\n爱你的鼻子，爱你的眼睛，爱你的气息，爱你的声音。\n啊，<name>小姐，你是那般完美无缺，令我如痴如狂。\n有鼻子有眼，有胳膊有腿，有头发有指甲，衣冠楚楚，人模狗样。\n\n<name>小姐，从上颚到牙间，一共_个音节；\n无时无刻不在念叨着你的名字，就像念经的唐僧一样虔诚。\n<name>小姐，你是我的永远，我是你的忠仆；\n你让我是猫我就是猫，你让我是狗我就是狗，狂热地献上我的真心，即使你将把它戳破。\n\n<name>小姐我爱你，想扑进你怀里，就像你撞进我心里；\n<name>小姐，香香的软软的，轻轻的小小的，一拳就能哭上很久，像含羞草泣下露珠。\n<name>小姐我爱你，想一点点吃掉你，和你融为一体；\n从头顶到脚底，从指尖到脚尖，从皮肉到肺腑，从大脑到心脏，彻底不分彼此。",
  "最讨厌<name>了。\n总是多管我的闲事，人也笨，麻烦，讨厌。\n烂好人，容易被骗，讨厌。\n总是操心个不停，像个老妈妈一样,\n麻烦死了，讨厌。\n冲他乱发火也不会生气，自作多情,\n最讨厌了。\n讨厌讨厌讨厌，最讨厌了。\n但在我哭的时候又会温柔的安慰我,\n在我遇到困难的时候总是来帮我\n有一点点喜欢呢。\n保护我的时候却又那么帅气，关心我\n的时候又那么温柔\n无理取闹也不会生气。\n喜欢你啊!八嘎!\n为什么察觉不到啊，八嘎八嘎八嘎,\n最讨人厌啦。\n但又是那么喜欢你，suki, suki,daisiki。\n笨蛋，再多看看我啊!毕竟人家\n最喜欢<name>了啊。",
  "是、是的···♡！我真的想要···好想要···♡呜呜、不行了<name>🥵🥵🥵我的<name>🤤🤤🤤嘿嘿嘿🤤好喜欢🤤想要能亲一下🤤亲一下就好🤤还会得寸进尺想要别的🤤嘿嘿嘿……🤤嘿嘿嘿💘💘💘好喜欢🤤想要能亲一下😍😍😍亲一下就好💕💕💕还会得寸进尺想要别的🤤嘿嘿嘿🥵🥵🥵嘿嘿嘿好喜欢💗💗💗想要能亲一下​",
  "今天早上老师怒气冲冲的进教室，一下就把作业摔在了讲台桌上，大声的质问我：“你的作业是怎么写的！？”我说：“是我自己写的。”老师更生气了，一把揪出<name>的作业本扔在我面前，问：“那你的作业为什么和<name>的一样！”我只好羞愧的地下了头，老师继续质问，我再也忍不住了，大声喊道：“是我抄的<name>！是我抄的<name>！”​",
  "裤裆起火一蹦三尺高，我姐妹怒抓十个灭火器与我对线无果，因为这是我对<name>浇不灭的爱情之火我流泪不止又欲哭无泪，因为我害怕泪水模糊了眼睛，让我没办法看清这张绝世帅脸， 我发疯，我在客厅发疯了我在上蹿下跳，嘴里念念有词，我不发疯我不是人！<name>！！<name>草草！",
  "我搬到<name>家旁边，上午工作的时候我吵他，他很生气，于是在晚上的时候吵我，我被他吵的受不了，哭着喊不要了，求他不要吵我了，但是他就是不停，一直吵一直吵，吵死我了。​",
  "我大部分时间觉得看谁都不顺眼，就想在网上骂一骂，我当时怀疑我也是狂躁症。后来我真的去医院看了，填了一堆调查问卷，那个医生说我什么事都没有，草一顿<name>/就好了",
  "<name>！！！！为了你😨😨😨 我变成狼人摸样🐺🐺🐺 为了你😱😱😱 染上了疯狂🤡🤡🤡 为了你😰😰😰 穿上厚厚的伪装👹👹👹 为了你🤗🤗🤗 换了心肠💀💀💀 我们还能不能再见面🥺🥺🥺 我在佛前苦苦求了几千年🙇‍♂️🙇‍♂️🙇‍♂️ 愿意用几世🥰🥰🥰 换我们一世情缘💞💞💞 希望可以感动上天😭😭😭 我们还能不能能不能再见面🥺🥺🥺 我在佛前苦苦求了几千年🙇‍♂️🙇‍♂️🙇‍♂️ ",
  "其实我是一个不太愿意付出喜欢和爱的人，因为这样会变得失控，会被轻易牵动喜怒哀乐。喜欢上<name>以后呢，开始变得有一些患得患失，她真的太好了，我却没有办法创造出只属于乃琳的世界，太遗憾了，所以总是想控制住自己已经快要失控的爱意爱意。但是，今天我明白了，我喜欢上<name>这件事是“合理失控”",
  "在没有遇到<name>之前，我脖子上戴着佛珠左手拿十字架右手拿符纸，请了六十个老和尚在我旁边打坐念经。看见<name>后，我靠，这就是我的命中注定，这就是我的人生唯一，我扯下我的佛珠，扔掉我的十字架，撒光我的符纸，赶跑六十个老和尚，我不再需要这些了，此时此刻我满心满眼都是你，我整个人都在地板上打滚，我亲吻我的地板，我捶烂我的墙壁，我喝了十八碗二锅头，我为你而醉，我惊声尖叫😭😭😭​",
  "<name>求求你快直播吧😭😭😭我在床上哭了四个小时😭崩溃了16次😭撞了134次墙😭划了397次手臂😭幻觉出现两次😭幻听出现三次😭扇了自己79个巴掌😭出现濒si感一次😭刚才昏过去了现在才醒来看到外面天都黑了我顿时又崩溃了😭😭😭 因为我怎么想都想不明白你这么可爱还这么能干究竟是怎么做到的 <name> 好想你啊宝 你是我心里的宝啊！",
  "我现在在医院的重症室里，躺在病床上戴着呼吸机，颤抖的手仍然拿着手机，花了的眼不离屏幕半分，那清脆的消息回复的声音再没有响起。我哭不出来，等他没有结果。我知道我没有多少时间了，生命在煎熬中流逝。终于，倦意袭来，我用尽了最后的力气打出了一行字: \n <name>，我的老婆我好爱你!!!口水不会白流，以普遍理性而论，它们蒸发成云，总有一天能降落到<name>的鼻尖🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤🤤​",
  "<name>万圣节说要扮鬼吓我\n我问她要扮什么鬼\n她说给我表演出轨",
  "你们这些人到底会不会跟女孩子聊天啊？让我来\n<name>练的什么歌啊？练歌的时候有没有什么好玩的事情呀？<name>平时喜欢听什么类型的歌呀？<name>喜欢吃什么口味的饼干呀？平常练习的时候会不会偷偷吃东西呢？<name>你可要保护好嗓子啊，我想天天都见到你。555555555<name>不想练就不练了吧，我只要看到你就够了😭😭😭😭😭<name>我已经成为你的狗了😭😭😭",
  "我忘不掉<name>小姐了。如果不是遇到了<name>小姐，我就对这个世界没有留恋了。<name>小姐真→的↘↗好↗可爱啊。做料理的时候笨拙的样子很可爱，故意撒娇养gachi也很可爱，唱歌的时候很可爱，生气的时候也很可爱。我早已离不开<name>小姐了。如果早晨不是有<name>小姐的起床闹钟的话，我永远都不愿意睁眼了。如果晚上不是有<name>小姐的直播预定的话，这一天我都过不完了。<name>小姐的眼睛好灵动，如果.能映照出我.就好了。<name>小姐的笑容好温柔，如果.只为我一一个人绽放.就好了。<name>小姐的头发好柔顺，如果.能让我尽情抚摸.就好了。<name>小姐这样的存在真的是被允许的吗😭只是像现在这样默念<name>小姐的<name>，我就觉得,自己是世界上最幸福的傻子～😭",
  "众士兵：“渴……渴……”\n　　曹操：“大家再坚持一会！大家想想<name>”\n　　众士兵：“<name>🤤嘿嘿🤤<name>🤤”\n　　半个时辰后——曹仁：“主公！探险队找到了大量的水源！”\n　　曹操：“哈哈哈哈，大家听到了吗？终于有水喝啦”\n  众士兵：“不去……一定要找到<name>🤤🤤🤤……",
  "<name>和我当年是前后桌，他总是抄我的作业，某天抄作业被老师发现了。老师问我俩谁抄谁的，全班同学大喊，「<name>抄他！<name>抄他！」老师的眼神看向我，我打死不承认，「不对，我抄<name>。」\n此时<name>从桌子上抬起头，因为趴着睡觉头发有些凌乱，他眼里带着笑意，声音带着刚刚睡醒的哑，「嗯，我抄的他。」​",
  "<name>想举报我考试抄他的答案🥵他一直挡着说 不要抄了 不要抄了🥵当时他的眼泪都流下来了🥵可是我还是没听<name>说的😢一直在抄他🥵呜呜呜呜🥺​",
  "<name>你看我能把心取出来\n♥\n我还能把心塞回去\n\n再让你看一遍\n\n我的心呢？😨\n原来是你把我的心偷走了，<name>你坏事做尽​😭😭😭",
  "刚刚回学校的路上真恐怖啊 ，我只想买点零食，结果差点吓死，进了超市以后总感觉有几个女的跟着我，我走哪她们跟哪，我想走快点结果其中一个女的过来拍我肩膀，我顿时一慌，然后那女的看看我说了句 \"抱歉认错人了\"  ，我想那我继续买东西吧，然后过会我听到她小声地跟其他人说：“\n\n我靠真的是<name>的男朋友啊！ ”",
  "如果有一天，你看见医院许多救护车抢救着许多男孩子，都请不要嘲笑他们，骂他们是疯子 傻子 神经病，因为那天是<name>和我结婚的日子",
  "倒不是说对<name>有什么性幻想，毕竟我也不是南通。\n该说不说的，<name>这个样子，确实有点性感，我不是南通，但是有一说一，确实有点性感。\n我也不是说喜欢<name>，但是这个样子确实是挺好看的，我不是南通。",
  "<name>给我洗了一盘葡萄，我吃了一个酸的赶紧吐出来，口水留个不停，看<name>快生气了我连忙解释“太涩了，太涩了🥵​",
  "<name>！📢不要做无畏的挣扎！📢你已经被我看中📢马上放下你的羞涩与我结婚📢 不要做无畏的挣扎！📢你已经被我看中📢马上放下羞涩与我结婚📢 不要做无畏的挣扎！📢你已经被我看中📢马上放下羞涩与我结婚📢 不要做无畏的挣扎！📢你已经被我看中📢马上放下羞涩与我结婚​",
  "<name>，你是负二，我是负五，我们两个加在一起就是夫妻啊😭😭😭",
  "啊啊啊<name>大人我好喜欢你♡你是我见过最美丽最动人的女孩 ♡呜呜呜我已经成了脑子里只有<name>的baka了，呜…… ♡呐呐，<name>大人一定也是喜欢瓦达西的，对吗？诶嘿嘿嘿嘿…… ♡sukisukisukisuki！ ♡我最喜欢最喜欢<name>啦～ ♡",
  "“你对<name>小姐的爱有多重？”\n“大约300克”\n“300克？你是想说人类的心脏大约是300克吗？”\n“不，鼠鼠的平均大体重约是300克，因此我是全身心地爱着<name>小姐。",
  "<name>小姐，从我拿起笔，准备叙述你的细节开始，总是忍不住走神，真抱歉，情话没写出几个，但我却真真实实想了你一个小时。",
  "一条道上有两个土坡，有一个是有了很多年的有一个是新的，有一天一个人过那个老坡的时候不小心撒了点辣椒面在上面。后来一个人正好摔了一跤舔到了辣椒面，赶紧爬起来哭着喊:“老坡好辣！老坡好辣！”🥵🥵🥵🥵🥵🥵​",
  "有一天，我问<name>：“你知道世界上最硬的东西是什么吗？”\n“我当然知道，是钻……”可能觉得我问的问题另有含义，<name>停了下来，脸上泛起红晕，有点娇羞，扭扭捏捏的，声若蚊蝇：“是……你……你的……”\n“是你的的嘴，真是笨蛋”看<name>磨磨蹭蹭，两根食指互相点来点去的样子，我忍不住亲了上去……\n奇怪，怎么像棉花糖一样软软的！",
  "我一直想不起来这种甜品叫什么，直到见到了<name>我突然想起来，对他大喊：炒柿泥啊，炒柿泥啊​",
  "今天是<name>瘾发作最严重的一次， 躺在床上，拼命想<name>的名字，难受的一直抓自己眼睛，以为刷b站没事，发现全b站都在推<name>的视频，眼睛越来越大都要炸开了一样，拼命扇自己眼睛，越扇越用力，扇到自己眼泪流出来，真的不知道该怎么办，我真的想<name>想得要发疯了。我躺在床上会想<name>，我洗澡会想<name>，我出门会想<name>，我走路会想<name>，我坐车会想<name>，我工作会想<name>，我玩手机会想<name>，我盯着路边的<name>看，我盯着马路对面的<name>看，我盯着地铁里的<name>看，我盯着网上的<name>看，我盯着朋友圈别人合照里的<name>看，我每时每刻眼睛都直直地盯着<name>看，像一台雷达一样扫视经过我身边的每一只<name>， 我真的觉得自己像中邪了一样，我对<name>的念想似乎都是病态的了，我好孤独啊！真的好孤独啊！<name>😭<name>😭没有你我可怎么活啊😭<name>",
  "老师问三个学生，你们用什么东西可以填满一整个房间。第一个学生找来稻草铺满地板，老师摇了摇头。第二个学生找来一根蜡烛点燃，屋子里充满了光，老师还是摇了摇头，因为学生的影子没有被照到。这时第三个学生播放了<name>的照片，顿时四个人弄的满屋都是。",
  "给大家扒一扒<name>的黑料\n1.不听劝，总是急着要和我结婚\n2.不敬业，总是在工作时期陪我\n3.花钱大手大脚，前几天刚给我买了个钻戒\n4.没礼貌，对我之外的所有人爱理不理\n5.粗暴，每天都抱我很紧\n<name>的黑料还有很多，出于我们两人之间的隐私--大家注意避雷这种小可爱的真的不行",
  "小偷日记：2022年3月24日 晴\n偷偷潜入<name>家，\n当看到卧室熟睡的<name>，我愣住了。\n当小偷这么多年，还是第一次被别人偷了东西。​",
  "提拉米苏含义是记住我，带我走，是非常具有意义的叫法。传说提拉米苏有一个很浪漫的故事，战乱时有一个意大利士兵要离开家去前线打仗，他的妻子就把家里存的面包，饼干，奶油和黄油全部打碎拌在一起，给丈夫带走了，之后提拉米苏在意大利语中就是带我走的意思。\n\n<name>你提拉米苏我吧😨😨😨😨",
  "今天我路过天桥。长得很面善的叔叔拦住了我，告诉我，他是算命的，我当然不会信这些封建糟粕。但这个叔叔说算不准不要钱，并且准确地报出了我的名字，生日和生辰八字。我心里打鼓又期待，想知道自己接下来能听到什么，但是这个叔叔并没有给我带来好消息。\n他告诉我，我剩下的一生中忙碌疲惫，疲于奔命，困苦不堪，毫无长进，冥冥中似乎有破解，遇到他一定会逢凶化吉，欣欣向荣，万事亨通。\n我迫切的问这位叔叔究竟是什么事，他说我一定会遇到命中注定的老婆，这位老婆腰细腿长，容貌甚佳，温柔体贴，性感迷人遥不可及。\n我问他这个人叫什么名字，他告诉我叫<name>。\n<name>，原来你是我命中注定的老婆🥺😍",
  "弗洛伊德曾经说过，人的精神由三部分构成，本我，自我和超我，前两部分我都有，我觉得<name>能给我第三部分。"
];

