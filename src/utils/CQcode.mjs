import { pathToFileURL } from 'url';
import _ from 'lodash-es';
import { botClientInfo } from './botClientInfo.mjs';
import { dlImgToCache } from './image.mjs';
import logError from './logError.mjs';

export default class CQ {
  /**
   * @param {string} type
   * @param {Record<string, any>} data
   */
  constructor(type, data) {
    this.type = type;
    this.data = data ? new Map(Object.entries(data)) : new Map();
  }

  /**
   * @param {string} key
   */
  get(key) {
    return this.data.get(key);
  }

  /**
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.data.set(key, value);
    return this;
  }

  /**
   * @param {Record<string, any>} obj
   */
  mset(obj) {
    Object.entries(obj).forEach(kv => this.set(...kv));
    return this;
  }

  /**
   * @param {string} key
   */
  del(key) {
    this.data.delete(key);
    return this;
  }

  toString() {
    const list = Array.from(this.data.entries())
      .filter(([, v]) => !_.isNil(v))
      .map(kv => kv.map(CQ.escapeInsideCQ).join('='));
    list.unshift(`CQ:${this.type}`);
    return `[${list.join(',')}]`;
  }

  /**
   * @param {string[]} keys
   */
  pickData(keys) {
    return _.pick(Object.fromEntries(this.data.entries()), keys);
  }

  /**
   * @param {string} str
   */
  static from(str) {
    const reg = /\[CQ:([^,[\]]+)((?:,[^,=[\]]+=[^,[\]]*)*)\]/g;
    const result = [];
    // eslint-disable-next-line space-in-parens
    for (let match; (match = reg.exec(str)); ) {
      const [, type, dataStr] = match;
      const data = _.transform(
        _.filter(dataStr.split(',')),
        (obj, kv) => {
          const [key, ...value] = kv.split('=');
          obj[CQ.unescape(key)] = CQ.unescape(value.join('='));
        },
        {},
      );
      result.push(new CQ(type, data));
    }
    return result;
  }

  /**
   * 转义
   * @template T
   * @param {T} str 欲转义的字符串
   * @param {boolean} [insideCQ=false] 是否在CQ码内
   * @return {T}
   */
  static escape(str, insideCQ = false) {
    if (typeof str !== 'string' || (global.config.bot.disableMessageEscape && !insideCQ)) return str;
    const result = str.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
    if (!insideCQ) return result;
    return result
      .replace(/,/g, '&#44;')
      .replace(/(\ud83c[\udf00-\udfff])|(\ud83d[\udc00-\ude4f\ude80-\udeff])|[\u2600-\u2B55]/g, ' ');
  }

  /**
   * 反转义
   * @template T
   * @param {T} str 欲反转义的字符串
   * @return {T}
   */
  static unescape(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
  }

  /**
   * 在CQ码内转义
   * @template T
   * @param {T} str 欲转义的字符串
   */
  static escapeInsideCQ(str) {
    return CQ.escape(str, true);
  }

  /**
   * CQ码 图片
   * @param {string | { file: string; url: string; }} file 本地文件路径或URL
   * @param {'flash'|'show'} [type] 类型
   */
  static img(file, type) {
    if (!file) {
      console.error('[error] CQ.img file empty');
      return '';
    }
    if (typeof file === 'object') {
      // NapCat 不支持直接以收到的 file 值发送图片，改用 url 发送
      if (typeof file.file === 'string' && botClientInfo.supportUseFileDirectlyInCQImg) {
        file = file.file;
      } else if (typeof file.url === 'string') {
        file = file.url;
      } else {
        console.error('[error] CQ.img no available file', file);
        return '';
      }
    } else file = String(file);
    // fix Lagrange ssl issue #467
    if (file.startsWith('https://multimedia.nt.qq.com.cn/')) {
      file = file.replace(/^https/, 'http');
    }
    return new CQ('image', { file, type }).toString();
  }

  /**
   * CQ码 图片 下载再发送
   * @param {string} url 本地文件路径或URL
   * @param {'flash'|'show'} [type] 类型
   * @param {import('axios').AxiosRequestConfig} [config] Axios 配置
   */
  static async imgPreDl(url, type, config = {}) {
    try {
      const path = await dlImgToCache(url, config, true);
      return new CQ('image', { file: pathToFileURL(path).href, type }).toString();
    } catch (e) {
      logError('[error] cq img pre-download:'+url);
      logError(e);
    }
    return new CQ('image', { file: url, type }).toString();
  }

