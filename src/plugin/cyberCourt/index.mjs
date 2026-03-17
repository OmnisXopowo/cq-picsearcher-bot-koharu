/**
 * 赛博升堂 - 群聊禁言投票插件 v2.0
 * 
 * 功能：用户回复某条消息并发起投票，群成员共同决定是否对发言者执行禁言
 * 
 * 新增功能：
 * - 复审系统（同一天第二次被起诉为复审）
 * - AI法官小爱法官生成宣判小结
 * - 投票催促系统（2分钟无投票自动提醒+AI文案）
 * 
 * 命令：
 * - /升堂 [诉状]：回复消息发起审判（案由为被回复的消息内容）
 * - /赞成 [理由]：投票赞成禁言
 * - /反对 [理由]：投票反对禁言
 * - /宣判 或 /结案：管理员提前结束审判
 * - /撤案：管理员或原告取消审判
 */

import AxiosProxy from '../../utils/axiosProxy.mjs';
import CQ from '../../utils/CQcode.mjs';
import dailyCount from '../../utils/dailyCount.mjs';
import { getRawMessage } from '../../utils/message.mjs';
import { getKeyObject, setKeyObject } from '../../utils/redisClient.mjs';
import { createJWT } from '../AImodule/auth.mjs';

// 日志前缀
const LOG_PREFIX = '[CyberCourt]';
const log = (...args) => console.log(LOG_PREFIX, ...args);
const logError = (...args) => console.error(LOG_PREFIX, ...args);

// ==================== 工具函数 ====================

/**
 * 从消息对象中提取文本内容，转义特殊CQ码为中文描述
 */
