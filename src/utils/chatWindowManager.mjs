/**
 * 聊天窗口管理器
 * 管理群聊中AI角色的会话窗口生命周期
 */

// 开发阶段日志（始终输出）
const log = (...args) => {
  console.log('[ChatWindow]', ...args);
};

class ChatWindowManager {
  constructor() {
    /** @type {Map<number, WindowData>} 群号 -> 窗口数据 */
    this.windows = new Map();
    
    /** @type {Function|null} 发送群消息的回调函数 */
    this.sendGroupMsgCallback = null;
  }

  /**
   * 设置发送群消息的回调（在bot初始化后调用）
   * @param {Function} callback 
   */
  setSendGroupMsgCallback(callback) {
    this.sendGroupMsgCallback = callback;
    console.log('[ChatWindow] 发送消息回调已设置');
  }

  /**
   * 创建或更新聊天窗口
   * @param {number} groupId - 群号
   * @param {string} characterName - 角色名称（如"xp医生"）
   * @param {object} config - AI配置
   * @param {number} duration - 持续时间（毫秒，默认15分钟）
   * @returns {boolean} 是否创建成功
   */
  createWindow(groupId, characterName, config, duration = 15 * 60 * 1000) {
    // 如果窗口已存在，清除旧的计时器
    if (this.windows.has(groupId)) {
      const oldWindow = this.windows.get(groupId);
      clearTimeout(oldWindow.timeout);
      console.log(`[ChatWindow] 群 ${groupId} 已有窗口，重置计时器`);
    }

    const timeoutId = setTimeout(() => {
      this._handleWindowTimeout(groupId);
    }, duration);

    this.windows.set(groupId, {
      active: true,
      characterName,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      timeout: timeoutId,
      duration,
      config,
    });

    console.log(`[ChatWindow] ✅ 群 ${groupId} 开启了 "${characterName}" 会话窗口，持续 ${duration / 60000} 分钟`);
    return true;
  }

  /**
   * 检查窗口是否激活
   * @param {number} groupId 
   * @returns {boolean}
   */
  isActive(groupId) {
    return this.windows.has(groupId) && this.windows.get(groupId).active;
  }

  /**
   * 获取窗口的角色名称
   * @param {number} groupId 
   * @returns {string|null}
   */
  getCharacterName(groupId) {
    if (!this.isActive(groupId)) return null;
    return this.windows.get(groupId).characterName;
  }

  /**
   * 获取窗口配置
   * @param {number} groupId 
   * @returns {object|null}
   */
  getConfig(groupId) {
    if (!this.isActive(groupId)) return null;
    return this.windows.get(groupId).config;
  }

  /**
   * 获取窗口剩余时间（毫秒）
   * @param {number} groupId 
   * @returns {number}
   */
  getRemainingTime(groupId) {
    if (!this.isActive(groupId)) return 0;
    const windowData = this.windows.get(groupId);
    const elapsed = Date.now() - windowData.lastActivityTime;
    return Math.max(0, windowData.duration - elapsed);
  }

  /**
   * 消息到达时刷新计时器
   * @param {number} groupId 
   * @param {number} duration - 刷新后的持续时间（毫秒）
   * @returns {boolean}
   */
  refreshWindow(groupId, duration = null) {
    if (!this.isActive(groupId)) {
      log(`群 ${groupId} 窗口未激活，无法刷新`);
      return false;
    }

    const windowData = this.windows.get(groupId);
    windowData.lastActivityTime = Date.now();

    // 使用传入的duration或窗口原有的duration
    const newDuration = duration || windowData.duration;

    // 清除旧计时器，创建新计时器
    clearTimeout(windowData.timeout);
    windowData.timeout = setTimeout(() => {
      this._handleWindowTimeout(groupId);
    }, newDuration);

    log(`群 ${groupId} 窗口计时器已刷新，剩余 ${(newDuration / 60000).toFixed(1)} 分钟`);
    return true;
  }