  /**
   * CQ码 Base64 图片
   * @param {string|ArrayBuffer} base64 图片 Base64
   * @param {'flash'|'show'} [type] 类型
   */
  static img64(base64, type) {
    if (typeof base64 !== 'string') {
      base64 = Buffer.from(base64).toString('base64');
    }
    return new CQ('image', { file: `base64://${base64}`, type }).toString();
  }

  /**
   * CQ码 视频
   * @param {string} file 本地文件路径或URL
   * @param {string} cover 本地文件路径或URL
   */
  static video(file, cover) {
    return new CQ('video', { file, cover }).toString();
  }

  /**
   * CQ码 分享链接
   * @param {string} url 链接
   * @param {string} title 标题
   * @param {string} content 内容
   * @param {string} image 图片URL
   */
  static share(url, title, content, image) {
    return new CQ('share', { url, title, content, image }).toString();
  }

  /**
   * CQ码 @
   * @param {number} qq
   */
  static at(qq) {
    return `${new CQ('at', { qq }).toString()}${global.config.bot.spaceAfterAt ? ' ' : ''}`;
  }

  /**
   * CQ码 @全体成员
   */
  static atAll() {
    return `[CQ:at,qq=all]${global.config.bot.spaceAfterAt ? ' ' : ''}`;
  }

  /**
   * CQ码 回复
   * @param {number} id 消息ID
   */
  static reply(id) {
    return new CQ('reply', { id }).toString();
  }

  /**
   * CQ码 语音
   * @param {string} file 本地文件路径或URL
   */
  static record(file) {
    return new CQ('record', { file }).toString();
  }

  /**
   * 从消息中提取指定类型的第一个 CQ 码
   * @param {string} message 消息字符串
   * @param {string} type CQ 类型
   * @returns {CQ|null}
   */
  static findFirst(message, type) {
    const codes = CQ.from(message).filter(cq => cq.type === type);
    return codes.length > 0 ? codes[0] : null;
  }

  /**
   * 移除指定类型的 CQ 码
   * @param {string} message 消息字符串
   * @param {string[]} types 要移除的 CQ 类型数组
   * @returns {string}
   */
  static removeTypes(message, types) {
    if (!message || !types || types.length === 0) return message;
    
    const pattern = types.map(t => 
      `\\[CQ:${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\]]*\\]`
    ).join('|');
    
    return message.replace(new RegExp(pattern, 'g'), '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 清理消息用于显示（将 CQ 码转为文本说明）
   * 参考 messageContextManager._cleanMessage 实现细化处理
   * @param {string} message 消息字符串
   * @param {object} [options] 自定义替换选项
   * @returns {string}
   */
  static cleanForDisplay(message, options = {}) {
    if (!message) return '';
    
    const defaults = {
      image: '[图片]',
      face: '[表情]',
      at: '[@]',
      atAll: '[@全体成员]',
      record: '[语音]',
      video: '[视频]',
      reply: '',  // 回复码通常移除
      share: '[链接分享]',
      music: '[音乐分享]',
      redbag: '[红包]',
      poke: '[戳一戳]',
      forward: '[聊天记录]',
      xml: '[卡片消息]',
      json: '[卡片消息]',
      default: ''  // 其他未知类型
    };
    
    const map = { ...defaults, ...options };
    
    const cleaned = message
      // 先处理特殊的 @全体成员
      .replace(/\[CQ:at,qq=all[^\]]*\]/g, map.atAll)
      // 再处理各种 CQ 码
      .replace(/\[CQ:image[^\]]*\]/g, map.image)
      .replace(/\[CQ:face[^\]]*\]/g, map.face)
      .replace(/\[CQ:at[^\]]*\]/g, map.at)
      .replace(/\[CQ:record[^\]]*\]/g, map.record)
      .replace(/\[CQ:video[^\]]*\]/g, map.video)
      .replace(/\[CQ:reply[^\]]*\]/g, map.reply)
      .replace(/\[CQ:share[^\]]*\]/g, map.share)
      .replace(/\[CQ:music[^\]]*\]/g, map.music)
      .replace(/\[CQ:redbag[^\]]*\]/g, map.redbag)
      .replace(/\[CQ:poke[^\]]*\]/g, map.poke)
      .replace(/\[CQ:forward[^\]]*\]/g, map.forward)
      .replace(/\[CQ:xml[^\]]*\]/g, map.xml)
      .replace(/\[CQ:json[^\]]*\]/g, map.json)
      // 最后处理其他未知 CQ 码
      .replace(/\[CQ:[^\]]+\]/g, map.default);
    
    // 清理多余的空白
    return cleaned.replace(/\s+/g, ' ').trim();
  }
}
