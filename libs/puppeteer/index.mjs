import { executablePath } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { IS_DOCKER } from '../../src/utils/env.mjs';

puppeteer.use(StealthPlugin());

// 用户代理列表（轮换使用）
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// 语言列表
const LANGUAGES = [
  'en-US,en;q=0.9',
  'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
];

class Puppeteer {
  constructor() {
    this.browser = null;
    this.userAgentIndex = 0;
  }

  async launch() {
    if (IS_DOCKER) throw new Error('暂时不支持在 docker 中启用 puppeteer');
    if (this.browser) return;
    if (global.config.bot.debug) console.log('Puppeteer launching');
    
    this.browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=site-per-process', // 禁用站点隔离
        '--disable-web-security', // 禁用网络安全
        '--disable-features=IsolateOrigins', // 禁用源隔离
        '--disable-site-isolation-trials', // 禁用站点隔离试验
      ],
      headless: "new",
      executablePath: executablePath(),
    });
    
    if (global.config.bot.debug) console.log('Puppeteer launched');
  }

  // 获取随机用户代理
  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  // 获取随机语言设置
  getRandomLanguage() {
    return LANGUAGES[Math.floor(Math.random() * LANGUAGES.length)];
  }

  // 设置页面指纹
  async setPageFingerprint(page) {
    const userAgent = this.getRandomUserAgent();
    const language = this.getRandomLanguage();

    // 设置用户代理和视口
    await page.setUserAgent(userAgent);
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      hasTouch: false,
      isLandscape: true,
      isMobile: false,
    });

    // 设置额外的HTTP头部
    await page.setExtraHTTPHeaders({
      'Accept-Language': language,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    });

    // 在新页面上执行的脚本，隐藏自动化特征
    await page.evaluateOnNewDocument(() => {
      // 隐藏 webdriver 属性
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // 修改 navigator 属性
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // 修改 chrome 属性
      window.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {}
      };

      // 修改 Permissions API
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery(parameters);
      };

      // 修改 iframe 检测
      const originalCreateElement = document.createElement;
      document.createElement = function (...args) {
        if (args[0] === 'iframe') {
          const iframe = originalCreateElement.apply(this, args);
          Object.defineProperty(iframe, 'contentWindow', {
            get: function () {
              return undefined;
            }
          });
          return iframe;
        }
        return originalCreateElement.apply(this, args);
      };
    });

    // 模拟用户行为
    await page.evaluateOnNewDocument(() => {
      // 模拟鼠标移动
      window.addEventListener('mousemove', () => {
        window.mouseMoved = true;
      });

      // 模拟滚动
      window.addEventListener('scroll', () => {
        window.pageScrolled = true;
      });

      // 设置一些常见的全局变量
      window.outerWidth = window.innerWidth;
      window.outerHeight = window.innerHeight + 100;
    });
  }

  async get(url, waitSelector, options = {}) {
    await this.launch();
    const page = await this.browser.newPage();
    
    try {
      // 设置指纹
      await this.setPageFingerprint(page);
      
      if (global.config.bot.debug) console.log('Puppeteer get', url);
      
      // 导航到页面
      await page.goto(url, {
        waitUntil: options.waitUntil || 'networkidle2',
        timeout: options.timeout || 60000
      });

      // 等待选择器，如果指定了的话
      if (waitSelector) {
        await page.waitForSelector(waitSelector, {
          timeout: options.selectorTimeout || 30000
        }).catch(e => {
          console.error(`Puppeteer get "${url}" wait "${waitSelector}" error`);
          console.error(e);
          // 可选：获取页面内容用于调试
          if (global.config.bot.debug) {
            page.evaluate(() => document.documentElement.outerHTML)
              .then(html => console.log('Page HTML:', html.substring(0, 1000)))
              .catch(err => console.error('Failed to get page HTML:', err));
          }
        });
      }

      const res = await page.evaluate(() => ({
        request: {
          res: {
            responseUrl: window.location.href,
          },
        },
        data: document.documentElement.outerHTML,
      }));
      
      return res;
    } catch (e) {
      console.error(`Puppeteer get "${url}" error`);
      throw e;
    } finally {
      await page.close();
    }
  }

  async getJSON(url, options = {}) {
    await this.launch();
    const page = await this.browser.newPage();
    
    try {
      // 设置指纹
      await this.setPageFingerprint(page);
      
      if (global.config.bot.debug) console.log('Puppeteer get JSON', url);
      
      // 导航到页面
      await page.goto(url, {
        waitUntil: options.waitUntil || 'networkidle2',
        timeout: options.timeout || 60000
      });

      // 等待 JSON 内容
      await page.waitForSelector('body > pre', {
        timeout: options.selectorTimeout || 30000
      }).catch(async e => {
        if (global.config.bot.debug) {
          const html = await page.evaluate(() => document.documentElement.outerHTML);
          console.log('Page HTML for debugging:', html.substring(0, 2000));
        }
        throw e;
      });

      const res = await page.evaluate(() => ({
        request: {
          res: {
            responseUrl: window.location.href,
          },
        },
        data: JSON.parse(document.querySelector('body > pre').innerText),
      }));
      
      return res;
    } catch (e) {
      console.error(`Puppeteer get JSON "${url}" error`);
      throw e;
    } finally {
      await page.close();
    }
  }

  /**
   * 使用 Puppeteer 下载图片（绕过 Cloudflare）
   * 拦截网络请求获取图片二进制数据
   * @param {string} url 图片 URL
   * @param {object} options 配置选项
   * @returns {Promise<Buffer>} 图片二进制数据
   */
  async downloadImage(url, options = {}) {
    await this.launch();
    const page = await this.browser.newPage();
    
    try {
      // 设置指纹
      await this.setPageFingerprint(page);
      
      console.log(`[Puppeteer] 下载图片: ${url}`);
      
      // 启用请求拦截
      await page.setRequestInterception(true);
      
      let imageBuffer = null;
      
      // 拦截请求，只允许图片资源
      page.on('request', request => {
        const resourceType = request.resourceType();
        if (resourceType === 'image' || request.url() === url) {
          request.continue();
        } else if (resourceType === 'document') {
          // 允许初始导航
          request.continue();
        } else {
          // 阻止其他资源加载
          request.abort();
        }
      });
      
      // 监听响应，捕获图片数据
      page.on('response', async response => {
        const responseUrl = response.url();
        if (responseUrl === url || responseUrl.includes(new URL(url).pathname)) {
          try {
            const buffer = await response.buffer();
            if (buffer && buffer.length > 1000) { // 确保不是错误页面
              imageBuffer = buffer;
              console.log(`[Puppeteer] 捕获图片响应: ${buffer.length} bytes`);
            }
          } catch (e) {
            // 忽略无法获取 buffer 的响应
          }
        }
      });
      
      // 导航到图片 URL
      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: options.timeout || 60000
      });
      
      // 如果通过拦截没有获取到，尝试从页面 img 标签获取
      if (!imageBuffer) {
        // 等待图片加载
        await page.waitForSelector('img', { timeout: 10000 }).catch(() => {});
        
        // 尝试通过 fetch 获取图片
        imageBuffer = await page.evaluate(async (imgUrl) => {
          try {
            const response = await fetch(imgUrl);
            const arrayBuffer = await response.arrayBuffer();
            return Array.from(new Uint8Array(arrayBuffer));
          } catch (e) {
            return null;
          }
        }, url);
        
        if (imageBuffer) {
          imageBuffer = Buffer.from(imageBuffer);
          console.log(`[Puppeteer] 通过 fetch 获取图片: ${imageBuffer.length} bytes`);
        }
      }
      
      if (!imageBuffer) {
        throw new Error('无法获取图片数据');
      }
      
      console.log(`[Puppeteer] ✓ 图片下载成功: ${imageBuffer.length} bytes`);
      return imageBuffer;
      
    } catch (e) {
      console.error(`[Puppeteer] ✗ 图片下载失败: ${e.message}`);
      throw e;
    } finally {
      await page.close();
    }
  }

  // 关闭浏览器
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

const _puppeteer = new Puppeteer();

export { _puppeteer as puppeteer };
