import { setKeyValue, getKeyValue } from './redisClient.mjs';

export class CooldownManager {
  /**
   * 检查冷却状态并返回剩余时间
   * @param {string} cooldownKey Redis键名
   * @param {number} [cooldownHours=0] 冷却时间(小时)
   * @returns {Promise<boolean|number>} 如果不在冷却中返回false，否则返回剩余秒数
   */
  async checkCooldown(cooldownKey, cooldownHours = 0) {
    // 如果没有设置冷却时间，直接返回false表示不在冷却中
    if (cooldownHours <= 0) {
      return false;
    }

    const lastSentTime = await getKeyValue(cooldownKey);
    if (!lastSentTime) {
      return false;
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const elapsedTime = currentTime - parseInt(lastSentTime);
    const cooldownSeconds = cooldownHours * 3600;

    if (elapsedTime < cooldownSeconds) {
      // 计算并返回剩余冷却时间（秒）
      return cooldownSeconds - elapsedTime;
    }

    return false;
  }

  /**
   * 检查并处理冷却状态
   * @param {string} cooldownKey Redis键名
   * @param {object} options 冷却配置选项
   * @param {number} [options.cooldownHours=0] 冷却时间(小时)
   * @param {number} [options.cooldownReduction=0] 冷却时间减少量(分钟)
   * @returns {Promise<boolean>} 是否在冷却中
   */
  async handleCooldown(cooldownKey, { cooldownHours = 0, cooldownReduction = 0 } = {}) {
    // 如果没有设置冷却时间，直接返回false表示不在冷却中
    if (cooldownHours <= 0) {
      return false;
    }

    const lastSentTime = await getKeyValue(cooldownKey);
    if (!lastSentTime) {
      return false;
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const elapsedTime = currentTime - parseInt(lastSentTime);
    const cooldownSeconds = cooldownHours * 3600;

    if (elapsedTime < cooldownSeconds) {
      // 在冷却期间且有减少时间配置时，减少冷却时间
      if (cooldownReduction > 0) {
        const newCooldownTime = parseInt(lastSentTime) - (cooldownReduction * 60);
        await setKeyValue(cooldownKey, newCooldownTime.toString());
      }
      return true;
    }

    return false;
  }

  /**
   * 设置冷却时间
   * @param {string} cooldownKey Redis键名
   * @param {number} cooldownHours 冷却时间(小时)
   */
  async setCooldown(cooldownKey, cooldownHours) {
    if (cooldownHours <= 0) return;

    const currentTime = Math.floor(Date.now() / 1000);
    await setKeyValue(cooldownKey, currentTime.toString(), cooldownHours * 3600);
  }

  /**
   * 将秒数转换为时间组件对象
   * @param {number} seconds 秒数
   * @returns {object} 包含小时、分钟和秒的对象
   */
  secondsToTimeComponents(seconds) {
    if (seconds < 0) {
      return { hours: 0, minutes: 0, seconds: 0, isNegative: true };
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return {
      hours,
      minutes,
      seconds: remainingSeconds,
      isNegative: false
    };
  }

  /**
   * 将时间组件对象格式化为易读的字符串
   * @param {object} timeComponents 时间组件对象
   * @param {number} timeComponents.hours 小时数
   * @param {number} timeComponents.minutes 分钟数
   * @param {number} timeComponents.seconds 秒数
   * @param {boolean} timeComponents.isNegative 是否为负值
   * @returns {string} 格式化后的时间字符串
   */
  formatTimeComponents(timeComponents) {
    const { hours, minutes, seconds, isNegative } = timeComponents;

    if (isNegative) {
      return "已经结束";
    }

    if (hours > 0) {
      return `还剩${hours}小时${minutes}分${seconds}秒`;
    } else if (minutes > 0) {
      return `还剩${minutes}分${seconds}秒`;
    } else {
      return `还剩${seconds}秒`;
    }
  }

  /**
   * 格式化剩余时间
   * @param {number} remainingSeconds 剩余秒数
   * @returns {string} 格式化后的时间字符串
   */
  formatRemainingTime(remainingSeconds) {
    const timeComponents = this.secondsToTimeComponents(remainingSeconds);
    return this.formatTimeComponents(timeComponents);
  }



/**
 * 窗口冷却计算器 - 检查指定ID+Key组合在时间窗口内的请求频率
 * @param {string} cooldownKey redis键名
 * @param {number} [window=60] 时间窗口(秒)，默认1分钟
 * @param {number} [maxRequests=3] 最大允许请求次数，默认3次
 * @returns {Promise<boolean>} 是否超过限制 (true=超过)
 */
async SlidingWindowCooldown(cooldownKey, window = 60, maxRequests = 3) {

  try {
    // 获取当前计数
    const currentCount = parseInt(await getKeyValue(cooldownKey, 0)) || 0;

    if (currentCount >= maxRequests) {
      return true; // 已超过限制
    }

    // 增加计数并设置过期时间
    const newCount = currentCount + 1;
    await setKeyValue(cooldownKey, newCount, window);

    return false; // 未超过限制
  } catch (error) {
    console.error(`[冷却计算器] 检查失败: ${error.message}`);
    return true; // 出错时保守返回true（阻止操作）
  }
}

}