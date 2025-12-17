import Axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import emitter from './emitter.mjs';
import { HttpsProxyAgent } from './httpsProxyAgentMod.mjs';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36';

/**
 * 从代理字符串获取代理
 * @param {string} str
 */
function getAgent(str) {
  if (str.startsWith('http')) return new HttpsProxyAgent(str);
  if (str.startsWith('socks')) return new SocksProxyAgent(str);
}

function createAxios(httpsAgent, ua) {
  return Axios.create({
    ...(httpsAgent ? { httpsAgent } : {}),
    headers: {
      'User-Agent': ua,
    },
  });
}

/** @type {Axios} */
let client = {};

emitter.onConfigLoad(() => {
  const { proxy } = global.config.bot;
  client = createAxios(getAgent(proxy), CHROME_UA);
});

/**
 * 获取下载代理列表配置
 * @returns {Array<{host: string, port: number, protocol: string}>}
 */
function getDownloadProxies() {
  const proxies = global.config?.downloadProxies;
  if (Array.isArray(proxies) && proxies.length > 0) {
    return proxies;
  }
  // 默认回退到单一代理（兼容旧配置）
  return [{ host: '127.0.0.1', port: 7890, protocol: 'http' }];
}

/**
 * 根据代理配置创建 axios 实例
 * @param {{host: string, port: number, protocol: string}} proxyConfig
 * @returns {import('axios').AxiosInstance}
 */
function createProxyAxiosInstance(proxyConfig) {
  const protocol = proxyConfig.protocol || 'http';
  
  if (protocol === 'socks5' || protocol === 'socks') {
    // SOCKS5 代理需要使用 httpsAgent
    const agent = new SocksProxyAgent(`socks5://${proxyConfig.host}:${proxyConfig.port}`);
    return Axios.create({ httpsAgent: agent, httpAgent: agent });
  }
  
  // HTTP 代理使用 Axios 内置的 proxy 配置
  return Axios.create({ 
    proxy: { 
      host: proxyConfig.host, 
      port: proxyConfig.port, 
      protocol 
    } 
  });
}

/**
 * 判断是否为本地后端生产地址（5000）
 * @param {string} url
 */
function isLocalProd(url) {
  try {
    return typeof url === 'string' && url.startsWith('http://127.0.0.1:5000');
  } catch (e) {
    return false;
  }
}

/**
 * 通用请求封装：当请求到 127.0.0.1:5000 失败时，自动替换为 127.0.0.1:5001 重试一次。
 * @param {'get'|'post'} method
 * @param {import('axios').AxiosInstance} instance
 * @param {string} url
 * @param {any} [data]
 * @param {object} [config]
 */
async function requestWithFallback(method, instance, url, data, config) {
  // 首次请求（生产 5000 或任意 URL）
  try {
    if (method === 'get') return await instance.get(url, config);
    if (method === 'post') return await instance.post(url, data, config);
    // 不支持的 method
    throw new Error(`Unsupported method: ${method}`);
  } catch (err) {
    // 仅当目标是本地生产地址且为网络错误（无 HTTP 响应）时尝试回退到 5001
    const isNetworkError = !err || !err.response;
    if (isLocalProd(url) && isNetworkError) {
      // 静默切换到 5001，如果 5001 也失败则直接抛出 5001 的错误
      const fallbackUrl = url.replace(':5000', ':5001');
      if (method === 'get') return await instance.get(fallbackUrl, config);
      if (method === 'post') return await instance.post(fallbackUrl, data, config);
    }
    // 非本地生产地址或不是网络错误，不触发回退，直接抛出原始错误
    throw err;
  }
}

/**
 * 专用的下载方法：支持多代理轮询，所有代理失败后降级为直连
 * @param {string} url
 * @param {{useProxy?: boolean, config?: object}} opts
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function download(url, opts = {}) {
  const { useProxy = true, config = {} } = opts;
  const axiosConfig = { ...config, responseType: 'arraybuffer' };
  
  if (!useProxy) {
    // 不使用代理，直接使用共享 client
    return requestWithFallback('get', client, url, undefined, axiosConfig);
  }
  
  // 多代理轮询
  const proxies = getDownloadProxies();
  const errors = [];
  
  // Layer 1: 多代理轮询
  for (const proxyConfig of proxies) {
    const proxyLabel = `${proxyConfig.host}:${proxyConfig.port}`;
    try {
      const proxyInstance = createProxyAxiosInstance(proxyConfig);
      console.log(`[下载] 尝试代理 ${proxyLabel} (${proxyConfig.protocol || 'http'})`);
      const response = await requestWithFallback('get', proxyInstance, url, undefined, axiosConfig);
      console.log(`[下载] ✓ 代理 ${proxyLabel} 成功`);
      return response;
    } catch (error) {
      const errorMsg = error.message || String(error);
      console.warn(`[下载] ✗ 代理 ${proxyLabel} 失败: ${errorMsg}`);
      errors.push({ proxy: proxyConfig, error });
    }
  }
  
  // Layer 2: 直连（无代理）
  try {
    console.log(`[下载] 所有代理失败 (${errors.length}个)，尝试直连`);
    const response = await requestWithFallback('get', client, url, undefined, axiosConfig);
    console.log(`[下载] ✓ 直连成功`);
    return response;
  } catch (error) {
    const errorMsg = error.message || String(error);
    console.error(`[下载] ✗ 直连也失败: ${errorMsg}`);
    errors.push({ proxy: null, error });
  }
  
  // 所有尝试失败，抛出聚合错误
  const errorSummary = errors.map(e => 
    `${e.proxy ? `${e.proxy.host}:${e.proxy.port}` : '直连'}: ${e.error.message || String(e.error)}`
  ).join('; ');
  const aggregatedError = new Error(`所有下载方式失败: ${errorSummary}`);
  aggregatedError.errors = errors;
  throw aggregatedError;
}

// 针对 client/cfClient 的便捷 get/post 导出函数
async function get(url, config = {}) {
  return requestWithFallback('get', client, url, undefined, config).then(r => r.data ? r : r);
}

async function post(url, data = {}, config = {}) {
  return requestWithFallback('post', client, url, data, config).then(r => r.data ? r : r);
}

async function cfGet(url, config = {}) {
  return requestWithFallback('get', cfClient, url, undefined, config).then(r => r.data ? r : r);
}

async function cfPost(url, data = {}, config = {}) {
  return requestWithFallback('post', cfClient, url, data, config).then(r => r.data ? r : r);
}

export default {
  get client() {
    return client;
  },
  // 兼容原来通过 axios.get/post(...) 的调用方式，导出为函数
  get,
  post,
  getBase64(url, config = {}) {
    // 使用包装后的请求以保证回退逻辑也生效
    return requestWithFallback('get', client, url, undefined, { ...config, responseType: 'arraybuffer' })
      .then(({ data }) => Buffer.from(data).toString('base64'));
  },
  get cfClient() {
    return cfClient;
  },
  cfGet,
  cfPost,
  cfGetBase64(url, config = {}) {
    return requestWithFallback('get', cfClient, url, undefined, { ...config, responseType: 'arraybuffer' })
      .then(({ data }) => Buffer.from(data).toString('base64'));
  },
  // 图片下载助手，保留向后兼容接口
  download,
};
