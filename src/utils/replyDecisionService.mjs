/**
 * 智能回复判断服务
 * 
 * 使用免费模型判断AI是否应该主动回复群聊消息
 * 配合防抖机制（可随机化），在窗口模式下自动判断是否需要介入对话
 */

import { createJWT } from '../plugin/AImodule/auth.mjs';
import AxiosProxy from './axiosProxy.mjs';

// 开发阶段日志
const log = (...args) => {
  console.log('[ReplyDecision]', ...args);
};

/**
 * 获取默认的免费模型配置
 */
function getDefaultFreeModel() {
  return {
    model: 'GLM-4-Flash-250414',  // 免费模型
    api: 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  };
}

/**
 * 智能回复判断服务类
 */
class ReplyDecisionService {
  constructor() {
    /** @type {Map<number, NodeJS.Timeout>} 群号 -> 防抖定时器 */
    this.debounceTimers = new Map();
    
    /** @type {Map<number, Array>} 群号 -> 待判断的消息缓冲 */
    this.messageBuffer = new Map();
    
    /** @type {number} 防抖延迟时间基数（毫秒） */
    this.debounceDelay = 3000;
    
    /** @type {boolean} 是否使用随机延迟（true则在基数±20%范围内随机） */
    this.useRandomDelay = true;
    
    /** @type {object} 免费模型配置 */
    this.freeModel = getDefaultFreeModel();
    
    /** @type {Map<number, Function>} 群号 -> 判断完成回调 */
    this.pendingCallbacks = new Map();
    
    /** @type {Map<number, Array>} 群号 -> 最近回复时间戳记录（用于降低阈值） */
    this.recentReplies = new Map();
    
    /** @type {number} 时间窗口（毫秒），统计此范围内的回复次数 */
    this.replyTimeWindow = 300000;  // 5分钟
    
    /** @type {number} 连续回复次数阈值，超过此值自动降低confidence阈值 */
    this.frequentReplyThreshold = 3;
  }

  /**
   * 配置免费模型
   * @param {object} modelConfig - { model, api }
   */
  configureModel(modelConfig) {
    if (modelConfig?.model) {
      this.freeModel = modelConfig;
      log(`免费模型已配置: ${modelConfig.model}`);
    }
  }

  /**
   * 配置防抖延迟
   * @param {number} delayMs - 延迟毫秒数
   * @param {boolean} useRandom - 是否使用随机延迟（默认true，在基数±20%范围内随机）
   */
  configureDebounce(delayMs = 3000, useRandom = true) {
    this.debounceDelay = delayMs;
    this.useRandomDelay = useRandom;
    log(`防抖延迟已配置: ${delayMs}ms, useRandom=${useRandom}`);
  }

  /**
   * 构建判断提示词（轻量化版本，仅用于判断是否需要回复）
   * @param {string} latestMessage - 最新消息（只需要最新消息即可判断）
   * @param {object} commandConfig - 角色命令配置
   * @returns {string}
   */
  _buildJudgePrompt(latestMessage, commandConfig) {
    const botName = commandConfig?.meta?.bot_name || 'X.P.咨询师';

    return `判断是否需要回复。简短判断即可。

角色：${botName}

最新消息：${latestMessage}

判断是否需要主动回复：
- true：直接@提及、求助、情绪困扰、寻求建议
- false：闲聊、灌水、无关话题、分享内容

只输出JSON：{"reply":true/false,"reason":"原因","confidence":0.0-1.0}`;
  }

