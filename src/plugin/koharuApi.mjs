import { debug } from 'console';
import _ from 'lodash-es';
import { getImgs, hasImage } from '../index.mjs';
import axios from '../utils/axiosProxy.mjs';
import { createCache, getCache } from '../utils/cache.mjs';
import { CooldownManager } from '../utils/CooldownManager.mjs';
import CQ from '../utils/CQcode.mjs';
import { checkImageHWRatio, getAntiShieldedCqImg64FromUrl } from '../utils/image.mjs';
import logError from '../utils/logError.mjs';
import logger from '../utils/logger.mjs';
import { getRawMessage } from '../utils/message.mjs';
import { getKeyObject, setKeyObject } from '../utils/redisClient.mjs';
import voiceManager from '../voicesBank/VoiceManager.mjs';
import IqDB from './iqdb.mjs';
import saucenao, { snDB } from './saucenao.mjs';



const setting = global.config.bot.setu;
const proxy = setting.pximgProxy.trim();
const cooldownManager = new CooldownManager();

export async function getContextFromUrl(context) {
    let isImg = false;
    // 修改为同时支持/收藏和/post命令
    let Url = context.message.replace('/收藏', '').replace(/^\/post/, '');
    try {
        // 判断是否是回复的消息
        const rMsgId = _.get(/^\[CQ:reply,id=(-?\d+).*\]/.exec(context.message), 1);
        if (rMsgId) {
            const { data } = await global.bot('get_msg', { message_id: Number(rMsgId) });
            if (data) {
                // 如果回复的是机器人的消息则忽略
                if (data.sender.user_id === context.self_id) {
                    return false;
                }
                const imgs = getImgs(getRawMessage(data));
                const rMsg = imgs
                    .map(({ file, url }) => `[CQ:image,file=${CQ.escape(file, true)},url=${CQ.escape(url, true)}]`)
                    .join('');
                context = { ...context, message: context.message.replace(/^\[CQ:reply,id=-?\d+.*?\]/, rMsg) };
            } else {
                // 获取不到原消息，忽略
            }
        }
    } catch (error) {
        if (global.config.bot.debug) {
            console.log('[收藏功能-回复消息解析异常]', error);
        }
    }

    let snSimilarity = null;
    let iqdbSimilarity = null;
    
    if (hasImage(context.message)) {
        // 图片搜索和入库在 ArchivedImg 中完成
        const archiveResult = await ArchivedImg(context);
        isImg = true;
        
        // 如果有成功入库的结果，直接返回 true（已处理完成）
        if (archiveResult && archiveResult.hasResult) {
            return { type: '_processed' }; // 特殊标记，表示已处理
        }
        
        // 没有匹配结果时，记录相似度用于显示
        if (archiveResult) {
            snSimilarity = archiveResult.snSimilarity;
            iqdbSimilarity = archiveResult.iqdbSimilarity;
        }
    } else {
        // 非图片消息，直接解析URL
        const cleanedUrl = Url.replace('/收藏', '').replace(/^\/post/, '').trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

        // Danbooru
        const regexDb = /(https:\/\/danbooru\.donmai\.us\/(?:posts|post\/show|show)\/)(\d+)/;
        const matchDb = cleanedUrl.match(regexDb);
        if (matchDb) {
            return { id: parseInt(matchDb[2]), type: 'danbooru' };
        }
        // Pixiv
        const regexPy = /(https:\/\/(?:www\.)?pixiv\.net\/(?:en\/|)(?:i\/|artworks\/))(\d+)/;
        const matchPy = cleanedUrl.match(regexPy);
        if (matchPy) {
            return { id: parseInt(matchPy[2]), type: 'pixiv' };
        }
        // E-Hentai
        const regexEh = /(https:\/\/(?:exhentai|e-hentai)\.org\/g\/(\d+)\/[a-zA-Z0-9]+\/)/;
        const matchEh = cleanedUrl.match(regexEh);
        if (matchEh) {
            return { url: matchEh[0], type: 'ehentai' };
        }
        // NHentai
        const regexNh = /(https:\/\/nhentai\.net\/g\/(\d+)\/)/;
        const matchNh = cleanedUrl.match(regexNh);
        if (matchNh) {
            return { gid: parseInt(matchNh[2]), type: 'nhentai' };
        }
    }

    // 如果没有找到匹配项，返回false
    if (isImg) {
        let notFoundMsg = `未搜索到收录图站`;
        // 仅当有成功获取到相似度时才追加显示
        const accParts = [];
        if (snSimilarity != null) {
            accParts.push(`Acc1: ${Math.round(snSimilarity)}`);
        }
        if (iqdbSimilarity != null) {
            accParts.push(`Acc2: ${Math.round(iqdbSimilarity)}`);
        }
        if (accParts.length > 0) {
            notFoundMsg += `\n${accParts.join(' ')}`;
        }
        global.replyMsg(context, notFoundMsg, false, true);
    }
    return false;
}

// 异步方法添加E-Hentai作品信息
async function illustAddEhentai(url, context) {
    try {
        const response = await axios.post('http://127.0.0.1:5000/api/ehentaiAdd', {
            url,
            group: context.group_id ?? 0,
            user: context.user_id
        });
        return response.data;
    } catch (error) {
        console.error('[E站作品-入库请求失败]', error);
        throw error;
    }
}
// 异步方法添加NHentai作品信息
async function illustAddNhentai(gid, context) {
    try {
        const response = await axios.post('http://127.0.0.1:5000/api/nhentaiAdd', {
            gid,
            group: context.group_id ?? 0,
            user: context.user_id
        });
        return response.data;
    } catch (error) {
        console.error('[N站本子-入库请求失败]', error);
        throw error;
    }
}
// 异步方法获取作品排行
async function getIllustRanking(mode = 'day', date = null) {
    try {
        const response = await axios.get('http://127.0.0.1:5000/api/illust_ranking', {
            params: { mode, date }
        });
        return response.data;
    } catch (error) {
        console.error('[书库系统-排行榜数据获取失败]', error);
        throw error; // 将错误向上抛出，以便可以在调用处处理
    }
}

// 异步方法添加作品信息
async function illustAddPixiv(illustId, context) {

    const response = await axios.post('http://127.0.0.1:5000/api/PixivLib/illustAdd', {
        illust: illustId,
        group: context.group_id ?? 0,
        user: context.user_id
    }).catch(function (error) {
        throw error;
    });
    return response.data;
}

