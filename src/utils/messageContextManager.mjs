/**
 * 消息上下文管理器（智能总结器方案）
 * 在聊天窗口激活期间，收集群聊消息并提供上下文
 * 
 * 新增功能：支持智能回复判断触发
 */

import replyDecisionService from './replyDecisionService.mjs';

// 开发阶段日志（始终输出）
const log = (...args) => {
  console.log('[MessageContext]', ...args);
};

class MessageContextManager {
  constructor() {
    /** @type {Map<number, GroupContext>} 群号 -> 上下文数据 */
    this.groupContexts = new Map();

    /** @type {number} 每个群最多缓存的消息数 */
    this.maxCacheSize = 15;

    /** @type {number} 提供给AI的最大上下文消息数 */
    this.maxContextMessages = 8;

    /** @type {Map<number, SmartReplyConfig>} 群号 -> 智能回复配置 */
    this.smartReplyConfigs = new Map();
  }

  /**
   * 初始化群聊窗口的上下文
   * @param {number} groupId 
   * @param {object} smartReplyConfig - 智能回复配置（可选）
   */
  initializeContext(groupId, smartReplyConfig = null) {
    this.groupContexts.set(groupId, {
      messages: [],
      summary: null,
      lastUpdateTime: Date.now(),
    });
    
    // 如果提供了智能回复配置，保存它
    if (smartReplyConfig) {
      this.smartReplyConfigs.set(groupId, smartReplyConfig);
      log(`群 ${groupId} 启用智能回复判断`);
    }
    
    console.log(`[MessageContext] ✅ 群 ${groupId} 上下文已初始化`);
  }

  /**
   * 配置智能回复
   * @param {number} groupId 
   * @param {object} config - { enable, commandConfig, apiKey, onAutoReply }
   */
  configureSmartReply(groupId, config) {
    this.smartReplyConfigs.set(groupId, config);
    log(`群 ${groupId} 智能回复配置已更新: enable=${config.enable}`);
  }

  /**
   * 添加群聊消息到上下文缓存
   * @param {number} groupId - 群号
   * @param {string} message - 原始消息内容
   * @param {number|string} userId - 用户ID
   * @param {string} nickname - 用户昵称
   * @param {boolean} triggerSmartReply - 是否触发智能回复判断（默认true）
   * @returns {{added: boolean, cleanContent: string}} 是否成功添加和清理后的内容
   */
  addMessage(groupId, message, userId, nickname, triggerSmartReply = true) {
    if (!this.groupContexts.has(groupId)) {
      log(`群 ${groupId} 未初始化上下文，自动初始化`);
      this.initializeContext(groupId);
    }

    const ctx = this.groupContexts.get(groupId);
    
    // 清理CQ码，只保留纯文本
    const cleanContent = this._cleanMessage(message);
    
    // 过滤空消息和纯图片消息
    if (!cleanContent || cleanContent.length === 0) {
      log(`群 ${groupId} 消息为空或纯非文本内容，已跳过`);
      return { added: false, cleanContent: '' };
    }

    ctx.messages.push({
      userId,
      nickname: nickname || `用户${userId}`,
      content: cleanContent,
      timestamp: Date.now(),
    });

    log(`群 ${groupId} 添加消息: [${nickname}] ${cleanContent.substring(0, 50)}${cleanContent.length > 50 ? '...' : ''}`);

    // 保持消息数量在限制内
    if (ctx.messages.length > this.maxCacheSize) {
      ctx.messages.shift();
      log(`群 ${groupId} 消息数超限，移除最早消息，当前 ${ctx.messages.length} 条`);
    }

    ctx.lastUpdateTime = Date.now();
    
    // 每新增若干条消息自动更新总结
    if (ctx.messages.length % 5 === 0) {
      this._updateSummary(groupId);
    }

    // 触发智能回复判断（如果配置启用）
    if (triggerSmartReply) {
      this._triggerSmartReplyIfEnabled(groupId, cleanContent, nickname);
    }

    return { added: true, cleanContent };
  }

