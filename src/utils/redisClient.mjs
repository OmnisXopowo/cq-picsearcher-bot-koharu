// redisClient.js
import { Redis } from 'ioredis';


  // 创建Redis客户端
  const redis = new Redis({
    host: 'localhost', // Redis服务器地址
    port: 6379        // Redis服务器端口
  });

  // 监听错误事件
  redis.on('error', (error) => {
    console.error(`连接Redis失败: ${error}`);
  });

  // 监听连接事件
  redis.on('connect', () => {
    console.log('成功连接至Redis');
  });

  // 监听 Redis 服务器准备好接收命令的事件
  redis.on('ready', () => {
    console.log('Redis 服务器准备好接收命令');
  });

  // 监听连接结束事件
  redis.on('end', () => {
    console.log('Redis 的连接已结束');
  });

  // 监听连接关闭事件
  redis.on('close', () => {
    console.log('客户端已关闭Redis连接');
  });

  // 监听重新连接尝试事件
  redis.on('reconnecting', (delay) => {
    console.log(`将在 ${delay} 毫秒后尝试重新连接`);
  });

  // 监听成功重新连接事件
  redis.on('reconnect', () => {
    console.log('成功重新连接到 Redis 服务器');
  });

  // 监听警告消息事件
  redis.on('warning', (message) => {
    console.warn(`Redis 警告: ${message}`);
  });

  // 监听所有排队命令发送完毕事件
  redis.on('drain', () => {
    console.log('所有排队命令已发送');
  });

  // 监听流暂停事件
  redis.on('pause', () => {
    console.log('流被暂停');
  });

  // 监听流恢复事件
  redis.on('resume', () => {
    console.log('流被恢复');
  });



export async function setKeyValue(key, value, expiryInSeconds) {

  // 检查是否提供了过期时间
  if (expiryInSeconds !== undefined) {
    // 如果提供了过期时间，使用SET命令的EX参数设置过期时间
    redis.set(key, value.toString(), 'EX', expiryInSeconds)
      .then(() => {
        console.log(`[RDS save]${key}:${value} ${expiryInSeconds ? `于${expiryInSeconds}秒过期` : ''}`);
      })
      .catch((err) => {
        console.error(`[RDS save]保存失败 ${key}:${value} -${err}`);
      });
  } else {
    // 如果没有提供过期时间，只设置键值
    redis.set(key, value)
      .then(() => {
        console.log(`[RDS save]${key}:${value}`);
      })
      .catch((err) => {
        console.error(`[RDS save]保存失败 ${key}:${value} -${err}`);
      });
  }
}

/**
 * 
 * @param {string} key 
 * @param {*} defaultValue 
 * @returns {*|null} 若设置defaultValue则空缓存返回defaultValue，否则返回null
 */
export async function getKeyValue(key, defaultValue) {
  const value = await redis.get(key);
  if (value) {
    console.log(`[RDS read]${key}:${value}`);
    return value;
  } else {
    return defaultValue !== undefined ? defaultValue : value;
  }
}

export async function setKeyObject(key, value, expiryInSeconds) {
  const obj = JSON.stringify(value);
  try {
    // 检查是否提供了过期时间
    if (expiryInSeconds !== undefined) {
      // 如果提供了过期时间，使用SET命令的EX参数设置过期时间
      await redis.set(key, obj, 'EX', expiryInSeconds);
      console.log(`[RDS save]${key}:${obj.length > 100 ? obj.substring(0, 100) + '...' : obj} ${expiryInSeconds ? `于${expiryInSeconds}秒过期` : ''}`);
    } else {
      // 如果没有提供过期时间，只设置键值
      await redis.set(key, obj);
      console.log(`[RDS save]${key}:${obj.length > 100 ? obj.substring(0, 100) + '...' : obj} ${expiryInSeconds ? `于${expiryInSeconds}秒过期` : ''}`);
    }
  } catch (err) {
    console.error(`[RDS save]保存失败 ${key}: ${err}`);
    throw err; // 让调用方知道失败
  }
}

/**
 * 
 * @param {string} key 
 * @param {*} defaultValue 
 * @returns {*|null} 若设置defaultValue则空缓存返回defaultValue，否则返回null
 */
export async function getKeyObject(key, defaultValue) {
  try {
    const value = await redis.get(key);
    if (value) {
      console.log(`[RDS read]${key}:${value.length > 100 ? value.substring(0, 100) + '...' : value}`);
      return JSON.parse(value);
    }
    return defaultValue !== undefined ? defaultValue : null;
  } catch (err) {
    console.error(`[RDS read]${key} 解析失败: ${err}`);
    return defaultValue !== undefined ? defaultValue : null;
  }
}

/**
 * 删除指定的key
 * @param {string} key 
 * @returns {Promise<number>} 删除的key数量
 */
export async function delKey(key) {
  try {
    const result = await redis.del(key);
    console.log(`[RDS del]${key}: ${result}`);
    return result;
  } catch (err) {
    console.error(`[RDS del]删除失败 ${key}: ${err}`);
    return 0;
  }
}

/**
 * 搜索匹配模式的所有键
 * @param {string} pattern 匹配模式，如 "tbSelect:*"
 * @returns {Promise<string[]>} 匹配的键名数组
 */
export async function getKeys(pattern) {
  try {
    const keys = await redis.keys(pattern);
    console.log(`[RDS keys]${pattern}: 找到 ${keys.length} 个键`);
    return keys;
  } catch (err) {
    console.error(`[RDS keys]搜索失败 ${pattern}: ${err}`);
    return [];
  }
}

/**
 * 构建带有bot标识符的Redis键名
 * @param {string} prefix 键前缀 (如 "RtMsg", "tbSelect", "groupInfo")
 * @param {number|string} botId 机器人QQ号（self_id）
 * @param {number|string} groupId 群号（仅针对群相关的键）
 * @param {number|string} [messageId] 消息ID（可选，仅针对特定消息的键）
 * @returns {string} 构建好的Redis键名，格式: {prefix}:{botId}:{groupId}:{messageId}（如果有messageId）或 {prefix}:{botId}:{groupId}
 */
export function buildRedisKey(prefix, botId, groupId, messageId) {
  if (messageId !== undefined && messageId !== null) {
    return `${prefix}:${botId}:${groupId}:${messageId}`;
  } else {
    return `${prefix}:${botId}:${groupId}`;
  }
}

/**
 * 构建Redis键搜索模式（带有bot标识符）
 * @param {string} prefix 键前缀 (如 "RtMsg", "tbSelect", "groupInfo")
 * @param {number|string} botId 机器人QQ号（self_id）
 * @param {number|string} [groupId] 群号（可选）
 * @returns {string} 搜索模式，格式: {prefix}:{botId}:{groupId}:* 或 {prefix}:{botId}:*
 */
export function buildRedisKeyPattern(prefix, botId, groupId) {
  if (groupId !== undefined && groupId !== null) {
    return `${prefix}:${botId}:${groupId}:*`;
  } else {
    return `${prefix}:${botId}:*`;
  }
}

// 导出 redis 实例供需要直接操作的情况使用
export { redis };