async function illustAddDanbooru(illustId, context) {

    const response = await axios.post('http://127.0.0.1:5000/api/DanbooruLib/danbooruAdd', {
        illust: illustId,
        group: context.group_id ?? 0,
        user: context.user_id
    }).catch(function (error) {
        throw error;
    });
    return response.data;
}


// 异步方法为作品打分
export function illustRating(illustObj, context, rate) {

    let url;
    if (illustObj.type === 'pixiv') {
        url = 'http://127.0.0.1:5000/api/PixivLib/illustRating';
    }
    if (illustObj.type === 'danbooru') {
        url = 'http://127.0.0.1:5000/api/DanbooruLib/danbooruRating';
    }
    axios.post(url, {
        illust: illustObj.id,
        group: context.group_id ?? 0,
        user: context.user_id,
        rate
    }).then(result => {
        if (result.data.error) {
            global.replyMsg(context, result.error, false, true);
        } else {
            // 尝试将格式化后的结果转换为整数，如果小数部分为00
            global.replyMsg(context,
                `${result.data.message}\n平均:${ratingFormatter((result.data.rating_sum / result.data.rating_times))}\n总分：${ratingFormatter(result.data.rating_sum)} 人数:${result.data.rating_times}`
                , false, true);
        }
    }).catch(error => {
        console.error('[作品评分-提交评分请求失败]', error);
        if (!error.response) {
            global.replyMsg(context, `书库暂时维护中，已加入缓存`, false, true);
        }
    });
}

// 异步方法移除作品
export function illustRemove(illustObj, context) {
    let url;
    if (illustObj instanceof String) {
        url = 'http://127.0.0.1:5000/api/PixivLib/illustRemove';
    } else {
        switch (illustObj.type) {
            case 'pixiv':
                url = 'http://127.0.0.1:5000/api/PixivLib/illustRemove';
                break;
            case 'danbooru':
                url = 'http://127.0.0.1:5000/api/DanbooruLib/illustRemove';
                break;
            default:
                url = 'http://127.0.0.1:5000/api/PixivLib/illustRemove';
                break;
        }
    }
    axios.get(url, {
        params: {
            illust: illustObj,
        }
    }).then(result => {
        if (result.data.error) {
            global.replyMsg(context, result.data.error, false, true);
        } else {
            global.replyMsg(context, result.data.message, false, true);
        }
    }).catch(error => {
        console.error('[作品移除-删除请求失败]', error);
        if (!error.response) {
            global.replyMsg(context, `书库暂时维护中，已加入缓存`, false, true);
        }
    });
}