  /**
   * 手动关闭窗口
   * @param {number} groupId 
   * @param {boolean} sendNotification - 是否发送关闭通知
   * @returns {object|false}
   */
  closeWindow(groupId, sendNotification = false) {
    log(`尝试关闭群 ${groupId} 窗口, sendNotification=${sendNotification}`);
    
    if (!this.windows.has(groupId)) {
      log(`群 ${groupId} 无活跃窗口，无需关闭`);
      return false;
    }

    const windowData = this.windows.get(groupId);
    clearTimeout(windowData.timeout);

    const result = {
      success: true,
      isTimeout: false,
      characterName: windowData.characterName,
      duration: Date.now() - windowData.startTime,
    };

    this.windows.delete(groupId);

    console.log(`[ChatWindow] ✅ 群 ${groupId} 的 ${result.characterName} 会话窗口已手动关闭`);
    log(`关闭详情: 持续时间=${(result.duration / 60000).toFixed(1)}分钟`);

    if (sendNotification && this.sendGroupMsgCallback) {
      const durationMin = (result.duration / 1000 / 60).toFixed(1);
      log(`发送关闭通知到群 ${groupId}`);
      this.sendGroupMsgCallback(
        groupId,
        `${result.characterName}会诊结束，本次会诊共进行了${durationMin}分钟。期待下次为您服务！`
      );
    }

    return result;
  }

  /**
   * 窗口超时处理（内部方法）
   * @private
   * @param {number} groupId 
   */
  _handleWindowTimeout(groupId) {
    log(`处理群 ${groupId} 窗口超时`);
    
    if (!this.windows.has(groupId)) {
      log(`群 ${groupId} 超时回调触发时窗口已不存在`);
      return;
    }

    const windowData = this.windows.get(groupId);
    const characterName = windowData.characterName;
    const duration = Date.now() - windowData.startTime;

    this.windows.delete(groupId);

    console.log(`[ChatWindow] ⏰ 群 ${groupId} 的 ${characterName} 会话窗口已超时关闭 (持续 ${(duration / 60000).toFixed(1)} 分钟)`);

    // 发送超时通知
    if (this.sendGroupMsgCallback) {
      const durationMin = (duration / 1000 / 60).toFixed(1);
      const config = global.config?.bot?.characterglm?.chatWindow;
      const closeMsg = config?.replyOnClose || `${characterName}会诊结束，本次会诊共进行了${durationMin}分钟。期待下次为您服务！`;
      const finalMsg = closeMsg.replace('{name}', characterName).replace('{duration}', durationMin);
      log(`发送超时通知: "${finalMsg}"`);
      this.sendGroupMsgCallback(groupId, finalMsg);
    } else {
      log(`警告: sendGroupMsgCallback 未设置，无法发送超时通知`);
    }
  }

  /**
   * 获取窗口详细信息（调试用）
   * @param {number} groupId 
   * @returns {object|null}
   */
  getWindowInfo(groupId) {
    if (!this.windows.has(groupId)) return null;
    const w = this.windows.get(groupId);
    return {
      active: w.active,
      characterName: w.characterName,
      startTime: w.startTime,
      lastActivityTime: w.lastActivityTime,
      duration: w.duration,
      remainingTime: this.getRemainingTime(groupId),
    };
  }

  /**
   * 获取所有活跃窗口（调试用）
   * @returns {Array}
   */
  getAllActiveWindows() {
    const result = [];
    for (const [groupId, windowData] of this.windows) {
      if (windowData.active) {
        result.push({
          groupId,
          ...this.getWindowInfo(groupId),
        });
      }
    }
    return result;
  }
}

export default new ChatWindowManager();

/**
 * @typedef {Object} WindowData
 * @property {boolean} active - 窗口是否激活
 * @property {string} characterName - 角色名称
 * @property {number} startTime - 窗口创建时间戳
 * @property {number} lastActivityTime - 最后活动时间戳
 * @property {NodeJS.Timeout} timeout - 超时计时器ID
 * @property {number} duration - 窗口持续时间
 * @property {object} config - AI配置
 */