  /**
   * 获取供AI使用的上下文消息（emohaa格式）
   * @param {number} groupId 
   * @param {number|string} excludeUserId - 排除的用户ID（通常是提问者）
   * @returns {Array<{role: string, content: string}>}
   */
  getContextMessages(groupId, excludeUserId = null) {
    if (!this.groupContexts.has(groupId)) {
      log(`群 ${groupId} 获取上下文：无上下文数据`);
      return [];
    }

    const ctx = this.groupContexts.get(groupId);
    
    // 获取最近的消息，排除指定用户的消息（可选）
    const filteredMessages = ctx.messages
      .filter(msg => msg.content && msg.content.length > 0)
      .slice(-this.maxContextMessages);

    if (filteredMessages.length === 0) {
      log(`群 ${groupId} 获取上下文：消息列表为空`);
      return [];
    }

    // 构建上下文摘要
    const contextSummary = filteredMessages
      .map(msg => `${msg.nickname}: ${msg.content}`)
      .join('\n');

    log(`群 ${groupId} 获取上下文：${filteredMessages.length} 条消息`);

    return [
      {
        role: 'assistant',
        content: `【当前群聊讨论背景，请结合以下内容理解用户的问题】\n${contextSummary}`
      }
    ];
  }

  /**
   * 获取格式化的上下文摘要（用于调试或展示）
   * @param {number} groupId 
   * @returns {string}
   */
  getContextSummary(groupId) {
    if (!this.groupContexts.has(groupId)) {
      return '暂无上下文';
    }

    const ctx = this.groupContexts.get(groupId);
    if (ctx.messages.length === 0) {
      return '暂无消息记录';
    }

    return ctx.messages
      .slice(-this.maxContextMessages)
      .map(msg => `[${msg.nickname}]: ${msg.content}`)
      .join('\n');
  }

  /**
   * 清空群聊上下文（窗口关闭时调用）
   * @param {number} groupId 
   */
  clearContext(groupId) {
    if (this.groupContexts.has(groupId)) {
      const ctx = this.groupContexts.get(groupId);
      log(`群 ${groupId} 清空上下文，原有 ${ctx.messages.length} 条消息`);
      this.groupContexts.delete(groupId);
      console.log(`[MessageContext] ✅ 群 ${groupId} 上下文已清空`);
    } else {
      log(`群 ${groupId} 清空上下文：无需清空（不存在）`);
    }
    
    // 同时清理智能回复配置和待判断任务
    this.smartReplyConfigs.delete(groupId);
    replyDecisionService.cancelPendingJudge(groupId);
  }

  /**
   * 检查群是否有上下文
   * @param {number} groupId 
   * @returns {boolean}
   */
  hasContext(groupId) {
    const has = this.groupContexts.has(groupId);
    log(`群 ${groupId} 检查上下文存在: ${has}`);
    return has;
  }

  /**
   * 获取上下文消息数量
   * @param {number} groupId 
   * @returns {number}
   */
  getMessageCount(groupId) {
    if (!this.groupContexts.has(groupId)) {
      return 0;
    }
    return this.groupContexts.get(groupId).messages.length;
  }

  /**
   * 触发智能回复判断（如果启用）
   * @private
   * @param {number} groupId 
   * @param {string} cleanContent - 清理后的消息内容
   * @param {string} nickname - 发送者昵称
   */
  _triggerSmartReplyIfEnabled(groupId, cleanContent, nickname) {
    const config = this.smartReplyConfigs.get(groupId);
    if (!config || !config.enable) {
      return;
    }

    log(`群 ${groupId} 触发智能回复判断`);

    // 获取上下文摘要的函数
    const getContextSummary = (gid) => this.getContextSummary(gid);

    // 触发防抖判断
    replyDecisionService.triggerDebounceJudge(
      groupId,
      cleanContent,
      nickname,
      config.commandConfig,
      config.apiKey,
      getContextSummary,
      (result) => {
        // 判断完成后的回调
        if (result.reply && config.onAutoReply) {
          log(`群 ${groupId} 智能判断: 需要回复 (${result.reason})`);
          config.onAutoReply(groupId, result);
        } else {
          log(`群 ${groupId} 智能判断: 不需要回复 (${result.reason})`);
        }
      }
    );
  }