export async function getCommon(context) {
    const setting = global.config.bot.setu;
    const replys = global.config.bot.replys;



    const query = CQ.unescape(context.message.replace('/来点', '').trim());

    const clearAirGruop = [515647056, 850880881];

    if (query.includes('要闻') && context.group_id && clearAirGruop.includes(context.group_id)) {

        const cooldownKey = `foot_cooldown:${context.group_id}:${context.user_id}`;
        const cooldownHour = 3;

        const options = {
            cooldownHours: cooldownHour,
            cooldownReduction: 5
        };
        // 检查冷却状态
        const remainingTime = await cooldownManager.checkCooldown(cooldownKey, cooldownHour);

        if (remainingTime) {

            global.replyMsg(context, `已开启群通风，先散散脚气再闻吧！${cooldownManager.formatRemainingTime(remainingTime)}`, false, true);
            // 从 collectReply 目录中获取随机语音文件
            voiceManager.getRandomVoice('footFetishismReply', context.group_id, options)
                .then(voiceUrl => {
                    if (voiceUrl) {
                        // 发送语音文件
                        global.replyMsg(context, CQ.record(voiceUrl));
                    }
                })
                .catch(error => {
                    console.error('[收藏回复-足控专属语音文件获取异常]', error);
                });
            return true;

        } else {
            await cooldownManager.setCooldown(cooldownKey, cooldownHour);
        }
    }

    const isOverLimit = await cooldownManager.SlidingWindowCooldown(`setu:${context.group_id}:${context.user_id}`, 60, 3);
    if (isOverLimit) {
        global.replyMsg(context, replys.setuLimit, false, true);
        replyLimitedReply(context);
        return true;
    }


    axios.post('http://127.0.0.1:5000/api/Common/commonSearch', {
        query
    }).then(async response => {
        if (response.data.error) {
            global.replyMsg(context, response.data.error, false, true);
        }
        else {
            // 输出tag_trace_info信息到控制台，便于调试
            if (response.data.tag_trace_info && Array.isArray(response.data.tag_trace_info)) {
                console.log('[来点功能-标签解析追踪开始]');
                response.data.tag_trace_info.forEach(traceInfo => {
                    const tagDetails = traceInfo.tags.map(tag => `${tag.display_name}(ID: ${tag.id})`).join(', ');
                    console.log('[来点功能-单个标签解析映射]', `${traceInfo.original_tag} -> ${tagDetails}`);
                });
            }

            const searchResult = new SearchResult(response.data);
            if (searchResult.data.length > 0) {
                const illust = searchResult.data[0].data;
                // 输出来源链接到控制台，便于调试
                if (searchResult.data[0].type === 'pixiv') {
                    console.log('[来点功能-Pixiv作品来源]', `https://www.pixiv.net/artworks/${illust.id_illust}`);
                } else if (searchResult.data[0].type === 'danbooru') {
                    console.log('[来点功能-Danbooru作品来源]', `https://danbooru.donmai.us/posts/${illust.id_danbooru}`);
                }
                const preSendMsgs = [];
                const setting = global.config.bot.setu;
                let sendImg;

                if (searchResult.data[0].type === 'pixiv') {
                    let RndIndex = -1;
                    if (illust.meta_large_pages && illust.meta_large_pages.length > 0) {
                        RndIndex = Math.floor(Math.random() * illust.meta_large_pages.length);
                        sendImg = illust.meta_large_pages[RndIndex];
                    } else if (illust.meta_pages && illust.meta_pages.length > 0) {
                        RndIndex = Math.floor(Math.random() * illust.meta_pages.length);
                        sendImg = illust.meta_pages[RndIndex];
                    } else if (illust.meta_large) {
                        sendImg = illust.meta_large;
                    } else if (illust.meta_single_page) {
                        sendImg = illust.meta_single_page;
                    }
                    const titleStr = searchResult.data.title ? `${searchResult.data.title}\n` : '';

                    if (RndIndex === -1) {
                        preSendMsgs.push(`${titleStr}原图：https://pixiv.net/i/${illust.id_illust}`);
                        const sendUrls = [];
                        if (setting.sendPximgProxies.length) {
                            for (const imgProxy of setting.sendPximgProxies) {
                                const path = new URL(sendImg).pathname.replace(/^\//, '');
                                if (!/{{.+}}/.test(imgProxy)) {
                                    const imgUrl = new URL(path, imgProxy).href;
                                    sendUrls.push(imgUrl);
                                }
                            }
                            if (sendUrls.length === 1) preSendMsgs.push(`代理：${sendUrls[0]}`);
                            else preSendMsgs.push('代理：', ...sendUrls);

                            replyPixivRatingMsg(illust.id_illust, context, preSendMsgs.join('\n'));

                            if (sendUrls[0]) {
                                console.log('[来点功能-Pixiv单图发送URL]', sendUrls[0]);
                                replyPixivRatingMsg(illust.id_illust, context, await CQ.imgPreDl(sendUrls[0]));
                            }
                        }
                    }
                    else {
                        preSendMsgs.push(`${titleStr}原图集：https://pixiv.net/i/${illust.id_illust}`);
                        replyPixivRatingMsg(illust.id_illust, context, preSendMsgs.join('\n'));

                        const preMsg = illust.meta_large_pages.map((pageUrl, index) => {
                            const url = getSetuUrl(proxy, pageUrl);
                            if (url) {
                                console.log(`[来点功能-Pixiv图集发送URL-第${index + 1}张]`, url);
                                return CQ.img(url);
                            }
                        }).filter(Boolean);
                        replyPixivRatingMsg(illust.id, context, preMsg.join(''));
                    }

                } else if (searchResult.data[0].type === 'danbooru') {
                    // 有pixiv id则发送pixiv
                    if (illust.pixiv_id) {
                        replyDanbooruRatingMsg(illust.id_danbooru, context, `原图：https://www.pixiv.net/artworks/${illust.pixiv_id}`);
                    } else {
                        replyDanbooruRatingMsg(illust.id_danbooru, context, `原图：${illust.source}`);
                    }

                    if (illust.large_file_url) {
                        if (illust.large_file_url.startsWith('https://cdn.donmai.us/')) {
                            try {
                                const Rvhost = global.config.reverseProxy;
                                // 如果 reverseProxy 为空，则直接使用原始 URL
                                const url = Rvhost ? `${Rvhost}/${illust.large_file_url}` : illust.large_file_url;
                                console.log('[来点功能-Danbooru图片下载URL(CDN)]', url);

                                try {
                                    const imgCQ = await downloadImage(url, context, !!Rvhost);
                                    replyDanbooruRatingMsg(illust.id_danbooru, context, imgCQ, false);
                                } catch (error) {
                                    // 如果使用Worker代理失败，则绕过Worker直接使用代理请求原始CDN
                                    console.warn('[来点功能-Danbooru图片Worker代理下载失败回退直连CDN]', error.message);
                                    console.log('[来点功能-Danbooru图片绕过Worker直接代理请求CDN]', illust.large_file_url);
                                    const imgCQ = await downloadImage(illust.large_file_url, context, true);
                                    replyDanbooruRatingMsg(illust.id_danbooru, context, imgCQ, false);
                                }
                            } catch (error) {
                                console.error('[来点功能-Danbooru图片所有下载尝试均失败]', error);
                            }
                        } else {
                            try {
                                // 检查是否为 Pixiv 图片，如果是则使用 downloadImage 应用代理
                                if (/^https?:\/\/i\.pximg\.net\//.test(illust.large_file_url)) {
                                    console.log('[来点功能-Danbooru来源Pixiv图片下载URL]', illust.large_file_url);
                                    const imgCQ = await downloadImage(illust.large_file_url, context, true);
                                    replyDanbooruRatingMsg(illust.id_danbooru, context, imgCQ, false);
                                } else {
                                    console.log('[来点功能-Danbooru其他来源图片下载URL]', illust.large_file_url);
                                    replyDanbooruRatingMsg(illust.id_danbooru, context, await CQ.imgPreDl(illust.large_file_url), false);
                                }
                            } catch (error) {
                                console.error('[来点功能-Danbooru非CDN图片预下载失败]', error);
                            }
                        }
                    }
                }
            } else {
                global.replyMsg(context, `没找到这样的作品呢，请老师多提供收藏哟~`, false, true);
            }
        }
    }).catch(error => {
        console.error('[来点功能-后端API请求异常]', error);
        if (!error.response) {
            global.replyMsg(context, `书库暂时维护中`, false, true);
        }
        else if (error.response && error.response.data && error.response.data.user_message) {
            global.replyMsg(context, error.response.data.user_message, false, true);
        }
        else if (error.response && error.response.status === 400) {
            global.replyMsg(context, `书库暂时维护中`, false, true);
        }
    });
}

/**
 * 处理/推本或/tb命令，搜索并收藏E-Hentai作品
 * @param {object} context 消息上下文
 * @returns {Promise<boolean>} 是否成功处理命令
 */
export async function pushDoujinshi(context) {
    // 提取关键词（去除命令前缀）
    const keyword = CQ.unescape(context.message.replace('/推本', '').replace('/tb', '').trim());

    // 如果没有关键词，提示用户输入
    if (!keyword) {
        global.replyMsg(context, '请输入要搜索的关键词，例如：/推本+只属于老师的捣蛋鬼', false, true);
        return true;
    }

    try {
        console.log('[推本功能-用户搜索关键词]', keyword);

        // 调用新的API接口
        const response = await axios.post('http://127.0.0.1:5000/api/Ehentai/search-and-add', {
            keyword,
            use_exhentai: true
        });

        const result = response.data;

        if (result.action === 'added') {
            // 成功自动入库
            const gallery = result.data.gallery;
            let msg = `${gallery.rawTitle}\n` +
                `好书收录📚 ！${gallery.rating}⭐ ${gallery.pageCount}P:`;

            // 添加评论内容显示
            if (gallery.comments && gallery.comments.length > 0) {
                // 过滤掉包含http链接的评论
                const filteredComments = gallery.comments.map(comment =>
                    comment.replace(/(https?):\/\/([^\s]+)/g, (match, protocol, rest) => {
                        // 在协议后添加emoji来避免链接识别
                        const emojis = ['🔗', '🌐', '🔍', '💡', '📌'];
                        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                        return `${protocol}://${randomEmoji}${rest}`;
                    })
                );

                const commentsToShow = [];
                let totalLength = 0;
                const maxLength = 800;


                for (let i = 0; i < Math.min(15, filteredComments.length); i++) {
                    const comment = filteredComments[i];
                    const commentLength = comment.length + 3; // +3 for the prefix and newline

                    if (totalLength + commentLength <= maxLength) {
                        commentsToShow.push(comment);
                        totalLength += commentLength;
                    } else {
                        break;
                    }
                }

                // 继续添加评论直到达到字数限制
                // if (commentsToShow.length >= 10) {
                //     for (let i = 10; i < filteredComments.length; i++) {
                //         const comment = filteredComments[i];
                //         const commentLength = comment.length + 3; // +3 for the prefix and newline

                //         if (totalLength + commentLength <= maxLength) {
                //             commentsToShow.push(comment);
                //             totalLength += commentLength;
                //         } else {
                //             break;
                //         }
                //     }
                // }

                msg += `\n${commentsToShow.map(comment => `-${comment}`).join('\n')}`;
                console.log('[推本功能-返回消息长度统计]', msg.length);
                const ret = await global.replyMsg(context, msg, false, true);
                console.log('[推本功能-消息发送结果]', ret);
                if (ret.retcode === 1200) {
                    console.warn('[推本功能-消息发送失败分段重试]', '可能被禁言或群组被禁言');
                    const ret1 = await global.replyMsg(context, `好书收录📚 ！${gallery.rating}⭐ ${gallery.pageCount}P:\n${gallery.rawTitle}\n`, false, true);
                    console.log('[推本功能-分段发送结果1]', ret1);
                    const ret2 = await global.replyMsg(context, `Comments：\n${commentsToShow.map(comment => `-${comment}`).join('\n')}`, false, true);
                    console.log('[推本功能-分段发送结果2]', ret2);
                }

            }


        } else if (result.action === 'select') {
            // 需要用户选择
            const galleries = result.data.galleries;
            if (galleries.length === 0) {
                global.replyMsg(context, '没有找到相关结果，请尝试其他关键词', false, true);
                return true;
            }

            // 构建选择列表消息
            let msg = `🔍 找到 ${galleries.length} 个结果，请回复数字序号选择：\n`;
            galleries.forEach((gallery, index) => {
                msg += `\n${index + 1}：${gallery.title}`;
            });

            // 先发送消息
            const msgRet = await global.replyMsg(context, msg, false, true);
            if (msgRet?.retcode === 0) {
                // 将结果存储到缓存中供后续选择使用，参考评分功能的键名格式
                const cacheKey = `tbSelect:${context.group_id}:${msgRet.data.message_id}`;
                await setKeyObject(cacheKey, {
                    galleries,
                    context
                }, 60 * 60 * 24 * 3); // 3天过期，与评分功能保持一致
            }
        } else {
            // 未知的action
            global.replyMsg(context, result.message || '操作完成，但返回了未知结果', false, true);
        }
    } catch (error) {
        console.error('[推本功能-处理流程异常]', error);
        if (error.response && error.response.data && error.response.data.message) {
            global.replyMsg(context, `推本失败: ${error.response.data.message}`, false, true);
        } else {
            global.replyMsg(context, '推本功能暂时不可用，请稍后再试', false, true);
        }
    }

    return true;
}

/**
 * 处理用户选择的 ehentai 画廊
 * @param {number} gid 画廊ID
 * @param {string} token 画廊token
 * @param {object} context 消息上下文
 * @returns {Promise<boolean>} 是否成功处理
 */
export async function handleEhentaiSelect(link, context) {
    try {
        const response = await axios.post('http://127.0.0.1:5000/api/Ehentai/ehentaiAdd', {
            url: link,
            group: context.group_id ?? 0,
            user: context.user_id
        });

        const result = response.data;
        if (result.error) {
            global.replyMsg(context, result.error, false, true);
        } else {
            // 根据返回的 gallery 数据构建消息
            const gallery = result.gallery || {};
            let msg = result.message || '收藏成功';

            if (gallery.title) {
                msg += `\n标题：${gallery.title}`;
            }

            if (gallery.rating !== undefined) {
                msg += `\n评分：${gallery.rating}⭐`;
            }

            if (gallery.pageCount) {
                msg += `\n页数：${gallery.pageCount}P`;
            }

            msg += `\n链接：${link}`;

            global.replyMsg(context, msg, false, true);
        }
        return true;
    } catch (error) {
        console.error('[推本功能-用户选择画廊后入库失败]', error);
        if (error.response && error.response.data && error.response.data.message) {
            global.replyMsg(context, `添加失败: ${error.response.data.message}`, false, true);
        } else {
            global.replyMsg(context, '添加画廊功能暂时不可用，请稍后再试', false, true);
        }
        return true;
    }
}

function getRandomItem(arr) {
    if (Array.isArray(arr) && arr.length > 0) {
        const randomIndex = Math.floor(Math.random() * arr.length);
        return arr[randomIndex];
    }
    return undefined; // 如果不是数组或数组为空，则返回undefined
}

function ratingFormatter(formattedAverage) {
    let avg = formattedAverage;
    if (formattedAverage % 1 !== 0) {
        // 如果是整数，直接返回
        avg = Number(formattedAverage).toFixed(2);
    }
    return parseFloat(avg) === parseInt(avg, 10) ? parseInt(avg, 10) : parseFloat(avg);
}


function replyCollectReply(context, result) {

    // 先尝试判断是否有触发词
    if (result.tags) {
        // 检查 tags 并播放语音
        handleTagsAndPlayVoice(result.tags, context);
    } else {

        // 设置触发概率
        const triggerProbability = 0.1;
        const randomValue = Math.random();

        // 如果随机值小于触发概率，则触发语音回复
        if (randomValue < triggerProbability) {
            // 设置冷却时间为4小时，每次冷却缩短为5分钟
            const options = {
                cooldownHours: 4,
                cooldownReduction: 5
            };

            // 从 collectReply 目录中获取随机语音文件
            voiceManager.getRandomVoice('collectReply', context.group_id, options)
                .then(voiceUrl => {
                    if (voiceUrl) {
                        // 发送语音文件
                        global.replyMsg(context, CQ.record(voiceUrl));
                    }
                })
                .catch(error => {
                    console.error('[收藏回复-随机收藏语音文件获取异常]', error);
                });
        }
    }
}

function replyLimitedReply(context) {
    // 设置触发概率为20%
    const triggerProbability = 0.5;
    const randomValue = Math.random();

    // 如果随机值小于触发概率，则触发语音回复
    if (randomValue < triggerProbability) {
        // 设置冷却时间为4小时，每次冷却缩短为5分钟
        const options = {
            cooldownHours: 2,
            cooldownReduction: 5
        };

        // 从 collectReply 目录中获取随机语音文件
        voiceManager.getRandomVoice('limitedReply', context.group_id, options)
            .then(voiceUrl => {
                if (voiceUrl) {
                    // 发送语音文件
                    global.replyMsg(context, CQ.record(voiceUrl));
                }
            })
            .catch(error => {
                console.error('[涩图限流-惩罚语音文件获取异常]', error);
            });
    }
}

/**
 * 处理 tags 并根据自定义规则播放语音
 * @param {string|string[]} tags - 标签字符串，格式如 "tag1;tag2;tag3" 或标签数组
 * @param {object} context - 上下文对象，包含 group_id 等信息
 */
async function handleTagsAndPlayVoice(tags, context) {
    const tagRules = {
        "toes,soles": ["footFetishismReply"],
        "足指": ["footFetishismReply"],
        // 可以继续添加更多规则
    };

    try {
        console.log('[标签触发-开始匹配特殊标签语音]', tags);
        // 确保 tags 是数组格式
        let tagArray;
        if (typeof tags === 'string') {
            // 如果 tags 是字符串，按分号分割
            tagArray = tags.split(';');
        } else if (Array.isArray(tags)) {
            // 如果 tags 已经是数组，直接使用
            tagArray = tags;
        } else {
            // 如果 tags 是其他类型，转换为字符串再处理
            tagArray = String(tags).split(';');
        }

        // 遍历所有规则，找到匹配的规则并播放语音
        for (const [requiredTags, voiceDirectories] of Object.entries(tagRules)) {
            // 将 requiredTags 转换为数组
            const requiredTagsArray = requiredTags.split(',');

            // 检查是否包含所有 requiredTags
            const hasAllRequiredTags = requiredTagsArray.every(tag => tagArray.includes(tag));

            if (hasAllRequiredTags) {
                // 如果满足条件，随机选择一个语音目录并获取语音文件
                const voiceUrl = await voiceManager.getRandomVoiceFromDirectories(voiceDirectories, context.group_id, {
                    cooldownHours: 4, // 设置冷却时间为4小时
                    cooldownReduction: 15 // 冷却时间减少量为5分钟
                });

                if (voiceUrl) {
                    // 发送语音文件
                    global.replyMsg(context, CQ.record(voiceUrl));
                    break; // 匹配到规则后停止检查其他规则
                }
            }
        }
    } catch (error) {
        console.error('[标签触发-特殊标签语音匹配异常]', error);
    }
}

/**
 * 图片搜索存档功能，仅使用saucenao和Iqdb，搜索完一张就立即处理入库
 * @param {Object} context 消息上下文
 * @returns {Promise<{hasResult: boolean, snSimilarity: number|null, iqdbSimilarity: number|null}>} 搜索结果对象
 */
export async function ArchivedImg(context) {

    // 得到图片链接并搜图
    const msg = context.message;
    const imgs = getImgs(msg);

    const incorrectImgs = _.remove(imgs, ({ url }) => !/^https?:\/\/[^&]+\//.test(url));
    if (incorrectImgs.length) {
        if (global.config.bot.debug) console.warn('[图片存档-非法URL过滤]', incorrectImgs);
        global.replyMsg(context, '部分图片无法获取，请尝试使用其他设备QQ发送', false, true);
    }

    if (!imgs.length) return { hasResult: false, snSimilarity: null, iqdbSimilarity: null };

    let hasAnyResult = false; // 是否有任何一张图片成功入库
    let lastSnSimilarity = null; // 最后一张图的 saucenao 相似度（用于显示）
    let lastIqdbSimilarity = null; // 最后一张图的 iqdb 相似度（用于显示）

    for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        
        // 如果不是第一张图，等待10秒避免触发限流
        if (i > 0) {
            console.log(`[图片存档-等待10秒后搜索第${i + 1}张图片]`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        
        console.log(`[图片存档-开始反向搜图 ${i + 1}/${imgs.length}]`, img.url);

        // 检查图片比例
        if (
            global.config.bot.stopSearchingHWRatioGt > 0 &&
            !(await checkImageHWRatio(img.url, global.config.bot.stopSearchingHWRatioGt))
        ) {
            console.log('[图片存档-图片比例不符合要求，跳过]');
            continue;
        }

        let useIqdb = false;
        let snSimilarity = null;
        let iqdbSimilarity = null;
        let resultUrl = "";

        const snRes = await saucenao(img, snDB.来源, false, true);
        
        // 记录 saucenao 相似度（仅在搜索成功时）
        if (snRes.success && snRes.similarity != null) {
            snSimilarity = snRes.similarity;
            lastSnSimilarity = snSimilarity;
        }

        if (!snRes.success || snRes.lowAcc) {
            useIqdb = true;
            console.log('[图片存档-SauceNAO相似度过低]', snRes.msg);
        } else {
            // Saucenao搜索成功且相似度高，输出结果到控制台
            console.log('[图片存档-SauceNAO高相似度匹配成功]', snRes.msg);
            resultUrl = snRes.msg;
        }

        // iqdb
        if (useIqdb) {
            const { ReturnMsg, success: iqdbSuc, isLowAcc, similarity: iqdbSim, asErr } = await IqDB(img.url).catch(asErr => ({ asErr }));
            if (asErr) {
                console.error('[图片存档-IQDB搜索请求失败]', asErr);
                logError(asErr);
            } else {
                // 记录 iqdb 相似度（仅在搜索成功时）
                if (iqdbSuc && iqdbSim != null) {
                    iqdbSimilarity = iqdbSim;
                    lastIqdbSimilarity = iqdbSimilarity;
                }
                
                const cleanMsg = ReturnMsg.replace(/base64:\/\/[^\]]+/, 'base64://[image_data]');

                if (iqdbSuc && !isLowAcc) {
                    // Iqdb搜索成功且相似度高，输出结果到控制台
                    console.log('[图片存档-IQDB高相似度匹配成功]', cleanMsg);
                    resultUrl = ReturnMsg;
                } else {
                    // 优化日志输出，移除base64图像数据
                    console.warn('[图片存档-IQDB相似度过低]', cleanMsg);
                }
            }
        }

        // 搜索完成后立即尝试匹配图站并入库
        if (resultUrl !== "") {
            const illustObj = matchUrlToIllust(resultUrl);
            if (illustObj) {
                console.log(`[图片存档-匹配到图站 ${i + 1}/${imgs.length}]`, illustObj);
                await processIllustObj(illustObj, context);
                hasAnyResult = true;
            }
        }
    }

    // 返回是否有成功入库的结果，以及最后一张图的相似度（用于未收录时显示）
    return { 
        hasResult: hasAnyResult, 
        snSimilarity: lastSnSimilarity, 
        iqdbSimilarity: lastIqdbSimilarity 
    };
}

/**
 * 从搜索结果URL匹配图站信息
 * @param {string} resultUrl 搜索结果URL
 * @returns {Object|null} 图站信息对象
 */
function matchUrlToIllust(resultUrl) {
    const cleanedUrl = resultUrl.replace('/收藏', '').replace(/^\/post/, '').trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    // Danbooru
    const regexDb = /(https:\/\/danbooru\.donmai\.us\/(?:posts|post\/show|show)\/)(\d+)/;
    const matchDb = cleanedUrl.match(regexDb);
    if (matchDb) {
        return { id: parseInt(matchDb[2]), type: 'danbooru' };
    }
    // Pixiv
    const regexPy = /(https:\/\/(?:www\.)?pixiv\.net\/(?:en\/|)(?:i\/|artworks\/))(\d+)/;
    const matchPy = cleanedUrl.match(regexPy);
    if (matchPy) {
        return { id: parseInt(matchPy[2]), type: 'pixiv' };
    }
    // E-Hentai
    const regexEh = /(https:\/\/(?:exhentai|e-hentai)\.org\/g\/(\d+)\/[a-zA-Z0-9]+\/)/;
    const matchEh = cleanedUrl.match(regexEh);
    if (matchEh) {
        return { url: matchEh[0], type: 'ehentai' };
    }
    // NHentai
    const regexNh = /(https:\/\/nhentai\.net\/g\/(\d+)\/)/;
    const matchNh = cleanedUrl.match(regexNh);
    if (matchNh) {
        return { gid: parseInt(matchNh[2]), type: 'nhentai' };
    }
    
    return null;
}

// 处理单个作品入库
async function processIllustObj(illustObj, context) {
    if (illustObj.type === 'pixiv') {
        illustAddPixiv(illustObj.id, context).then(async result => {
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
            } else {
                replyPixivRatingMsg(illustObj.id, context, `${result.message}:${result.author}<${result.title}>\n${result.caption}`);
                if (result.isR18) {
                    global.replyMsg(context, 'R18？？？  不可以涩涩！ 死刑！', false, true);
                } else if (result.meta_single_page) {
                    const url = getSetuUrl(proxy, result.meta_large);
                    if (url) {
                        try {
                            console.log('[收藏功能-Pixiv单图发送URL]', url);
                            replyPixivRatingMsg(illustObj.id, context, await CQ.imgPreDl(url));
                        } catch (e) {
                            console.error('[收藏功能-Pixiv单图预下载失败]', e);
                        }
                    }
                } else if (result.meta_large_pages) {
                    const preMsg = result.meta_large_pages.map((pageUrl, index) => {
                        const url = getSetuUrl(proxy, pageUrl);
                        if (url) {
                            console.log(`[收藏功能-Pixiv图集发送URL-第${index + 1}张]`, url);
                            return CQ.img(url);
                        }
                    }).filter(Boolean);
                    replyPixivRatingMsg(illustObj.id, context, preMsg.join(''));
                }
                replyCollectReply(context, result);
            }
        }).catch(error => {
            handleApiError(error, context, "投稿");
        });
        return true;
    } else if (illustObj.type === 'danbooru') {
        illustAddDanbooru(illustObj.id, context).then(async result => {
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
            } else {
                // 有pixiv id则发送pixiv
                const texts = [];

                if (result.pixiv_id) {
                    texts.push(`${result.message}\n来源：https://www.pixiv.net/artworks/${result.pixiv_id}`);
                } else {
                    texts.push(`${result.message}\n来源：${result.source}`);
                }
                // 仅在分级不确定时补充判定
                if (result.rating === 'e') {
                    global.replyMsg(context, '是限制级？？ 不可以涩涩！ 死刑！', false, true);
                } else if (result.large_file_url || result.file_url) {
                    const imageUrl = result.large_file_url || result.file_url;
                    try {
                        // 检查URL是否为Pixiv URL（i.pximg.net域名）
                        if (/^https?:\/\/i\.pximg\.net\//.test(imageUrl)) {
                            // Pixiv图片，使用sendPximgProxies代理
                            let proxyUrl = null;
                            
                            if (setting.sendPximgProxies.length) {
                                for (const imgProxy of setting.sendPximgProxies) {
                                    const path = new URL(imageUrl).pathname.replace(/^\//, '');
                                    if (!/{{.+}}/.test(imgProxy)) {
                                        proxyUrl = new URL(path, imgProxy).href;
                                        break; // 使用第一个匹配的代理
                                    }
                                }
                            }

                            if (proxyUrl) {
                                console.log('[收藏功能-DanbooruPixiv来源图片代理URL]', proxyUrl);
                                try {
                                    const imgCQ = await CQ.imgPreDl(proxyUrl);
                                    texts.push(imgCQ);
                                    replyDanbooruRatingMsg(illustObj.id, context, texts.join('\n'), true);
                                } catch (error) {
                                    console.warn('[收藏功能-DanbooruPixiv来源图片代理下载失败]', error.message);
                                    // 代理失败，尝试直接使用downloadImage（会自动应用代理）
                                    console.log('[收藏功能-DanbooruPixiv来源图片回退downloadImage]', imageUrl);
                                    const imgCQ = await downloadImage(imageUrl, context, true);
                                    texts.push(imgCQ);
                                    replyDanbooruRatingMsg(illustObj.id, context, texts.join('\n'), true);
                                }
                            } else {
                                // 没有配置sendPximgProxies，使用downloadImage自动处理
                                console.log('[收藏功能-DanbooruPixiv来源图片无代理配置使用自动处理]', imageUrl);
                                const imgCQ = await downloadImage(imageUrl, context, true);
                                texts.push(imgCQ);
                                replyDanbooruRatingMsg(illustObj.id, context, texts.join('\n'), true);
                            }
                        } else if (imageUrl.startsWith('https://cdn.donmai.us/')) {
                            // Danbooru CDN图片，使用reverseProxy
                            try {
                                const Rvhost = global.config.reverseProxy;
                                const url = Rvhost ? `${Rvhost}/${imageUrl}` : imageUrl;
                                console.log('[收藏功能-DanbooruCDN图片下载URL]', url);
                                const imgCQ = await downloadImage(url, context, !!Rvhost);
                                texts.push(imgCQ);
                                replyDanbooruRatingMsg(illustObj.id, context, texts.join('\n'), true);
                            } catch (error) {
                                // Worker代理失败，绕过Worker直接使用代理请求原始CDN
                                console.warn('[收藏功能-DanbooruCDN Worker代理失败回退直连CDN]', error.message);
                                console.log('[收藏功能-DanbooruCDN绕过Worker直接代理请求]', imageUrl);
                                const imgCQ = await downloadImage(imageUrl, context, true);
                                texts.push(imgCQ);
                                replyDanbooruRatingMsg(illustObj.id, context, texts.join('\n'), true);
                            }
                        } else {
                            // 其他来源图片，直接下载
                            console.log('[收藏功能-Danbooru其他来源图片直接下载URL]', imageUrl);
                            const imgCQ = await CQ.imgPreDl(imageUrl);
                            texts.push(imgCQ);
                            replyDanbooruRatingMsg(illustObj.id, context, texts.join('\n'), true);
                        }
                        replyCollectReply(context, result);
                    } catch (e) {
                        console.error('[收藏功能-Danbooru图片处理流程异常]', e);
                    }
                } else {
                    // large_file_url/文件地址缺失，可能因Danbooru Gold权限不足导致无法展示图片
                    try {
                        texts.push('（已收藏）');
                        replyDanbooruRatingMsg(illustObj.id, context, texts.join('\n'), true);
                        replyCollectReply(context, result);
                    } catch (e) {
                        console.error('[收藏功能-Danbooru无图片权限处理异常]', e);
                    }
                }
            }
        }).catch(error => {
            handleApiError(error, context, "投稿");
        });
        return true;
    } else if (illustObj.type === 'ehentai') {
        illustAddEhentai(illustObj.url, context).then(async result => {
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
            } else {
                replyEhentaiRatingMsg(illustObj.url, context, `${result.message}\n来源：${illustObj.url}`);
                replyCollectReply(context, result);
            }
        }).catch(error => {
            handleApiError(error, context, "投稿");
        });
        return true;
    } else if (illustObj.type === 'nhentai') {
        illustAddNhentai(illustObj.gid, context).then(async result => {
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
            } else {
                replyNhentaiRatingMsg(illustObj.gid, context, `${result.message}\n来源：https://nhentai.net/g/${illustObj.gid}/`);
                replyCollectReply(context, result);
            }
        }).catch(error => {
            handleApiError(error, context, "投稿");
        });
        return true;
    }
    return false;
}