function extractMessageText(msgObj) {
  if (typeof msgObj === 'string') {
    return msgObj;
  }
  
  if (Array.isArray(msgObj)) {
    return msgObj
      .map(item => {
        if (typeof item === 'string') return item;
        if (item.type === 'text' && item.data?.text) return item.data.text;
        if (item.type === 'text' && typeof item.data === 'string') return item.data;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  
  if (msgObj && typeof msgObj === 'object') {
    if (msgObj.text) return String(msgObj.text);
    if (msgObj.data?.text) return String(msgObj.data.text);
  }
  
  return String(msgObj || '');
}

/**
 * @typedef {Object} VoteData
 * @property {1|-1} choice - 投票选择：1=赞成，-1=反对
 * @property {string|null} reason - 投票理由
 * @property {string} nickname - 投票者昵称
 * @property {number} time - 投票时间戳
 */

/**
 * @typedef {Object} CourtSession
 * @property {number} groupId - 群号
 * @property {boolean} active - 是否激活
 * @property {number} startTime - 开始时间戳
 * @property {number} duration - 窗口持续时间（毫秒）
 * @property {NodeJS.Timeout|null} timeout - 超时定时器
 * @property {Object} defendant - 被告信息
 * @property {Object} prosecutor - 原告信息
 * @property {string} courtReason - 诉状
 * @property {Object.<number, VoteData>} votes - 投票数据
 * @property {number} lastVoteTime - 上次投票时间戳
 * @property {boolean} isRetrial - 是否为复审
 * @property {number} lastGroupMsgTime - 群内最后消息时间戳
 * @property {number} lastReminderMsgTime - 上次播报消息时间戳
 * @property {number} nextScheduledReminderTime - 下次计划播报时间
 */

/** @type {Map<number, CourtSession>} */
const courtSessions = new Map();

/**
 * 待裁决的复审状态（纯内存，机器人重启时自然清空）
 * @type {Map<number, PendingRetrial>}
 * @typedef {Object} PendingRetrial
 * @property {number} defendantId - 被告ID
 * @property {string} defendantName - 被告昵称
 * @property {number} favor - 赞成票数
 * @property {number} against - 反对票数
 * @property {number} total - 总票数
 * @property {NodeJS.Timeout} timeoutId - 超时定时器
 * @property {number} createTime - 创建时间戳
 */
const pendingRetrials = new Map();

// ==================== 配置获取 ====================

function getConfig() {
  return global.config.bot?.cyberCourt || {
    enable: false,
    voteWindowMinutes: 10,
    quickPassCount: 5,
    muteTimeMinutes: 30,
    reminderIntervalMinutes: 2,
    userDailyLimit: 1,
    adminDailyLimit: 0,
    immuneRoles: ['admin', 'owner'],
    immuneUsers: [],
    blackGroup: [],
    whiteGroup: [],
    aiJudge: {
      enable: false,
      apiKey: '',
      systemRole: '你是「小爱法官」，一位QQ群里的赛博法庭主审法官。风格：诙谐幽默、金句频出、像脱口秀演员一样点评案件，适度毒舌但不恶毒。任务：根据案由、诉状、陪审团意见和判决结果，输出100字以内的宣判小结。要求：1.语言活泼接地气，可以玩梗和网络用语 2.对判决结果进行戏谑性解读 3.适度吐槽原告或被告的行为 4.可以引用或魔改名言警句 5.结尾用一句话总结教训或感慨'
    }
  };
}

function getGroupConfig(groupId) {
  const baseConfig = getConfig();
  const whiteGroup = baseConfig.whiteGroup || [];
  const groupOverride = whiteGroup.find(g => g.group === groupId);
  
  if (groupOverride) {
    return { ...baseConfig, ...groupOverride };
  }
  return baseConfig;
}

// ==================== 权限检查 ====================

function isBotAdmin(userId) {
  return userId === global.config.bot.admin;
}

async function isGroupAdmin(groupId, userId) {
  try {
    const { data } = await global.bot('get_group_member_info', {
      group_id: groupId,
      user_id: userId
    });
    return data && (data.role === 'admin' || data.role === 'owner');
  } catch (e) {
    logError('获取群成员信息失败:', e.message);
    return false;
  }
}

async function hasAdminPermission(context) {
  const { group_id, user_id } = context;
  
  if (isBotAdmin(user_id)) {
    return true;
  }
  
  return await isGroupAdmin(group_id, user_id);
}

async function isImmune(groupId, userId) {
  const config = getGroupConfig(groupId);
  
  // 机器人主人
  if (isBotAdmin(userId)) {
    return true;
  }
  
  // 配置的豁免用户
  if (config.immuneUsers?.includes(userId)) {
    return true;
  }
  
  // 注意：管理员和群主不再自动豁免，可以被升堂投票
  // 但执行禁言时会根据身份做特殊处理（呼叫群主或发送搞笑消息）
  
  return false;
}

/**
 * 获取用户在群中的角色
 * @returns {'owner'|'admin'|'member'|null}
 */
async function getGroupMemberRole(groupId, userId) {
  try {
    const { data } = await global.bot('get_group_member_info', {
      group_id: groupId,
      user_id: userId
    });
    return data?.role || null;
  } catch (e) {
    logError('获取群成员角色失败:', e.message);
    return null;
  }
}

/**
 * 生成管理员/群主无法禁言时的搞笑文案
 */
function getAdminMuteFailMessage(role, nickname, muteMinutes) {
  if (role === 'owner') {
    const ownerPhrases = [
      `⚖️ 判决：有罪！\n\n然而...被告 ${nickname} 是群主大人 👑\n\n🤷 本法庭建议：\n1. 请能人异士联系腾讯客服\n2. 或祈祷群主良心发现自行闭麦\n3. 实在不行...大家一起念经超度？\n\n📜 法官批注：天子犯法，庶民只能干瞪眼`,
      `⚖️ 有罪！禁言${muteMinutes}分钟！\n\n等等...${nickname} 是群主？👑\n\n😅 这...这超出了本法庭的管辖范围\n💡 建议被告自觉面壁思过\n🙏 或者哪位大神帮忙找腾讯开后门？\n\n📜 法官叹息：真是法外狂徒张三本三`,
      `⚖️ 陪审团一致裁定：有罪！\n\n📢 执行禁言...\n❌ 执行失败！\n\n原因：被告 ${nickname} 是本群至高无上的群主 👑\n\n🎭 建议处置方案：\n• 全群复读「群主有罪」\n• 等待天降正义\n• 玄学退群重进（大概率被踢）\n\n📜 法官无奈：权力使人腐败，群主使人无奈`
    ];
    return ownerPhrases[Math.floor(Math.random() * ownerPhrases.length)];
  }
  
  // admin
  const adminPhrases = [
    `⚖️ 判决：有罪！\n\n⚠️ 但被告 ${nickname} 是本群管理员\n本法庭无权对管理员执行禁言\n\n📢 @群主 请出面主持公道！\n建议对该管理员禁言 ${muteMinutes} 分钟\n\n📜 法官批注：管理员也要遵纪守法啊喂！`,
    `⚖️ 有罪！应禁言${muteMinutes}分钟！\n\n😱 等等，${nickname} 是管理员？！\n\n本法庭权限不足，特此呈请：\n📢 @群主 群主大人明鉴！\n您的管理员犯事了，请亲自处理~\n\n📜 法官吐槽：监守自盗是吧`,
    `⚖️ 陪审团裁定：有罪！\n\n🚫 禁言执行失败\n原因：被告 ${nickname} 持有管理员护身符\n\n📢 紧急呼叫 @群主\n请对您的小弟进行制裁！\n建议刑期：${muteMinutes}分钟\n\n📜 法官碎碎念：请群主好好管教一下`
  ];
  return adminPhrases[Math.floor(Math.random() * adminPhrases.length)];
}

async function checkBotAdminPermission(groupId) {
  try {
    const loginInfo = await global.bot('get_login_info');
    const selfId = loginInfo.data?.user_id;
    if (!selfId) return false;
    
    const { data } = await global.bot('get_group_member_info', {
      group_id: groupId,
      user_id: selfId,
      no_cache: true
    });
    return data && (data.role === 'admin' || data.role === 'owner');
  } catch (e) {
    logError('检查机器人权限失败:', e.message);
    return false;
  }
}

// ==================== 票数统计 ====================

function countVotes(session) {
  let favor = 0;
  let against = 0;
  for (const vote of Object.values(session.votes)) {
    if (vote.choice === 1) favor++;
    else if (vote.choice === -1) against++;
  }
  return { favor, against, total: favor + against };
}

// ==================== 被告每日计数 ====================

function getDefendantDailyKey(groupId, defendantId) {
  return `${groupId}_${defendantId}:cyberCourt_defendant`;
}

// ==================== 随机文案 ====================

function getRandomVerdictPhrase(isGuilty) {
  const guiltyPhrases = [
    '⚔️ 法官宣布：有罪，禁言！',
    '⚔️ 经陪审团投票，判决有罪·禁言！',
    '⚔️ 本法庭裁定：有罪，禁言伺候！',
    '⚔️ 据众议判，被告有罪·立即禁言！',
    '⚔️ 判决生效：有罪，予以禁言处罚！',
    '⚔️ 赛博升堂判决：有罪，禁言刑罚！'
  ];
  
  const innocentPhrases = [
    '🛡️ 法官宣布：无罪，释放！',
    '🛡️ 经陪审团投票，判决无罪·释放！',
    '🛡️ 本法庭裁定：无罪，予以释放！',
    '🛡️ 据众议判，被告无罪·立即释放！',
    '🛡️ 判决生效：无罪，予以释放处置！',
    '🛡️ 赛博升堂判决：无罪，予以释放！'
  ];
  
  const phrases = isGuilty ? guiltyPhrases : innocentPhrases;
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function getKeyVotePhrase() {
  const phrases = [
    '⚡ 关键性的一票！',
    '🎯 这一票至关重要！',
    '💥 民主的又一场胜利！',
    '🔔 投票有效，即刻宣判！',
    '⚙️ 法庭即将做出决定！',
    '👊 任何邪恶必将绳之以法！'
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

/**
 * 判断投票激烈程度
 */
function getFightingLevel(favor, against) {
  const total = favor + against;
  if (total === 0) return '无人投票';
  
  const diff = Math.abs(favor - against);
  const ratio = diff / total;
  
  if (ratio === 0) return '势均力敌（平票）';
  if (ratio <= 0.2) return '激烈交锋（票数极为接近）';
  if (ratio <= 0.4) return '胶着对峙（票数接近）';
  if (ratio <= 0.6) return '略有优势';
  if (ratio <= 0.8) return '明显优势';
  return '一边倒（压倒性优势）';
}

/**
 * 生成判决类型描述
 */
function getVerdictType(session, total, favor, against, reason, config) {
  const isRetrial = session.isRetrial;
  
  // 快速通过（赞成多数）或快速释放（反对多数）
  if (!isRetrial && total >= config.quickPassCount && favor !== against && reason.includes('阈值')) {
    return favor > against ? '快速通过' : '快速释放';
  }
  
  // 管理员宣判
  if (reason.includes('管理员')) {
    return isRetrial ? '复审管理员裁决' : '管理员提前宣判';
  }
  
  // 窗口期结束
  if (reason.includes('窗口期')) {
    const diff = Math.abs(favor - against);
    if (total === 0) return '无人投票自动结案';
    if (diff === 0) return '平票争议判决';
    if (diff <= 1) return '激烈票选险胜';
    if (favor === total || against === total) return '一致通过';
    return '投票期满判决';
  }
  
  return '正常判决';
}

/**
 * 获取被告历史AI总结的Redis Key
 * 格式: CyberCourt:AISummary:{groupId}:{defendantId}:{YYYYMMDD}
 * 24小时过期，每天自动清理
 */
function getDefendantAISummaryKey(groupId, defendantId) {
  const today = new Date();
  const dateStr = today.getFullYear() +
    String(today.getMonth() + 1).padStart(2, '0') +
    String(today.getDate()).padStart(2, '0');
  return `CyberCourt:AISummary:${groupId}:${defendantId}:${dateStr}`;
}

/**
 * 格式化倒计时
 */
function formatCountdown(remainingMs) {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}

/**
 * 判断是否应该发送播报
 * @returns {Object} { shouldSend: boolean, reason: string }
 */
function shouldSendReminder(session, config) {
  const now = Date.now();
  const endTime = session.startTime + session.duration;
  const remainingTime = endTime - now;
  const reminderInterval = (config.reminderIntervalMinutes || 2) * 60 * 1000;
  
  // 如果剩余时间少于1分钟，检查是否应该强制发送最后一次播报
  if (remainingTime < 60 * 1000) {
    // 必须距离上次播报超过催促间隔才发送最后一次
    const timeSinceLastReminder = now - session.lastReminderMsgTime;
    if (timeSinceLastReminder >= reminderInterval) {
      return { shouldSend: true, reason: '最后1分钟', isLastReminder: true };
    }
    return { shouldSend: false, reason: '上次播报不足2分钟，等待' };
  }
  
  // 正常播报逻辑：计算距离上次播报是否已超过2分钟
  const timeSinceLastReminder = now - session.lastReminderMsgTime;
  
  // 如果距离上次播报未达到2分钟，不发送
  if (timeSinceLastReminder < reminderInterval) {
    return { shouldSend: false, reason: '距上次播报不足2分钟' };
  }
  
  // 距离上次播报已超过2分钟，检查是否有新群聊消息
  // 只有当播报后群内有新消息时，才开始计时
  // 检查群内最后消息是否在上次播报之后
  if (session.lastGroupMsgTime > session.lastReminderMsgTime) {
    // 有新消息，发送播报
    return { shouldSend: true, reason: '有新群聊消息且满足间隔' };
  }
  
  // 如果上次播报后群内没有新消息，则不发送（避免刷屏）
  return { shouldSend: false, reason: '等待群内有新消息' };
}

// ==================== AI法官 ====================

async function generateJudgeSummary(session, isGuilty, reason) {
  const config = getGroupConfig(session.groupId);
  
  if (!config.aiJudge?.enable) {
    return null;
  }
  
  // 优先使用专用apiKey，未配置时回退到角色扮演的key
  const apiKey = config.aiJudge?.apiKey || global.config.bot.characterglm?.apiKey;
  if (!apiKey) {
    return null;
  }
  
  try {
    const jwt = createJWT(apiKey);
    if (!jwt) {
      logError('无法获取JWT');
      return null;
    }
    
    const verdictText = isGuilty ? '有罪（禁言）' : '无罪（释放）';
    const { favor, against, total } = countVotes(session);
    
    const msgStr = extractMessageText(session.defendant.originalMsg);
    const cleanMsg = CQ.cleanForDisplay(msgStr);
    
    // 统计陪审团意见
    const allVotes = Object.values(session.votes);
    const votesWithReason = allVotes.filter(v => v.reason);
    const votesWithoutReason = allVotes.filter(v => !v.reason);
    
    const allOpinions = allVotes
      .map(v => {
        const voteType = v.choice === 1 ? '赞成' : '反对';
        const reason = v.reason ? `："${v.reason}"` : '（未提供理由）';
        return `${voteType}方 ${v.nickname}${reason}`;
      })
      .join('\n');
    
    // 判断投票激烈程度和判决类型
    const fightingLevel = getFightingLevel(favor, against);
    const verdictType = getVerdictType(session, total, favor, against, reason, config);
    
    // 获取上次AI总结（如果是复审）
    let previousSummary = null;
    if (session.isRetrial) {
      const summaryKey = getDefendantAISummaryKey(session.groupId, session.defendant.userId);
      previousSummary = await getKeyObject(summaryKey);
      log(`复审: 尝试读取上次AI总结，key=${summaryKey}, 读取结果=${previousSummary ? '成功' : '失败（缓存不存在或已过期）'}`);
      if (previousSummary) {
        // 验证缓存数据的完整性
        if (previousSummary.summary && typeof previousSummary.isGuilty === 'boolean' && 
            typeof previousSummary.favor === 'number' && typeof previousSummary.against === 'number') {
          log(`  ✅ 上次总结数据完整: "${previousSummary.summary.substring(0, 40)}..."`);
          log(`  上次结果: ${previousSummary.isGuilty ? '有罪' : '无罪'}, 票数: 赞成${previousSummary.favor} 反对${previousSummary.against}`);
        } else {
          logError(`  ❌ 上次总结数据不完整，将忽略: ${JSON.stringify(previousSummary)}`);
          previousSummary = null;
        }
      }
    }
    
    // 构建prompt
    let userPrompt = `案件信息：
- 案件类型：${session.isRetrial ? `复审（被告今日第${session.defendantCount}次被起诉，累犯）` : '初审'}
- 被告：${session.defendant.nickname}
- 案由：${cleanMsg}
- 诉状：${session.courtReason || '原告未提供诉状'}
- 投票结果：赞成${favor}票，反对${against}票（共${total}票）
- 投票激烈度：${fightingLevel}
- 有理由投票：${votesWithReason.length}票 | 无理由投票：${votesWithoutReason.length}票
- 判决结果：${verdictText}
- 判决依据：${reason}
- 判决方式：${verdictType}`;

    if (isGuilty) {
      userPrompt += `\n- 禁言时长：${config.muteTimeMinutes}分钟`;
    }

    if (allOpinions) {
      userPrompt += `\n\n陪审团完整意见：\n${allOpinions}`;
    }
    
    if (previousSummary) {
      userPrompt += `\n\n上次判决AI总结：\n${previousSummary.summary}`;
      userPrompt += `\n上次判决结果：${previousSummary.isGuilty ? '有罪' : '无罪'}`;
      userPrompt += `\n上次投票：赞成${previousSummary.favor}票，反对${previousSummary.against}票`;
    }

    userPrompt += `\n\n请输出100字以内的宣判小结。`;
    
    if (session.isRetrial && previousSummary) {
      userPrompt += `\n要求：1. 点出这是复审/累犯 2. 可对比上次和本次的投票差异 3. 结合投票激烈度点评 4. 适度吐槽但保持幽默 5. 用金句收尾`;
    } else {
      userPrompt += `\n要求：1. 结合投票激烈度点评 2. 适度吐槽但保持幽默 3. 用金句收尾`;
    }

    const response = await AxiosProxy.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model: 'glm-4-flash',
        messages: [
          { role: 'system', content: config.aiJudge.systemRole || '' },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 200,
        temperature: 0.9
      },
      {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    const summary = response.data?.choices?.[0]?.message?.content;
    
    if (summary) {
      // 存储本次AI总结供下次复审参考（24小时过期）
      const summaryKey = getDefendantAISummaryKey(session.groupId, session.defendant.userId);
      const summaryData = {
        summary: summary.trim(),
        isGuilty,
        favor,
        against,
        total,
        timestamp: Date.now()
      };
      
      // 异步保存，失败不影响主流程
      const ttlSeconds = 24 * 60 * 60; // 24小时
      setKeyObject(summaryKey, summaryData, ttlSeconds)
        .then(() => {
          log(`✅ 已存储AI总结缓存 - key=${summaryKey}, TTL=24h`);
        })
        .catch(err => {
          logError(`❗ AI总结缓存保存失败: ${err.message}`);
        });
      
      return `\n\n🎭 小爱法官总结：\n${summary.trim()}`;
    }
    
    return null;
  } catch (e) {
    logError('AI法官生成失败:', e.message);
    return null;
  }
}

// ==================== 格式化消息 ====================

/**
 * 格式化陪审团投票记录
 * @param {Object} session - 审判会话
 * @returns {string} 格式化后的投票记录文本
 */
function formatJuryVotes(session) {
  const allVotes = Object.values(session.votes).sort((a, b) => a.time - b.time);
  if (allVotes.length === 0) return '';
  
  let result = `\n💬 陪审团投票记录：\n`;
  allVotes.forEach(vote => {
    const voteType = vote.choice === 1 ? '✅' : '❌';
    const reason = vote.reason ? `：${vote.reason}` : '';
    result += `${voteType}${vote.nickname}${reason}\n`;
  });
  
  return result;
}

/**
 * 生成AI催促文案
 */
async function generateReminderText(session, favor, against, total, config) {
  const globalConfig = getConfig();
  if (!globalConfig.aiJudge?.enable) {
    return '⏰ 时间不等人，请大家抓紧投票！';
  }

  // 优先使用专用apiKey，未配置时回退到角色扮演的key
  const apiKey = globalConfig.aiJudge?.apiKey || global.config.bot.characterglm?.apiKey;
  if (!apiKey) {
    return '⏰ 时间不等人，请大家抓紧投票！';
  }

  try {
    // 检查是否接近快速通过阈值（仅非复审）
    const isCloseToQuickPass = !session.isRetrial && total >= config.quickPassCount - 1;
    const needOneMore = !session.isRetrial && total === config.quickPassCount - 1 && favor > against;
    
    let prompt = `你是天童爱丽丝，一个热爱RPG游戏的中二少女法官。现在是投票窗口期，但已经2分钟没有人投票了。\n\n当前情况：\n- 被告：${session.defendant.nickname}\n- 赞成票：${favor} 票\n- 反对票：${against} 票\n- 总票数：${total} 票`;
    
    if (session.isRetrial) {
      prompt += `\n- 本案为复审，由管理员最终裁决`;
    } else {
      prompt += `\n- 快速通过需要：${config.quickPassCount}票且赞成多数`;
      if (needOneMore) {
        prompt += `\n- 重要：只差最后1票就能达到快速通过！`;
      } else if (isCloseToQuickPass) {
        prompt += `\n- 提示：已接近快速通过阈值`;
      }
    }
    
    prompt += `\n\n请生成一两句搞笑的催促文案，督促群友赶快行使投票权。要求：\n1. 符合爱丽丝的中二游戏玩家人设\n2. 可以用游戏术语或梗`;
    
    if (needOneMore) {
      prompt += `\n3. 重点强调只差最后一票，鼓励大家投出关键一票`;
    } else {
      prompt += `\n3. 幽默风趣，不要太严肃`;
    }
    
    prompt += `\n4. 控制在50字以内\n5. 直接输出文案，不要前缀`;

    const jwttoken = createJWT(apiKey);
    if (!jwttoken) {
      logError('无法创建 JWT token，返回默认催促文案');
      return '⏰ 时间不等人，请大家抓紧投票！';
    }
    
    const { data } = await AxiosProxy.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model: 'glm-4-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 100
      },
      {
        headers: {
          Authorization: jwttoken,
          'Content-Type': 'application/json'
        },
        validateStatus: status => 200 <= status && status < 500
      }
    );

    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
  } catch (e) {
    logError('AI催促文案生成失败:', e.message);
  }

  return '⏰ 时间不等人，请大家抓紧投票！';
}

/**
 * 格式化升堂公告
 */
function formatAnnouncement(session, config) {
  const msgStr = extractMessageText(session.defendant.originalMsg);
  // 先清理CQ码，再截断，避免CQ码被截断后无法正确清理
  const cleanedMsg = CQ.cleanForDisplay(msgStr);
  const originalMsgPreview = cleanedMsg.length > 50
    ? cleanedMsg.slice(0, 50) + '...'
    : cleanedMsg;
  
  let announcement = `⚖️ ═══ 赛博升堂 ═══ ⚖️
🥁 咚咚咚！！！ 威—— 武—— ！

👨‍⚖️ 被告：${session.defendant.nickname}
📜 案由：「${originalMsgPreview}」
👨‍💼 原告：${session.prosecutor.nickname}
⏰ 投票时间：${config.voteWindowMinutes} 分钟`;

  // 只在非复审时显示快速通过和禁言时间
  if (!session.isRetrial) {
    announcement += `\n⚡ 快速通过：${config.quickPassCount} 票总计且赞成多数`;
    announcement += `\n🔇 禁言时间：${config.muteTimeMinutes} 分钟`;
  }

  if (session.courtReason) {
    announcement += `\n\n📝 诉状：${session.courtReason}`;
  }

  announcement += `\n${'━'.repeat(8)}\n💬 投票方式：发送 /赞成 [理由] 或 /反对 [理由]\n⚠️ 每人仅限投票一次 | 原告和被告不得投票\n`;
  
  if (session.isRetrial) {
    announcement += `\n\n⚠️ 本案为复审（被告今日第${session.defendantCount}次被起诉）\n📋 复审将汇总投票结果供管理员参考\n🔨 管理员可发送 /宣判 提前结案\n⏳ 或庭审完毕30分钟内发送/宣判执行`;
  } else {
    announcement += `\n🎯 管理员：发送 /宣判 提前结案 或 /撤案 取消`;
  }

  return announcement;
}

/**
 * 格式化审判结果
 */
function formatResult(session, favor, against, total, isGuilty, reason, includeMuseInfo = false) {
  const msgStr = extractMessageText(session.defendant.originalMsg);
  // 先清理CQ码，再截断，避免CQ码被截断后无法正确清理
  const cleanMsg = CQ.cleanForDisplay(msgStr);
  const originalMsgPreview = cleanMsg.length > 50
    ? cleanMsg.slice(0, 50) + '...'
    : cleanMsg;
  
  const config = getGroupConfig(session.groupId);
  
  let msg = `⚖️ ═══ 审判结果 ═══ ⚖️\n\n`;
  msg += `📜 案由：「${originalMsgPreview}」\n`;
  msg += `👨‍⚖️ 被告：${session.defendant.nickname}\n\n`;
  msg += `📊 投票统计：\n`;
  msg += `   👍 赞成：${favor} 票\n`;
  msg += `   👎 反对：${against} 票\n`;
  
  msg += formatJuryVotes(session);
  
  msg += `\n` + getRandomVerdictPhrase(isGuilty);
  msg += `\n🔔 结案原因：${reason}`;
  
  if (includeMuseInfo && isGuilty) {
    msg += `\n\n🔇 禁言已执行：${config.muteTimeMinutes} 分钟 ⏱️`;
  }
  
  return msg;
}

/**
 * 格式化投票反馈
 */
function formatVoteFeedback(session) {
  const config = getGroupConfig(session.groupId);
  const { favor, against, total } = countVotes(session);
  
  let reportMsg = `📊 当前票数：✅ 赞成 ${favor} | ❌ 反对 ${against}`;
  
  // 复审显示管理员裁决提示，非复审显示快速通过进度
  if (session.isRetrial) {
    reportMsg += `\n⚠️ 本案为复审，将由管理员做最终裁决`;
  } else {
    reportMsg += `\n⚡ 快速通过进度：${total}/${config.quickPassCount} 票`;
  }
  
  reportMsg += `\n`;
  reportMsg += formatJuryVotes(session);
  
  return reportMsg;
}

// ==================== 核心逻辑 ====================

/**
 * 结束审判
 */
async function endCourt(groupId, reason = '窗口期结束', appendToReport = false, context = null) {
  const session = courtSessions.get(groupId);
  if (!session || !session.active) {
    log(`群 ${groupId} 没有进行中的审判或已结束`);
    return null;
  }
  
  log(`结束群 ${groupId} 的审判，原因: ${reason}`);
  
  session.active = false;
  if (session.timeout) {
    clearTimeout(session.timeout);
    session.timeout = null;
  }
  if (session.reminderInterval) {
    clearInterval(session.reminderInterval);
    session.reminderInterval = null;
  }
  
  const { favor, against, total } = countVotes(session);
  const isGuilty = total > 0 && favor > against;
  
  log(`群 ${groupId} 审判结果: 赞成${favor}/反对${against}/共${total}, 有罪: ${isGuilty}`);
  
  // 复审处理：等待管理员裁决
  if (session.isRetrial) {
    courtSessions.delete(groupId);
    await handleRetrial(session, favor, against, total, reason);
    return null;
  }
  
  courtSessions.delete(groupId);
  
  const config = getGroupConfig(groupId);
  
  // 提前检查被告角色，用于判断是否需要特殊处理
  let defendantRole = null;
  if (isGuilty) {
    defendantRole = await getGroupMemberRole(groupId, session.defendant.userId);
  }
  const isDefendantPrivileged = defendantRole === 'owner' || defendantRole === 'admin';
  
  // 生成AI法官小结
  const aiSummary = await generateJudgeSummary(session, isGuilty, reason);
  
  // 如果被告是管理员/群主且有罪，不显示"禁言已执行"
  const shouldShowMuteInfo = appendToReport && isGuilty && !isDefendantPrivileged;
  let resultMsg = formatResult(session, favor, against, total, isGuilty, reason, shouldShowMuteInfo);
  
  // 如果被告是管理员/群主且有罪，追加特殊处理消息
  if (isGuilty && isDefendantPrivileged) {
    const specialMsg = getAdminMuteFailMessage(defendantRole, session.defendant.nickname, config.muteTimeMinutes);
    resultMsg += `\n\n${'━'.repeat(8)}\n${specialMsg}`;
  }
  
  if (aiSummary) {
    resultMsg += aiSummary;
  }
  
  if (!appendToReport) {
    if (context) {
      global.replyMsg(context, resultMsg, false, true);
    } else {
      global.sendGroupMsg(groupId, resultMsg);
    }
  }
  
  // 执行禁言（仅对普通成员）
  if (isGuilty && !isDefendantPrivileged) {
    const executeMuseAction = async () => {
      const hasAdminPerm = await checkBotAdminPermission(groupId);
      const muteDuration = config.muteTimeMinutes;
      
      if (hasAdminPerm) {
        try {
          const durationSeconds = Math.max(60, muteDuration * 60);
          log(`执行禁言: 群${groupId} 用户${session.defendant.userId} 时长${muteDuration}分钟`);
          await global.bot('set_group_ban', {
            group_id: groupId,
            user_id: session.defendant.userId,
            duration: durationSeconds
          });
          log(`禁言执行成功`);
        } catch (e) {
          const errorMsg = `⚠️ 禁言执行失败，请管理员手动处理`;
          global.sendGroupMsg(groupId, errorMsg);
          logError('禁言执行失败:', e.message);
        }
      } else {
        const noPermMsg = `📢 机器人无管理员权限，请管理员手动禁言 ${muteDuration} 分钟`;
        global.sendGroupMsg(groupId, noPermMsg);
        log(`机器人无管理员权限，无法自动禁言`);
      }
    };
    
    if (appendToReport) {
      setTimeout(async () => {
        try {
          await executeMuseAction();
        } catch (e) {
          logError('延迟禁言执行异常:', e.message);
          // 即使延迟执行也需要通知错误
          global.sendGroupMsg(groupId, `⚠️ 禁言执行异常，请管理员检查并手动处理`);
        }
      }, 500);
    } else {
      await executeMuseAction();
    }
  }
  
  if (appendToReport) {
    return resultMsg;
  }
  
  return null;
}

/**
 * 处理复审 - 展示投票结果，等待管理员裁决（纯内存方案）
 */
async function handleRetrial(session, favor, against, total, reason) {
  const config = getGroupConfig(session.groupId);
  const timeoutMinutes = 30;
  const isGuilty = total > 0 && favor > against;
  
  const aiSummary = await generateJudgeSummary(session, isGuilty, reason);
  
  const msgStr = extractMessageText(session.defendant.originalMsg);
  // 先清理CQ码，再截断，避免CQ码被截断后无法正确清理
  const cleanMsgDisplay = CQ.cleanForDisplay(msgStr);
  const cleanMsg = cleanMsgDisplay.length > 50
    ? cleanMsgDisplay.slice(0, 50) + '...'
    : cleanMsgDisplay;
  
  let message = `⚖️ ═══ 投票结束 ═══ ⚖️\n\n`;
  message += `📜 案由：「${cleanMsg}」\n`;
  message += `👨‍⚖️ 被告：${session.defendant.nickname}\n\n`;
  message += `📊 投票统计：\n`;
  message += `   👍 赞成：${favor} 票\n`;
  message += `   👎 反对：${against} 票\n`;
  
  message += formatJuryVotes(session);
  
  message += `\n${'━'.repeat(8)}\n`;
  message += `📋 投票结果已汇总，管理员可：\n`;
  message += `   1️⃣ 发送 /宣判 执行禁言${config.muteTimeMinutes}分钟\n`;
  message += `   2️⃣ 手动设置禁言时长\n`;
  message += `⏳ 30分钟内未处理将自动释放被告`;
  
  if (aiSummary) {
    message += aiSummary;
  }
  
  await global.sendGroupMsg(session.groupId, message);
  
  // 设置超时自动释放（纯内存，无需 Redis）
  const timeoutId = setTimeout(async () => {
    if (pendingRetrials.has(session.groupId)) {
      pendingRetrials.delete(session.groupId);
      
      await global.sendGroupMsg(session.groupId, 
        `【复审超时】⚖️ 管理员未在${timeoutMinutes}分钟内处理\n` +
        `🛡️ 被告 ${session.defendant.nickname} 已自动释放`
      );
      
      log(`群 ${session.groupId} 复审超时，已自动释放被告`);
    }
  }, timeoutMinutes * 60 * 1000);
  
  // 保存待裁决状态到内存（包含定时器引用，便于清理）
  pendingRetrials.set(session.groupId, {
    defendantId: session.defendant.userId,
    defendantName: session.defendant.nickname,
    favor,
    against,
    total,
    timeoutId,
    createTime: Date.now()
  });
  
  log(`群 ${session.groupId} 复审等待管理员裁决，${timeoutMinutes}分钟后超时`);
}
/**
 * 处理发起升堂
 */
async function handleStartCourt(context) {
  const config = getGroupConfig(context.group_id);
  const { group_id, user_id, message } = context;
  
  log(`用户 ${user_id} 在群 ${group_id} 尝试发起升堂`);
  
  // 检查是否已有进行中的审判
  if (courtSessions.has(group_id)) {
    const existingSession = courtSessions.get(group_id);
    if (existingSession.active) {
      log(`群 ${group_id} 已有进行中的审判`);
      return global.replyMsg(context, '⚖️ 本群已有正在进行的审判，请等待结束 ⏳');
    }
  }
  
  // 解析回复的消息，获取被告
  const replyCode = CQ.findFirst(message, 'reply');
  const rMsgId = replyCode ? replyCode.get('id') : null;
  if (!rMsgId) {
    log(`用户 ${user_id} 未回复消息`);
    const helpText = `⚖️ 升堂命令格式：\n` +
      `回复被告的消息后发送 /升堂 [诉状]\n\n` +
      `📝 示例：\n` +
      `（回复某消息）/升堂\n` +
      `（回复某消息）/升堂 发言不当\n\n` +
      `💡 提示：案由为引用被告的消息，建议升堂时提供诉状，陪审团投票提供意见供法官宣判参考`;
    return global.replyMsg(context, helpText);
  }
  
  // 提取诉状（/升堂 后的内容）
  const pureMsg = CQ.removeTypes(message, ['reply', 'at']);
  
  const courtReason = pureMsg
    .replace(/^\/升堂\s*/, '')
    .trim() || null;
  
  log(`解析回复消息 ID: ${rMsgId}, 诉状: ${courtReason || '无'}`);
  log(`当前消息内容: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
  
  let originalMsg;
  try {
    const result = await global.bot('get_msg', { message_id: Number(rMsgId) });
    originalMsg = result.data;
    log(`获取到的原始消息: ${getRawMessage(originalMsg)}`);
  } catch (e) {
    logError('获取原始消息失败:', e.message);
    return global.replyMsg(context, '⚖️ 无法获取原始消息');
  }
  
  if (!originalMsg) {
    log(`无法获取原始消息`);
    return global.replyMsg(context, '⚖️ 无法获取原始消息 ❌');
  }
  
  const defendantId = originalMsg.sender.user_id;
  const defendantNickname = originalMsg.sender.nickname || String(defendantId);
  
  log(`被告: ${defendantNickname}(${defendantId})`);
  
  // 不能对自己升堂
  if (defendantId === user_id) {
    log(`用户 ${user_id} 尝试对自己升堂`);
    return global.replyMsg(context, '⚖️ 不能对自己发起升堂 🤨');
  }
  
  // 检查被告是否豁免
  if (await isImmune(group_id, defendantId)) {
    return global.replyMsg(context, '⚖️ 该用户享有豁免权，无法对其升堂 🛡️');
  }
  
  // 检查发起人今日次数
  const hasAdminPerm = await hasAdminPermission(context);
  const limit = hasAdminPerm ? config.adminDailyLimit : config.userDailyLimit;
  
  if (limit > 0) {
    const prosecutorKey = `${group_id}_${user_id}:cyberCourt_prosecutor`;
    const todayCount = dailyCount.get(prosecutorKey, 'cyberCourt');
    log(`用户 ${user_id} 今日升堂次数: ${todayCount}/${limit}`);
    if (todayCount >= limit) {
      const limitText = hasAdminPerm ? `（管理员限制：${limit}次/天）` : `（${limit}次/天）`;
      return global.replyMsg(context, `⚖️ 您今日的升堂次数已用完${limitText} 📵`);
    }
  }
  
  // 检查被告今日被起诉次数，判断是否为复审
  const defendantKey = getDefendantDailyKey(group_id, defendantId);
  const defendantCount = dailyCount.get(defendantKey, 'cyberCourt');
  const isRetrial = defendantCount > 0;
  
  // 创建审判会话
  const duration = config.voteWindowMinutes * 60 * 1000;
  const prosecutorNickname = context.sender?.card || context.sender?.nickname || String(user_id);
  const now = Date.now();
  const session = {
    groupId: group_id,
    active: true,
    startTime: now,
    duration,
    timeout: setTimeout(() => endCourt(group_id, '窗口期结束'), duration),
    defendant: {
      userId: defendantId,
      nickname: defendantNickname,
      originalMsgId: Number(rMsgId),
      originalMsg: getRawMessage(originalMsg) || ''
    },
    prosecutor: {
      userId: user_id,
      nickname: prosecutorNickname
    },
    courtReason,
    votes: {},
    lastVoteTime: now,
    isRetrial,
    defendantCount: defendantCount + 1,
    lastGroupMsgTime: now,
    lastReminderMsgTime: now,
    nextScheduledReminderTime: now + (config.reminderIntervalMinutes || 2) * 60 * 1000
  };
  
  courtSessions.set(group_id, session);
  
  log(`群 ${group_id} 创建审判会话成功，窗口期 ${config.voteWindowMinutes} 分钟，复审: ${isRetrial}`);
  
  // 扣除次数
  dailyCount.add(defendantKey, 'cyberCourt');
  if (limit > 0) {
    const prosecutorKey = `${group_id}_${user_id}:cyberCourt_prosecutor`;
    dailyCount.add(prosecutorKey, 'cyberCourt');
    log(`用户 ${user_id} 扣除一次升堂次数`);
  }
  
  // 发送升堂公告（不引用原告消息，因为是开庭公告）
  const announcement = formatAnnouncement(session, config);
  await global.sendGroupMsg(group_id, announcement);
  
  // 启动投票催促检查（每30秒检查一次）
  const reminderCheck = setInterval(async () => {
    const currentSession = courtSessions.get(group_id);
    if (!currentSession || !currentSession.active) {
      clearInterval(reminderCheck);
      return;
    }
    
    const now = Date.now();
    const endTime = currentSession.startTime + currentSession.duration;
    const remainingTime = endTime - now;
    
    // 计算倒计时
    const countdown = formatCountdown(remainingTime);
    
    const timeSinceLastVote = now - currentSession.lastVoteTime;
    const reminderInterval = (config.reminderIntervalMinutes || 2) * 60 * 1000;
    
    // 判断是否应该发送播报
    const { shouldSend, reason, isLastReminder } = shouldSendReminder(currentSession, config);
    
    // 仅当已到达播报时间且满足条件时才发送
    if (shouldSend && timeSinceLastVote >= reminderInterval) {
      const { favor, against, total } = countVotes(currentSession);
      
      // 检查是否接近快速通过阈值（仅非复审）
      const needOneMore = !currentSession.isRetrial && 
                          total === config.quickPassCount - 1 && 
                          favor > against;
      
      // 生成AI催促文案
      const aiReminder = await generateReminderText(currentSession, favor, against, total, config);
      
      // 获取案由信息
      const msgStr = extractMessageText(currentSession.defendant.originalMsg);
      const cleanedMsg = CQ.cleanForDisplay(msgStr);
      const caseInfo = cleanedMsg.length > 40
        ? cleanedMsg.slice(0, 40) + '...'
        : cleanedMsg;
      
      let reminderMsg = `⚖️ 投票进度播报 ⚖️ ⏱️ ${countdown}\n\n`;
      reminderMsg += `👨‍⚖️ 被告：${currentSession.defendant.nickname}\n`;
      reminderMsg += `📜 案由：${caseInfo}\n`;
      
      if (currentSession.courtReason) {
        const reasonPreview = currentSession.courtReason.length > 30
          ? currentSession.courtReason.slice(0, 30) + '...'
          : currentSession.courtReason;
        reminderMsg += `📝 诉状：${reasonPreview}\n`;
      }
      
      reminderMsg += `\n📊 当前票数：✅ 赞成 ${favor} | ❌ 反对 ${against}`;
      
      // 只在非复审时显示快速通过进度
      if (!currentSession.isRetrial) {
        reminderMsg += `\n⚡ 快速通过进度：${total}/${config.quickPassCount} 票`;
        
        // 如果只差最后一票，显示关键提示
        if (needOneMore) {
          reminderMsg += `\n🎯 关键时刻：只差最后1票就能快速通过！`;
        }
      }
      
      if (isLastReminder) {
        reminderMsg += `\n\n🔴 最后1分钟！请尽快投票！`;
      }
      
      reminderMsg += `\n\n💬 ${aiReminder}`;
      
      await global.sendGroupMsg(group_id, reminderMsg);
      
      // 更新最后催促时间
      currentSession.lastReminderMsgTime = now;
      
      log(`群 ${group_id} 发送投票催促 (${reason})`);
    }
  }, 30000); // 每30秒检查一次
  
  // 在session中保存interval以便清理
  session.reminderInterval = reminderCheck;
}

/**
 * 处理投票
 */
async function handleVote(context, choice) {
  const config = getGroupConfig(context.group_id);
  const { group_id, user_id, message } = context;
  const session = courtSessions.get(group_id);
  
  if (!session || !session.active) {
    return;
  }
  
  const voteType = choice === 1 ? '赞成' : '反对';
  log(`用户 ${user_id} 在群 ${group_id} 投票: ${voteType}`);
  
  // 原告和被告都不能投票
  if (user_id === session.defendant.userId) {
    log(`被告 ${user_id} 尝试投票`);
    return global.replyMsg(context, '⚖️ 被告不能投票！', false, true);
  }
  if (user_id === session.prosecutor.userId) {
    log(`原告 ${user_id} 尝试投票`);
    return global.replyMsg(context, '⚖️ 原告不能投票！', false, true);
  }
  
  // 检查是否已投票（不允许改票）
  if (session.votes[user_id]) {
    log(`用户 ${user_id} 已投过票`);
    return global.replyMsg(context, '⚖️ 您已经投出过民主的一票了', false, true);
  }
  
  // 提取理由
  const reason = message
    .replace(/^\/(赞成|反对)\s*/, '')
    .trim() || null;
  
  // 记录投票
  session.votes[user_id] = {
    choice,
    reason,
    nickname: context.sender?.card || context.sender?.nickname || String(user_id),
    time: Date.now()
  };
  
  // 更新最后投票时间
  session.lastVoteTime = Date.now();
  
  log(`记录投票: 用户${user_id} ${voteType} 理由: ${reason || '无'}`);
  
  const { favor, against, total } = countVotes(session);
  
  // 检查是否达到快速决议条件（复审不适用）
  // 条件：票数达到阈值，且赞成 > 反对（有罪快速通过）或 反对 > 赞成（无罪快速释放，胜负已分）
  const quickPassReached = !session.isRetrial && total >= config.quickPassCount;
  const verdictClear = favor > against || against > favor;
  if (quickPassReached && verdictClear) {
    const isQuickGuilty = favor > against;
    log(`群 ${group_id} 达到快速决议条件: ${total}>=${config.quickPassCount} 赞成${favor} 反对${against}, 有罪: ${isQuickGuilty}`);
    
    if (session.timeout) clearTimeout(session.timeout);
    
    const resultMsg = await endCourt(group_id, '票数已达阈值，当庭宣判！', true, context);
    if (resultMsg) {
      const keyVotePhrase = getKeyVotePhrase();
      const fullMsg = `${keyVotePhrase}\n⏰ 当前票数：${total}/${config.quickPassCount}\n\n${resultMsg}`;
      global.replyMsg(context, fullMsg, false, true);
    }
    return;
  }
  
  // 发送投票反馈
  const reportMsg = formatVoteFeedback(session);
  global.replyMsg(context, reportMsg, false, true);
}

/**
 * 处理提前结束（/宣判）
 */
async function handleEndNow(context) {
  const { group_id, user_id } = context;
  
  log(`用户 ${user_id} 在群 ${group_id} 尝试提前结束审判`);
  
  if (!await hasAdminPermission(context)) {
    log(`用户 ${user_id} 无管理权限`);
    return global.replyMsg(context, '⚖️ 只有管理员可以宣判 🔨');
  }
  
  // 检查是否有进行中的审判
  const session = courtSessions.get(group_id);
  if (session && session.active) {
    // 复审直接按投票结果执行判决
    if (session.isRetrial) {
      const { favor, against, total } = countVotes(session);
      const isGuilty = total > 0 && favor > against;
      
      // 清理会话
      session.active = false;
      if (session.timeout) clearTimeout(session.timeout);
      if (session.reminderInterval) clearInterval(session.reminderInterval);
      courtSessions.delete(group_id);
      
      const config = getGroupConfig(group_id);
      
      if (isGuilty) {
        // 检查被告是否为管理员或群主
        const defendantRole = await getGroupMemberRole(group_id, session.defendant.userId);
        if (defendantRole === 'owner' || defendantRole === 'admin') {
          // 生成AI法官小结
          const aiSummary = await generateJudgeSummary(session, true, '🔨 管理员宣判');
          const specialMsg = getAdminMuteFailMessage(defendantRole, session.defendant.nickname, config.muteTimeMinutes);
          
          let msg = `⚖️ 复审宣判 ⚖️\n\n`;
          msg += `👨‍⚖️ 被告：${session.defendant.nickname}\n`;
          msg += `📊 投票结果：赞成${favor}票，反对${against}票\n\n`;
          msg += specialMsg;
          
          if (aiSummary) {
            msg += aiSummary;
          }
          
          global.replyMsg(context, msg, false, true);
          log(`复审宣判: 被告 ${session.defendant.userId} 是${defendantRole}，无法执行禁言`);
        } else {
          // 执行禁言
          try {
            const durationSeconds = Math.max(60, config.muteTimeMinutes * 60);
            await global.bot('set_group_ban', {
              group_id,
              user_id: session.defendant.userId,
              duration: durationSeconds
            });
            
            // 生成AI法官小结
            const aiSummary = await generateJudgeSummary(session, true, '🔨 管理员宣判');
            
            let msg = `⚖️ 复审宣判 ⚖️\n\n`;
            msg += `👨‍⚖️ 被告：${session.defendant.nickname}\n`;
            msg += `📊 投票结果：赞成${favor}票，反对${against}票\n`;
            msg += `⚔️ 判决：有罪\n`;
            msg += `🔇 禁言${config.muteTimeMinutes}分钟已执行`;
            
            if (aiSummary) {
              msg += aiSummary;
            }
            
            global.replyMsg(context, msg, false, true);
            log(`复审宣判执行成功: 群${group_id} 被告${session.defendant.userId}`);
          } catch (e) {
            logError('复审宣判禁言失败:', e.message);
            global.replyMsg(context, `⚠️ 禁言执行失败：${e.message}`, false, true);
          }
        }
      } else {
        // 无罪释放
        const aiSummary = await generateJudgeSummary(session, false, '🔨 管理员宣判');
        
        let msg = `⚖️ 复审宣判 ⚖️\n\n`;
        msg += `👨‍⚖️ 被告：${session.defendant.nickname}\n`;
        msg += `📊 投票结果：赞成${favor}票，反对${against}票\n`;
        msg += `🛡️ 判决：无罪，予以释放`;
        
        if (aiSummary) {
          msg += aiSummary;
        }
        
        global.replyMsg(context, msg, false, true);
        log(`复审宣判: 群${group_id} 被告${session.defendant.userId} 无罪释放`);
      }
      
      return true;
    }
    
    // 非复审的正常宣判流程
    await endCourt(group_id, '🔨 管理员宣判', false, context);
    return true;
  }
  
  // 检查是否有待裁决的复审（从内存读取）
  const retrial = pendingRetrials.get(group_id);
  
  if (retrial) {
    log(`查询到待裁决复审: groupId=${group_id}, 被告=${retrial.defendantName}`);
    
    // 清理超时定时器
    clearTimeout(retrial.timeoutId);
    pendingRetrials.delete(group_id);
    
    const config = getGroupConfig(group_id);
    const isGuilty = retrial.total > 0 && retrial.favor > retrial.against;
    
    if (isGuilty) {
      // 检查被告是否为管理员或群主
      const defendantRole = await getGroupMemberRole(group_id, retrial.defendantId);
      if (defendantRole === 'owner' || defendantRole === 'admin') {
        const specialMsg = getAdminMuteFailMessage(defendantRole, retrial.defendantName, config.muteTimeMinutes);
        
        global.replyMsg(context, 
          `【复审宣判】⚖️ 管理员已执行宣判\n` +
          `👨‍⚖️ 被告：${retrial.defendantName}\n` +
          `📊 投票结果：赞成${retrial.favor}票，反对${retrial.against}票\n\n` +
          specialMsg, 
          false, true
        );
        
        log(`复审宣判: 被告 ${retrial.defendantId} 是${defendantRole}，无法执行禁言`);
      } else {
        // 执行禁言
        try {
          const durationSeconds = Math.max(60, config.muteTimeMinutes * 60);
          await global.bot('set_group_ban', {
            group_id,
            user_id: retrial.defendantId,
            duration: durationSeconds
          });
          
          global.replyMsg(context, 
            `【复审宣判】⚖️ 管理员已执行宣判\n` +
            `👨‍⚖️ 被告：${retrial.defendantName}\n` +
            `📊 投票结果：赞成${retrial.favor}票，反对${retrial.against}票\n` +
            `⚔️ 判决：有罪\n` +
            `🔇 禁言${config.muteTimeMinutes}分钟已执行`, 
            false, true
          );
          
          log(`复审宣判执行成功: 群${group_id} 被告${retrial.defendantId}`);
        } catch (e) {
          logError('复审宣判禁言失败:', e.message);
          global.replyMsg(context, `⚠️ 禁言执行失败：${e.message}`, false, true);
        }
      }
    } else {
      global.replyMsg(context, 
        `【复审宣判】⚖️ 管理员已执行宣判\n` +
        `👨‍⚖️ 被告：${retrial.defendantName}\n` +
        `📊 投票结果：赞成${retrial.favor}票，反对${retrial.against}票\n` +
        `🛡️ 判决：无罪，予以释放`, 
        false, true
      );
      log(`复审宣判: 群${group_id} 被告${retrial.defendantId} 无罪释放`);
    }
    
    return true;
  }
  
  log(`群 ${group_id} 没有进行中的审判或待裁决的复审`);
  return global.replyMsg(context, '⚖️ 当前没有进行中的审判 ❌');
}

/**
 * 处理撤案(/撤案)
 */
async function handleCancel(context) {
  const { group_id, user_id } = context;
  
  log(`用户 ${user_id} 在群 ${group_id} 尝试撤案`);
  
  // 检查是否有进行中的审判
  const session = courtSessions.get(group_id);
  if (session) {
    // 原告或管理员可以撤案
    const isAdmin = await hasAdminPermission(context);
    if (user_id !== session.prosecutor.userId && !isAdmin) {
      log(`用户 ${user_id} 无权撤案`);
      return global.replyMsg(context, '⚖️ 只有原告或管理员可以撤案 🔨');
    }
    
    // 回退计数器
    const config = getGroupConfig(group_id);
    
    // 回退被告被起诉次数
    const defendantKey = getDefendantDailyKey(group_id, session.defendant.userId);
    dailyCount.sub(defendantKey, 'cyberCourt');
    log(`回退被告 ${session.defendant.userId} 被起诉次数`);
    
    // 回退原告升堂次数（如果有限制）
    const prosecutorIsAdmin = await isGroupAdmin(group_id, session.prosecutor.userId);
    const limit = prosecutorIsAdmin ? config.adminDailyLimit : config.userDailyLimit;
    
    if (limit > 0) {
      const prosecutorKey = `${group_id}_${session.prosecutor.userId}:cyberCourt_prosecutor`;
      dailyCount.sub(prosecutorKey, 'cyberCourt');
      log(`回退原告 ${session.prosecutor.userId} 升堂次数`);
    }
    
    session.active = false;
    if (session.timeout) clearTimeout(session.timeout);
    if (session.reminderInterval) clearInterval(session.reminderInterval);
    courtSessions.delete(group_id);
    
    const cancellerName = context.sender?.card || context.sender?.nickname || String(user_id);
    
    log(`群 ${group_id} 的审判已被撤销`);
    return global.replyMsg(context, `⚖️ 本次对 ${session.defendant.nickname} 的审判已被 ${cancellerName} 撤销 ❌`);
  }
  
  // 检查是否有待裁决的复审（从内存读取）
  const retrial = pendingRetrials.get(group_id);
  if (retrial) {
    const isAdmin = await hasAdminPermission(context);
    if (!isAdmin) {
      log(`用户 ${user_id} 无权撤销复审`);
      return global.replyMsg(context, '⚖️ 只有管理员可以撤销复审 🔨');
    }
    
    // 清理超时定时器和内存状态
    clearTimeout(retrial.timeoutId);
    pendingRetrials.delete(group_id);
    
    const cancellerName = context.sender?.card || context.sender?.nickname || String(user_id);
    log(`群 ${group_id} 的复审已被撤销`);
    return global.replyMsg(context, 
      `⚖️ 复审撤销 ⚖️\n管理员 ${cancellerName} 撤销了对 ${retrial.defendantName} 的复审\n` +
      `🛡️ 被告已释放`
    );
  }
  
  log(`群 ${group_id} 没有进行中的审判或待裁决的复审`);
  return global.replyMsg(context, '⚖️ 当前没有进行中的审判 ❌');
}

// ==================== 插件主入口 ====================

export default async function cyberCourt(context) {
  const config = getConfig();
  
  if (!config.enable) return false;
  
  if (context.message_type !== 'group') return false;
  
  const { message, group_id } = context;
  
  // 记录群内最后消息时间，用于智能播报判断
  const currentSession = courtSessions.get(group_id);
  if (currentSession && currentSession.active) {
    currentSession.lastGroupMsgTime = Date.now();
  }
  
  const groupConfig = getGroupConfig(group_id);
  
  // 检查黑白名单
  if (groupConfig.blackGroup?.includes?.(group_id)) {
    return false;
  }
  if (groupConfig.whiteGroup?.length > 0) {
    const inWhiteList = groupConfig.whiteGroup.some(g => 
      (typeof g === 'number' && g === group_id) || 
      (typeof g === 'object' && g.group === group_id)
    );
    if (!inWhiteList) return false;
  }
  
  // 去除回复标记和自动@后的纯消息
  const pureMsg = CQ.removeTypes(message, ['reply', 'at']);
  
  // 发起升堂（需要回复消息）- 必须以/开头
  if (pureMsg === '/升堂' || pureMsg.startsWith('/升堂 ')) {
    await handleStartCourt(context);
    return true;
  }
  
  // 投票 - 必须以/开头
  if (/^\/赞成/.test(pureMsg)) {
    await handleVote(context, 1);
    return true;
  }
  if (/^\/反对/.test(pureMsg)) {
    await handleVote(context, -1);
    return true;
  }
  
  // 管理员命令 - 必须以/开头
  if (pureMsg === '/宣判' || pureMsg === '/结案') {
    await handleEndNow(context);
    return true;
  }
  if (pureMsg === '/撤案') {
    await handleCancel(context);
    return true;
  }
  
  return false;
}
