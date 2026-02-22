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
  const proxies = global.config?.bot?.downloadProxies;
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
 * 为指定 URL 添加必要的请求头和 Cookie
 * 支持 Danbooru CDN 和 ExHentai 等需要特殊处理的域名
 * @param {string} url 图片 URL
 * @param {object} axiosConfig axios 配置对象
 */
function setupDownloadHeaders(url, axiosConfig) {
  const isDanbooruCDN = /cdn\.donmai\.us/.test(url);
  const isExhentai = /^(exhentai\.org|e-hentai\.org|s\.exhentai\.org)/.test(new URL(url).hostname);
  
  // Danbooru CDN 特殊处理
  if (isDanbooruCDN) {
    axiosConfig.headers = {
      ...axiosConfig.headers,
      'Referer': 'https://danbooru.donmai.us/',
      'User-Agent': CHROME_UA
    };
    console.log('[下载] 检测到 Danbooru CDN，已添加 Referer 请求头');
  }
  
  // ExHentai 特殊处理：添加 Cookie
  if (isExhentai) {
    const exhentaiIpbMemberId = global.config?.bot?.exhentaiIpbMemberId || '';
    const exhentaiIpbPassHash = global.config?.bot?.exhentaiIpbPassHash || '';
    const exhentaiIgneous = global.config?.bot?.exhentaiIgneous || '';
    
    if (exhentaiIpbMemberId && exhentaiIpbPassHash) {
      const cookieStr = 
        `ipb_member_id=${exhentaiIpbMemberId}; ` +
        `ipb_pass_hash=${exhentaiIpbPassHash}` +
        (exhentaiIgneous ? `; igneous=${exhentaiIgneous}` : '');
      
      axiosConfig.headers = {
        ...axiosConfig.headers,
        'Cookie': cookieStr,
        'Referer': 'https://exhentai.org/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      };
      console.log('[下载] ExHentai 已添加 Cookie 和 Referer 请求头');
    }
  }
  
  return { isDanbooruCDN, isExhentai };
}

/**
 * 专用的下载方法：支持多代理轮询，所有代理失败后降级为直连
 * 对于 Danbooru CDN 和 ExHentai，支持 Puppeteer 和 FlareSolverr 作为回退方案
 * @param {string} url
 * @param {{useProxy?: boolean, config?: object, usePuppeteer?: boolean, useFlareSolverr?: boolean}} opts
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function download(url, opts = {}) {
  const { useProxy = true, config = {} } = opts;
  const axiosConfig = { ...config, responseType: 'arraybuffer' };
  
  // 为 URL 设置必要的请求头
  const { isDanbooruCDN, isExhentai } = setupDownloadHeaders(url, axiosConfig);
  
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
  
  // Layer 3: 对于 Danbooru CDN 和 ExHentai，尝试 Puppeteer
  if (isDanbooruCDN || isExhentai) {
    try {
      console.log('[下载] 尝试使用 Puppeteer 绕过限制...');
      const { puppeteer } = await import('../../libs/puppeteer/index.mjs');
      const imageBuffer = await puppeteer.downloadImage(url, { 
        cookies: isExhentai ? {
          ipb_member_id: global.config?.bot?.exhentaiIpbMemberId || '',
          ipb_pass_hash: global.config?.bot?.exhentaiIpbPassHash || '',
          igneous: global.config?.bot?.exhentaiIgneous || ''
        } : undefined
      });
      console.log(`[下载] ✓ Puppeteer 成功 (${imageBuffer.length} bytes)`);
      return { data: imageBuffer };
    } catch (error) {
      const errorMsg = error.message || String(error);
      console.warn(`[下载] ✗ Puppeteer 失败: ${errorMsg}`);
      errors.push({ method: 'Puppeteer', error });
    }
    
    // Layer 4: 尝试 FlareSolverr（如果配置了的话）
    const fsConfig = global.config?.flaresolverr;
    const shouldTryFlaresolverr = 
      (isDanbooruCDN && fsConfig?.url && fsConfig?.enableForDanbooruCDN) ||
      (isExhentai && fsConfig?.url && fsConfig?.enableForDanbooruCDN); // 可复用同一配置
    
    if (shouldTryFlaresolverr) {
      try {
        console.log('[下载] 尝试使用 FlareSolverr 绕过限制...');
        const imageBuffer = await downloadWithFlareSolverr(url, fsConfig);
        console.log(`[下载] ✓ FlareSolverr 成功 (${imageBuffer.length} bytes)`);
        return { data: imageBuffer };
      } catch (error) {
        const errorMsg = error.message || String(error);
        console.error(`[下载] ✗ FlareSolverr 失败: ${errorMsg}`);
        errors.push({ method: 'FlareSolverr', error });
      }
    }
  }
  
  // 所有尝试失败，抛出聚合错误
  const errorSummary = errors.map(e => {
    if (e.proxy) return `${e.proxy.host}:${e.proxy.port}: ${e.error.message || String(e.error)}`;
    if (e.method) return `${e.method}: ${e.error.message || String(e.error)}`;
    return `直连: ${e.error.message || String(e.error)}`;
  }).join('; ');
  const aggregatedError = new Error(`所有下载方式失败: ${errorSummary}`);
  aggregatedError.errors = errors;
  throw aggregatedError;
}

/**
 * 使用 FlareSolverr 下载图片
 * FlareSolverr 会返回 HTML 页面，需要解析 img src 并用获取的 Cookie 重新请求
 * @param {string} url 图片 URL
 * @param {object} fsConfig FlareSolverr 配置
 * @returns {Promise<Buffer>}
 */
async function downloadWithFlareSolverr(url, fsConfig) {
  const axios = (await import('axios')).default;
  
  // 调用 FlareSolverr API
  const response = await axios.post(`${fsConfig.url}/v1`, {
    cmd: 'request.get',
    url: url,
    session: fsConfig.session || undefined,
    maxTimeout: fsConfig.maxTimeout || 60000
  }, { timeout: 90000 });
  
  if (response.data.status !== 'ok') {
    throw new Error(`FlareSolverr 返回错误: ${response.data.message}`);
  }
  
  const solution = response.data.solution;
  
  // 构建 Cookie 字符串
  const cookieStr = solution.cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
  
  // 使用获取的 Cookie 和 User-Agent 重新请求图片
  const imageResponse = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': solution.userAgent,
      'Referer': 'https://danbooru.donmai.us/'
    },
    timeout: 30000
  });
  
  return Buffer.from(imageResponse.data);
}