export default async (context) => {

    const illustObj = await getContextFromUrl(context);
    if (illustObj) {
        // 如果是 _processed 类型，说明图片搜索已在 ArchivedImg 中完成处理
        if (illustObj.type === '_processed') {
            return true;
        }
        // 处理单个作品（URL方式入库）
        return await processIllustObj(illustObj, context);
    }
};

function replyEhentaiRatingMsg(url, context, msg) {
    const record = { url, type: 'ehentai' };
    global.replyMsg(context, msg, false, true)
        .then(msgRet => {
            if (msgRet && msgRet.retcode === 0) {
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3); // 缓存三天过期
            } else {
                console.error('[评分系统-E站消息发送异常返回码]', msgRet);
            }
        }).catch(err => {
            console.error('[评分系统-E站消息发送请求失败]', err);
        });
}

function replyNhentaiRatingMsg(gid, context, msg) {
    const record = { gid, type: 'nhentai' };
    global.replyMsg(context, msg, false, true)
        .then(msgRet => {
            if (msgRet && msgRet.retcode === 0) {
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3); // 缓存三天过期
            } else {
                console.error('[评分系统-N站消息发送异常返回码]', msgRet);
            }
        }).catch(err => {
            console.error('[评分系统-N站消息发送请求失败]', err);
        });
}

