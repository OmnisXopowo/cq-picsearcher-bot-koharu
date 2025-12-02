import Axios from 'axios';

/**
 * 可重试的网络错误码列表
 */
export const RETRYABLE_ERROR_CODES = [
  'ECONNRESET',    // 连接被重置
  'ETIMEDOUT',     // 连接超时
  'ECONNREFUSED',  // 连接被拒绝
  'ENOTFOUND',     // DNS 解析失败
  'EAI_AGAIN',     // DNS 临时失败
  'EPIPE',         // 管道破裂
  'EHOSTUNREACH',  // 主机不可达
  'ENETUNREACH',   // 网络不可达
  'ECONNABORTED',  // 连接中止
  'ERR_SOCKET_CONNECTION_TIMEOUT', // socket 连接超时
];

/**
 * 判断错误是否可重试
 * @param {Error} e
 * @returns {boolean}
 */
export const isRetryableError = (e) => {
  // 检查错误码
  if (e.code && RETRYABLE_ERROR_CODES.includes(e.code)) return true;
  // 检查 HTTP 状态码（5xx 服务器错误可重试）
  if (e.response?.status >= 500 && e.response?.status < 600) return true;
  // 检查 429 Too Many Requests（限流）
  if (e.response?.status === 429) return true;
  return false;
};

/**
 * 重试策略配置
 * @typedef {Object} RetryOptions
 * @property {number} [times=1] 重试次数
 * @property {number} [delay=0] 重试间隔（毫秒）
 * @property {number} [maxDelay=30000] 最大延迟（毫秒）
 * @property {number} [backoffFactor=2] 退避因子（指数退避时的倍数）
 * @property {boolean} [exponentialBackoff=false] 是否使用指数退避
 * @property {Function} [onError] 错误回调，返回 false 则立即停止重试
 * @property {boolean} [logErrors=true] 是否输出错误日志
 * @property {string} [context=''] 上下文描述（用于日志）
 */

/**
 * 延迟函数
 * @param {number} ms
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 带重试的异步函数执行器（增强版）
 * @param {Function} func 要执行的异步函数
 * @param {number|RetryOptions} [timesOrOptions=1] 重试次数或配置对象
 * @param {Function} [onError] 错误回调（兼容旧版）
 */
export const retryAsync = async (func, timesOrOptions = 1, onError) => {
  // 兼容旧版调用方式
  const options = typeof timesOrOptions === 'number'
    ? { times: timesOrOptions, onError }
    : { ...timesOrOptions };

  const {
    times = 1,
    delay = 0,
    maxDelay = 30000,
    backoffFactor = 2,
    exponentialBackoff = false,
    onError: errorCallback = onError,
    logErrors = true,
    context = '',
  } = options;

  let remaining = times;
  let currentDelay = delay;
  let lastError;

  while (remaining--) {
    try {
      return await func();
    } catch (e) {
      lastError = e;
      const attempt = times - remaining;

      // 输出详细的错误日志
      if (logErrors) {
        const errorInfo = {
          attempt,
          remaining,
          code: e.code || 'N/A',
          status: e.response?.status || 'N/A',
          message: e.message,
          url: e.config?.url || 'N/A',
          method: e.config?.method?.toUpperCase() || 'N/A',
        };
        console.warn(
          `[retry] ${context ? `[${context}] ` : ''}` +
          `尝试 ${attempt}/${times} 失败 | ` +
          `code=${errorInfo.code} status=${errorInfo.status} | ` +
          `${errorInfo.method} ${errorInfo.url} | ` +
          `${errorInfo.message}`
        );
      }

      // 检查是否应该立即停止重试
      if (remaining === 0) {
        if (logErrors) {
          console.error(`[retry] ${context ? `[${context}] ` : ''}所有 ${times} 次重试均失败，放弃`);
        }
        throw e;
      }

      // 调用错误回调，返回 false 则立即停止
      if (errorCallback && errorCallback(e) === false) {
        if (logErrors) {
          console.warn(`[retry] ${context ? `[${context}] ` : ''}onError 返回 false，停止重试`);
        }
        throw e;
      }

      // 等待后重试
      if (currentDelay > 0) {
        if (logErrors) {
          console.log(`[retry] ${context ? `[${context}] ` : ''}等待 ${currentDelay}ms 后重试...`);
        }
        await sleep(currentDelay);

        // 指数退避
        if (exponentialBackoff) {
          currentDelay = Math.min(currentDelay * backoffFactor, maxDelay);
        }
      }
    }
  }

  throw lastError;
};

