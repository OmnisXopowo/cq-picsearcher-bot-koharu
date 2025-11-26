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
    return defaultValue || value;
  }
}

export async function setKeyObject(key, value, expiryInSeconds) {

  const obj = JSON.stringify(value);
  // 检查是否提供了过期时间
  if (expiryInSeconds !== undefined) {
    // 如果提供了过期时间，使用SET命令的EX参数设置过期时间
    redis.set(key, obj, 'EX', expiryInSeconds)
      .then(() => {
        console.log(`[RDS save]${key}:${obj} ${expiryInSeconds ? `于${expiryInSeconds}秒过期` : ''}`);
      })
      .catch((err) => {
        console.error(`[RDS save]保存失败 ${key}:${obj} -${err}`);
      });
  } else {
    // 如果没有提供过期时间，只设置键值
    redis.set(key, obj)
      .then(() => {
        console.log(`[RDS save]${key}:${obj}`);
      })
      .catch((err) => {
        console.error(`[RDS save]保存失败 ${key}:${obj} -${err}`);
      });
  }
}

/**
 * 
 * @param {string} key 
 * @param {*} defaultValue 
 * @returns {*|null} 若设置defaultValue则空缓存返回defaultValue，否则返回null
 */
export async function getKeyObject(key, defaultValue) {
  const value = await redis.get(key);
  if (value) {
    console.log(`[RDS read]${key}:${value}`);
    return JSON.parse(value);
  } else {
    return defaultValue || JSON.parse(value);
  }
}