  /**
   * 调用免费模型进行判断
   * @param {string} latestMessage - 最新消息（只需要最新消息）
   * @param {object} commandConfig - 角色配置
   * @param {string} apiKey - API Key
   * @param {number} groupId - 群号（用于查询最近回复频率）
   * @returns {Promise<{reply: boolean, reason: string, confidence: number}>}
   */
  async _callJudgeModel(latestMessage, commandConfig, apiKey, groupId) {
    const prompt = this._buildJudgePrompt(latestMessage, commandConfig);
    
    const requestBody = {
      model: this.freeModel.model,
      messages: [
        { role: 'user', content: prompt }
      ],
      stream: false,
      temperature: 0.1,  // 低温度保证确定性
      max_tokens: 150,   // 简化了，需要的token更少
      response_format: { type: 'json_object' }
    };

    try {
      log(`发送判断请求 [${this.freeModel.model}]，消息: "${latestMessage.substring(0, 40)}..."`);
      log(`[${this.freeModel.model}] messages:`);
      console.log(requestBody.messages);
      
      const jwtToken = createJWT(apiKey);
      
      const { data } = await AxiosProxy.post(this.freeModel.api, requestBody, {
        headers: {
          Authorization: jwtToken,
          'Content-Type': 'application/json'
        },
        validateStatus: status => 200 <= status && status < 500,
        timeout: 10000  // 10秒超时
      });

      if (data.error) {
        log(`[${this.freeModel.model}] 判断API错误: ${data.error.message}`);
        return { reply: false, reason: 'API错误', confidence: 0 };
      }

      if (data.choices && data.choices[0]?.message?.content) {
        const content = data.choices[0].message.content.trim();
        log(`[${this.freeModel.model}] 响应 content: ${content}`);
        
        try {
          const result = JSON.parse(content);
          const baseResult = {
            reply: result.reply === true,
            reason: result.reason || '未知',
            confidence: typeof result.confidence === 'number' ? result.confidence : 0.5
          };
          
          // 检查最近回复频率，如果短时间内回复过多，降低阈值
          const adjustedConfidence = this._getAdjustedConfidence(groupId, baseResult.confidence);
          baseResult.confidence = adjustedConfidence;
          
          log(`[${this.freeModel.model}] 解析结果: reply=${baseResult.reply}, reason="${baseResult.reason}", confidence=${baseResult.confidence}`);
          return baseResult;
        } catch (parseError) {
          log(`[${this.freeModel.model}] 解析JSON失败: ${parseError.message}`);
          // 尝试从文本中提取关键信息
          const hasReplyTrue = content.includes('"reply": true') || content.includes('"reply":true');
          return {
            reply: hasReplyTrue,
            reason: '解析失败，根据文本推断',
            confidence: 0.3
          };
        }
      }

      log(`[${this.freeModel.model}] 无响应内容`);
      return { reply: false, reason: '无响应', confidence: 0 };
      
    } catch (error) {
      log(`判断请求异常: ${error.message}`);
      return { reply: false, reason: '请求异常', confidence: 0 };
    }
  }

  /**
   * 获取调整后的置信度（根据最近回复频率）
   * @param {number} groupId - 群号
   * @param {number} originalConfidence - 原始置信度
   * @returns {number} 调整后的置信度
   */
  _getAdjustedConfidence(groupId, originalConfidence) {
    const now = Date.now();
    
    // 清理过期的回复记录
    if (!this.recentReplies.has(groupId)) {
      this.recentReplies.set(groupId, []);
    }
    
    const replies = this.recentReplies.get(groupId);
    const validReplies = replies.filter(timestamp => now - timestamp < this.replyTimeWindow);
    this.recentReplies.set(groupId, validReplies);
    
    // 如果短时间内回复次数过多，降低阈值
    if (validReplies.length >= this.frequentReplyThreshold) {
      log(`群${groupId}最近回复${validReplies.length}次，降低置信度阈值`);
      return Math.max(0.7, originalConfidence * 0.8);  // 至少降低20%，但不低于0.7
    }
    
    return originalConfidence;
  }

  /**
   * 记录一次成功的回复
   * @param {number} groupId - 群号
   */
  recordReply(groupId) {
    if (!this.recentReplies.has(groupId)) {
      this.recentReplies.set(groupId, []);
    }
    this.recentReplies.get(groupId).push(Date.now());
  }