// 针对 client/cfClient 的便捷 get/post 导出函数
async function get(url, config = {}) {
  return requestWithFallback('get', client, url, undefined, config).then(r => r.data ? r : r);
}

async function post(url, data = {}, config = {}) {
  return requestWithFallback('post', client, url, data, config).then(r => r.data ? r : r);
}

/**
 * 搜索专用的多代理请求封装：支持多代理轮询，所有代理失败后降级为直连
 * @param {'get'|'post'} method 请求方法
 * @param {string} url 请求URL
 * @param {any} data POST数据（GET请求时为undefined）
 * @param {object} config axios配置
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function searchRequest(method, url, data, config = {}) {
  const proxies = getDownloadProxies();
  const timeout = global.config?.bot?.proxyTimeout || 15000;
  const errors = [];
  
  // Layer 1: 多代理轮询
  for (const proxyConfig of proxies) {
    const proxyLabel = `${proxyConfig.host}:${proxyConfig.port}`;
    try {
      const proxyInstance = createProxyAxiosInstance(proxyConfig);
      console.log(`[搜索请求] 尝试代理 ${proxyLabel} (${proxyConfig.protocol || 'http'})`);
      
      let response;
      if (method === 'get') {
        response = await proxyInstance.get(url, { ...config, timeout });
      } else if (method === 'post') {
        response = await proxyInstance.post(url, data, { ...config, timeout });
      }
      
      console.log(`[搜索请求] ✓ 代理 ${proxyLabel} 成功`);
      return response;
    } catch (error) {
      const errorMsg = error.message || String(error);
      console.warn(`[搜索请求] ✗ 代理 ${proxyLabel} 失败: ${errorMsg}`);
      errors.push({ proxy: proxyConfig, error });
    }
  }
  
  // Layer 2: 直连降级（使用共享 client）
  try {
    console.log(`[搜索请求] 所有代理失败 (${errors.length}个)，尝试直连降级`);
    let response;
    if (method === 'get') {
      response = await client.get(url, { ...config, timeout });
    } else if (method === 'post') {
      response = await client.post(url, data, { ...config, timeout });
    }
    console.log(`[搜索请求] ✓ 直连成功`);
    return response;
  } catch (error) {
    const errorMsg = error.message || String(error);
    console.error(`[搜索请求] ✗ 直连也失败: ${errorMsg}`);
    errors.push({ proxy: null, error });
  }
  
  // 所有尝试失败，抛出聚合错误
  const errorSummary = errors.map(e => 
    `${e.proxy ? `${e.proxy.host}:${e.proxy.port}` : '直连'}: ${e.error.message || String(e.error)}`
  ).join('; ');
  const aggregatedError = new Error(`所有搜索请求方式失败: ${errorSummary}`);
  aggregatedError.errors = errors;
  throw aggregatedError;
}

/**
 * 搜索专用 GET 请求（支持多代理故障转移）
 */
async function searchGet(url, config = {}) {
  return searchRequest('get', url, undefined, config);
}

/**
 * 搜索专用 POST 请求（支持多代理故障转移）
 */
async function searchPost(url, data = {}, config = {}) {
  return searchRequest('post', url, data, config);
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
  // 搜索专用请求（支持多代理故障转移）
  searchGet,
  searchPost,
  // 图片下载助手，保留向后兼容接口
  download,
};