export function getSetuUrl(proxy, url) {
    const path = new URL(url).pathname.replace(/^\//, '');
    if (!/{{.+}}/.test(proxy)) return new URL(path, proxy).href;
}

export function checkRatingMsg(msgRet) {
    return getKeyObject(`RtMsg:${msgRet.group_id}:${msgRet.message_id}`);
}

/**
 * 检查是否是画廊选择消息
 * @param {object} msgRet 消息对象
 * @returns {Promise<object|null>} 画廊选择数据或null
 */
export async function checkGallerySelectMsg(msgRet) {
    const cacheKey = `tbSelect:${msgRet.group_id}:${msgRet.message_id}`;
    return await getKeyObject(cacheKey, null);
}

/**
 * 回复Pixiv评级消息
 * @param {number} illustId 插画ID
 * @param {object} context 上下文对象
 * @param {string} msg 消息内容
 */
function replyPixivRatingMsg(illustId, context, msg) {
    const record = { id: illustId, type: 'pixiv' };
    global.replyMsg(context, msg, false, false)
        .then(msgRet => {
            if (msgRet?.retcode === 0) {
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3);
            } else {
                console.error('[评分系统-Pixiv消息发送异常返回码]', msgRet);
            }
        })
        .catch(err => {
            console.error('[评分系统-Pixiv消息发送请求失败]', err);
        });
}