  /**
   * 添加消息到缓冲区并触发防抖判断
   * @param {number} groupId - 群号
   * @param {string} message - 消息内容
   * @param {string} nickname - 发送者昵称
   * @param {object} commandConfig - 角色命令配置
   * @param {string} apiKey - API Key
   * @param {Function} getContextSummary - 获取上下文摘要的函数
   * @param {Function} onDecision - 判断完成回调 (result) => void
   */
  triggerDebounceJudge(groupId, message, nickname, commandConfig, apiKey, getContextSummary, onDecision) {
    // 初始化消息缓冲
    if (!this.messageBuffer.has(groupId)) {
      this.messageBuffer.set(groupId, []);
    }
    
    // 添加新消息到缓冲
    const buffer = this.messageBuffer.get(groupId);
    buffer.push({ message, nickname, timestamp: Date.now() });
    
    // 保持缓冲区大小合理（最多5条）
    while (buffer.length > 5) {
      buffer.shift();
    }
    
    // 从配置读取防抖配置
    const configDelay = commandConfig?.smartReply?.debounceDelay;
    const configUseRandom = commandConfig?.smartReply?.useRandomDelay;
    
    // 如果配置了延迟，临时使用配置的延迟
    const baseDelay = configDelay !== undefined ? configDelay : this.debounceDelay;
    const useRandom = configUseRandom !== undefined ? configUseRandom : this.useRandomDelay;
    
    // 计算实际延迟
    let debounceDelay = baseDelay;
    if (useRandom) {
      const variance = baseDelay * 0.2;
      const min = baseDelay - variance;
      const max = baseDelay + variance;
      debounceDelay = Math.floor(Math.random() * (max - min) + min);
    }
    
    log(`群 ${groupId} 消息入缓冲，当前 ${buffer.length} 条，启动 ${debounceDelay}ms 防抖 (随机=${useRandom})`);

    // 保存回调（覆盖旧的）
    this.pendingCallbacks.set(groupId, onDecision);

    // 清除旧的定时器
    if (this.debounceTimers.has(groupId)) {
      clearTimeout(this.debounceTimers.get(groupId));
    }

    // 设置新的防抖定时器
    const timer = setTimeout(async () => {
      log(`群 ${groupId} 防抖结束，开始判断`);
      
      // 获取缓冲区中的最新消息
      const currentBuffer = this.messageBuffer.get(groupId) || [];
      if (currentBuffer.length === 0) {
        log(`群 ${groupId} 缓冲区为空，跳过判断`);
        return;
      }

      // 构建最新消息（取缓冲区最后一条）
      const lastMsg = currentBuffer[currentBuffer.length - 1];
      const latestMessage = `${lastMsg.nickname}: ${lastMsg.message}`;
      
      // 调用模型判断（只需要最新消息，不需要完整上下文）
      const result = await this._callJudgeModel(
        latestMessage,
        commandConfig,
        apiKey,
        groupId
      );

      log(`群 ${groupId} 判断结果: reply=${result.reply}, reason="${result.reason}", confidence=${result.confidence}`);

      // 清理
      this.debounceTimers.delete(groupId);
      this.messageBuffer.delete(groupId);

      // 调用回调
      const callback = this.pendingCallbacks.get(groupId);
      if (callback) {
        this.pendingCallbacks.delete(groupId);
        callback(result);
      }
      
    }, debounceDelay);

    this.debounceTimers.set(groupId, timer);
  }

  /**
   * 取消群的待判断任务
   * @param {number} groupId 
   */
  cancelPendingJudge(groupId) {
    if (this.debounceTimers.has(groupId)) {
      clearTimeout(this.debounceTimers.get(groupId));
      this.debounceTimers.delete(groupId);
      log(`群 ${groupId} 取消待判断任务`);
    }
    this.messageBuffer.delete(groupId);
    this.pendingCallbacks.delete(groupId);
  }

  /**
   * 设置防抖延迟时间
   * @param {number} delay - 毫秒
   */
  setDebounceDelay(delay) {
    this.debounceDelay = delay;
    log(`防抖延迟设置为 ${delay}ms`);
  }

  /**
   * 检查群是否有待判断任务
   * @param {number} groupId 
   * @returns {boolean}
   */
  hasPendingJudge(groupId) {
    return this.debounceTimers.has(groupId);
  }

  /**
   * 获取消息缓冲区大小
   * @param {number} groupId 
   * @returns {number}
   */
  getBufferSize(groupId) {
    return this.messageBuffer.get(groupId)?.length || 0;
  }
}

// 导出单例
export default new ReplyDecisionService();