/**
 * 带智能重试策略的异步函数执行器
 * - 自动判断错误是否可重试
 * - 使用指数退避
 * @param {Function} func 要执行的异步函数
 * @param {Partial<RetryOptions>} [options={}] 配置选项
 */
export const retryAsyncSmart = async (func, options = {}) => {
  return retryAsync(func, {
    times: 3,
    delay: 1000,
    exponentialBackoff: true,
    backoffFactor: 2,
    maxDelay: 10000,
    ...options,
    onError: (e) => {
      // 只有可重试的错误才继续重试
      if (!isRetryableError(e)) {
        console.warn(`[retry] 错误不可重试: code=${e.code || 'N/A'} status=${e.response?.status || 'N/A'}`);
        return false;
      }
      // 如果用户也提供了 onError，继续调用
      if (options.onError) {
        return options.onError(e);
      }
      return true;
    },
  });
};

/**
 * 带重试的 GET 请求（增强版）
 * - 默认重试 3 次
 * - 对 ECONNRESET 等网络错误自动重试
 * - 支持指数退避
 * @param {Parameters<import('axios').Axios['get']>} args
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export const retryGet = (...args) => {
  const url = args[0];
  const config = args[1] || {};
  const { timeout } = config;

  const requestFn = () => {
    if (!timeout) return Axios.get(...args);
    return new Promise((resolve, reject) => {
      // 再整个 timeout 以防万一，axios 的 timeout 可能会失灵……
      const timeoutId = setTimeout(
        () => reject(new Error(`timeout of ${timeout}ms exceeded ${url}`)),
        timeout + 1000
      );
      Axios.get(...args)
        .then((...rets) => {
          clearTimeout(timeoutId);
          resolve(...rets);
        })
        .catch((e) => {
          clearTimeout(timeoutId);
          reject(e);
        });
    });
  };

  return retryAsync(requestFn, {
    times: 3,
    delay: 500,
    exponentialBackoff: true,
    backoffFactor: 2,
    maxDelay: 5000,
    context: `GET ${url?.substring?.(0, 80) || url}`,
    onError: (e) => isRetryableError(e),
  });
};

/**
 * 带重试的 POST 请求（增强版）
 * - 默认重试 3 次
 * - 对 ECONNRESET 等网络错误自动重试
 * - 支持指数退避
 * @param {Parameters<import('axios').Axios['post']>} args
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export const retryPost = (...args) => {
  const url = args[0];
  const config = args[2] || {};
  const { timeout } = config;

  const requestFn = () => {
    if (!timeout) return Axios.post(...args);
    return new Promise((resolve, reject) => {
      // 再整个 timeout 以防万一，axios 的 timeout 可能会失灵……
      const timeoutId = setTimeout(
        () => reject(new Error(`timeout of ${timeout}ms exceeded`)),
        timeout + 2000
      );
      Axios.post(...args)
        .then((...rets) => {
          clearTimeout(timeoutId);
          resolve(...rets);
        })
        .catch((e) => {
          clearTimeout(timeoutId);
          reject(e);
        });
    });
  };

  return retryAsync(requestFn, {
    times: 3,
    delay: 500,
    exponentialBackoff: true,
    backoffFactor: 2,
    maxDelay: 5000,
    context: `POST ${url?.substring?.(0, 80) || url}`,
    onError: (e) => isRetryableError(e),
  });
};