/**
 * 回复Danbooru评级消息
 * @param {number} illustId 插画ID
 * @param {object} context 上下文对象
 * @param {string} msg 消息内容
 * @param {boolean} reply 是否使用回复形式
 */
function replyDanbooruRatingMsg(illustId, context, msg, reply = true) {
    const record = { id: illustId, type: 'danbooru' };
    global.replyMsg(context, msg, false, reply)
        .then(msgRet => {
            if (msgRet?.retcode === 0) {
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3);
            } else {
                console.error('[评分系统-Danbooru消息发送异常返回码]', msgRet);
            }
        })
        .catch(err => {
            console.error('[评分系统-Danbooru消息发送请求失败]', err);
        });
}

/**
 * @typedef {Object} Illustration
 * @property {number} access_count
 * @property {number|null} ai_type
 * @property {string|null} author_name
 * @property {string} created_at
 * @property {number} id_group
 * @property {number} id_illust
 * @property {number} id_user
 * @property {boolean|null} is_r18
 * @property {string|null} meta_large
 * @property {string[]|null} meta_large_pages
 * @property {string[]} meta_pages
 * @property {string|null} meta_single_page
 * @property {number} rating_sum
 * @property {number} rating_times
 * @property {number|null} sanity_level
 * @property {string[]} tags
 * @property {string[]} tags_zh
 * @property {string|null} title
 */