  /**
   * 取消群的智能回复待判断任务
   * @param {number} groupId 
   */
  cancelSmartReplyJudge(groupId) {
    replyDecisionService.cancelPendingJudge(groupId);
    log(`群 ${groupId} 智能回复判断已取消`);
  }

  /**
   * 清理消息内容，将CQ码转换为文本说明
   * @private
   * @param {string} message 
   * @returns {string}
   */
  _cleanMessage(message) {
    if (!message) return '';
    
    // 将各种CQ码转换为文本说明
    let cleaned = message
      // 图片 -> [图片]
      .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      // 表情 -> [表情]
      .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      // @某人 -> [@昵称] 或 [@全体成员]
      .replace(/\[CQ:at,qq=all[^\]]*\]/g, '[@全体成员]')
      .replace(/\[CQ:at[^\]]*\]/g, '[@]')
      // 语音 -> [语音]
      .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
      // 视频 -> [视频]
      .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
      // 回复 -> 移除（已在上下文中）
      .replace(/\[CQ:reply[^\]]*\]/g, '')
      // 分享链接 -> [链接分享]
      .replace(/\[CQ:share[^\]]*\]/g, '[链接分享]')
      // 音乐 -> [音乐分享]
      .replace(/\[CQ:music[^\]]*\]/g, '[音乐分享]')
      // 红包 -> [红包]
      .replace(/\[CQ:redbag[^\]]*\]/g, '[红包]')
      // 戳一戳 -> [戳一戳]
      .replace(/\[CQ:poke[^\]]*\]/g, '[戳一戳]')
      // 合并转发 -> [聊天记录]
      .replace(/\[CQ:forward[^\]]*\]/g, '[聊天记录]')
      // XML/JSON消息 -> [卡片消息]
      .replace(/\[CQ:xml[^\]]*\]/g, '[卡片消息]')
      .replace(/\[CQ:json[^\]]*\]/g, '[卡片消息]')
      // 其他未知CQ码 -> 移除
      .replace(/\[CQ:[^\]]+\]/g, '');
    
    // 移除多余的空白
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned;
  }

  /**
   * 更新上下文摘要（内部方法）
   * @private
   * @param {number} groupId 
   */
  _updateSummary(groupId) {
    if (!this.groupContexts.has(groupId)) {
      return;
    }

    const ctx = this.groupContexts.get(groupId);
    
    // 简单的摘要：列出最近的消息
    ctx.summary = ctx.messages
      .slice(-this.maxContextMessages)
      .map(m => `${m.nickname}: ${m.content}`)
      .join('\n');
  }

  /**
   * 设置配置参数
   * @param {object} options 
   */
  setOptions(options = {}) {
    if (options.maxCacheSize) {
      this.maxCacheSize = options.maxCacheSize;
    }
    if (options.maxContextMessages) {
      this.maxContextMessages = options.maxContextMessages;
    }
  }
}

export default new MessageContextManager();

/**
 * @typedef {Object} GroupContext
 * @property {Array<MessageRecord>} messages - 消息记录列表
 * @property {string|null} summary - 上下文摘要
 * @property {number} lastUpdateTime - 最后更新时间戳
 */

/**
 * @typedef {Object} MessageRecord
 * @property {number|string} userId - 用户ID
 * @property {string} nickname - 用户昵称
 * @property {string} content - 清理后的消息内容
 * @property {number} timestamp - 消息时间戳
 */