export class IllustrationSearchResult {
    /**
     * @param {Object} jsonData
     * @param {Illustration[]} jsonData.data
     * @param {Object.<string, string>} jsonData.params
     * @param {string} jsonData.sql
     * @param {boolean} jsonData.success
     */
    constructor(jsonData) {
        this.data = jsonData.data;
        this.params = jsonData.params;
        this.sql = jsonData.sql;
        this.success = jsonData.success;
    }

    /**
     * @param {number} id
     * @returns {Illustration|undefined}
     */
    getIllustrationById(id) {
        return this.data.find(illust => illust.id_illust === id);
    }

    /**
     * @param {string} tag
     * @returns {Illustration[]}
     */
    getIllustrationsByTag(tag) {
        return this.data.filter(illust =>
            illust.tags.includes(tag) || illust.tags_zh.includes(tag)
        );
    }
}


/**
 * @typedef {Object} IllustrationData
 * @property {number} access_count
 * @property {number|null} ai_type
 * @property {string|null} author_name
 * @property {string} created_at
 * @property {number} id_group
 * @property {number} id_illust
 * @property {number} id_user
 * @property {boolean|null} is_r18
 * @property {string|null} meta_large
 * @property {string[]|null} meta_large_pages
 * @property {string[]} meta_pages
 * @property {string|null} meta_single_page
 * @property {number} rating_sum
 * @property {number} rating_times
 * @property {number|null} sanity_level
 * @property {string[]} tags
 * @property {string[]} tags_zh
 * @property {string|null} title
 */

/**
 * @typedef {Object} DanbooruData
 * @property {string} file_url
 * @property {number} id_danbooru
 * @property {number} id_group
 * @property {number} id_user
 * @property {string} large_file_url
 * @property {number|null} parent_id
 * @property {number|null} pixiv_id
 * @property {string} rating
 * @property {number} rating_sum
 * @property {number} rating_times
 * @property {string} source
 * @property {string} tag_string_character
 * @property {string} tag_string_copyright
 * @property {string} tag_string_general
 * @property {string} tag_string_meta
 * @property {string[]} tags_untranslated
 */

/**
 * @typedef {Object} SearchResultItem
 * @property {IllustrationData | DanbooruData} data
 * @property {'pixiv' | 'danbooru'} type
 */

export class SearchResult {
    /**
     * @param {Object} jsonData
     * @param {SearchResultItem[]} jsonData.data
     * @param {Object.<string, string[]>} jsonData.params
     * @param {string[]} jsonData.sql_records
     * @param {boolean} jsonData.success
     */
    constructor(jsonData) {
        this.data = jsonData.data.map(item => ({
            ...item,
            data: item.type === 'pixiv' ? new IllustrationData(item.data) : new DanbooruData(item.data)
        }));
        this.params = jsonData.params;
        this.sql_records = jsonData.sql_records;
        this.success = jsonData.success;
    }
}

/**
 * 插画数据类
 */
class IllustrationData {
    /**
     * @param {IllustrationData} data
     */
    constructor(data) {
        Object.assign(this, data);
    }
}

/**
 * Danbooru 数据类
 */
class DanbooruData {
    /**
     * @param {DanbooruData} data
     */
    constructor(data) {
        Object.assign(this, data);
    }
}

/**
 * 统一的图片下载函数
 * @param {string} url - 图片URL
 * @param {object} context - 上下文对象
 * @param {boolean} useProxy - 是否使用代理
 * @returns {Promise<string>} CQ码格式的图片
 */
async function downloadImage(url, context, useProxy = true) {
    try {
        let targetUrl = url;

        // 如果是 Pixiv 图片且需要使用代理，则转换为代理 URL
        if (useProxy && /^https?:\/\/i\.pximg\.net\//.test(url)) {
            const proxyUrl = getSetuUrl(proxy, url);
            if (proxyUrl) {
                targetUrl = proxyUrl;
                console.log(`[图片下载-Pixiv代理URL转换] 原始:${url.substring(0, 60)}... 代理:${targetUrl.substring(0, 60)}...`);
            }
        }

        // 使用统一的 axios 封装下载（封装会在需要时回退到 5001）
        const response = await axios.download(targetUrl, { useProxy });
        const filepath = createCache(url, Buffer.from(response.data));
        return CQ.img(filepath);
    } catch (error) {
        if (useProxy) {
            console.warn('[图片下载-代理请求失败尝试直连]', error.message);
        } else {
            console.error('[图片下载-直连请求失败]', error.message);
        }
        throw error;
    }
}

/**
 * 统一的错误处理函数
 * @param {object} error - 错误对象
 * @param {object} context - 上下文对象
 * @param {string} action - 正在执行的操作描述
 */
function handleApiError(error, context, action = "操作") {
    console.error(`[书库系统-${action}API异常统一处理]`, error);
    if (!error.response) {
        global.replyMsg(context, `书库暂时维护中，已加入${action}缓存`, false, true);
    }
    else if (error.response.data && error.response.data.user_message) {
        global.replyMsg(context, error.response.data.user_message, false, true);
    }
    else if (error.response && error.response.status === 400) {
        global.replyMsg(context, `书库暂时维护中`, false, true);
    }
}
