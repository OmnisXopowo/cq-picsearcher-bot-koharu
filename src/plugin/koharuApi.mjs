import Axios from 'axios';
import _ from 'lodash-es';
import { getImgs, hasImage } from '../index.mjs';
import axios from '../utils/axiosProxy.mjs';
import { createCache } from '../utils/cache.mjs';
import { CooldownManager } from '../utils/CooldownManager.mjs';
import CQ from '../utils/CQcode.mjs';
import { getGroupName } from '../utils/groupInfoCache.mjs';
import { checkImageHWRatio } from '../utils/image.mjs';
import { imgAntiShieldingFromFilePath } from '../utils/imgAntiShielding.mjs';
import logError from '../utils/logError.mjs';
import { getRawMessage } from '../utils/message.mjs';
import { getKeyObject, setKeyObject } from '../utils/redisClient.mjs';
import voiceManager from '../voicesBank/VoiceManager.mjs';
import IqDB from './iqdb.mjs';
import saucenao, { snDB } from './saucenao.mjs';

// Koharu API 专用 axios 实例
const koharuApiBaseUrl = global.config.bot.koharuApiBaseUrl || 'http://127.0.0.1:5000';
const koharuApiToken = global.config.bot.koharuApiToken || '';
const koharuAxios = Axios.create({
    baseURL: koharuApiBaseUrl,
    headers: koharuApiToken ? { 'Authorization': `Bearer ${koharuApiToken}` } : {}
});

const setting = global.config.bot.setu;
const proxy = setting.pximgProxy.trim();
const cooldownManager = new CooldownManager();

/**
 * 从 context 中提取用户显示名称（用于统计展示脱敏）
 * 优先使用群名片 > 昵称
 * @param {object} context 消息上下文
 * @returns {string|undefined}
 */
function getDisplayName(context) {
    return context.sender?.card || context.sender?.nickname || undefined;
}

/**
 * 获取用于 API 提交的完整上下文信息（异步）
 * @param {object} context 消息上下文
 * @returns {Promise<{group: number, user: number, display_name: string|undefined, group_name: string|undefined}>}
 */
async function getApiContext(context) {
    const groupName = context.group_id ? await getGroupName(context.group_id) : undefined;
    return {
        group: context.group_id ?? 0,
        user: context.user_id,
        display_name: getDisplayName(context),
        group_name: groupName
    };
}

export async function getContextFromUrl(context) {
    let isImg = false;
    let isFromReply = false; // 标记是否来自引用消息
    // 修改为同时支持/收藏和/post命令
    const Url = context.message.replace('/收藏', '').replace(/^\/post/, '');
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
                isFromReply = true; // 标记来自引用
            } else {
                // 获取不到原消息，忽略
            }
        }
    } catch (error) {
        if (global.config.bot.debug) {
            console.log('收藏 - 回复解析: ', error);
        }
    }




    let failedResults = [];
    
    if (hasImage(context.message)) {
        // 图片搜索和入库在 ArchivedImg 中完成
        const archiveResult = await ArchivedImg(context, isFromReply);
        isImg = true;
        
        // 如果有成功入库的结果，直接返回 true（已处理完成）
        if (archiveResult && archiveResult.hasResult) {
            return { type: '_processed' }; // 特殊标记，表示已处理
        }
        
        // 没有匹配结果时，记录失败的相似度信息用于显示
        if (archiveResult && archiveResult.failedResults) {
            failedResults = archiveResult.failedResults;
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
        
        // 多图全部失败时，逐行显示每张图的ACC信息
        if (failedResults.length > 1) {
            // 多张图片全部失败
            for (const failed of failedResults) {
                const accParts = [];
                if (failed.snSimilarity != null) {
                    accParts.push(`Acc1: ${Math.round(failed.snSimilarity)}`);
                }
                if (failed.iqdbSimilarity != null) {
                    accParts.push(`Acc2: ${Math.round(failed.iqdbSimilarity)}`);
                }
                if (accParts.length > 0) {
                    notFoundMsg += `\n[${failed.index}] ${accParts.join(' ')}`;
                }
            }
        } else if (failedResults.length === 1) {
            // 单张图片失败
            const failed = failedResults[0];
            const accParts = [];
            if (failed.snSimilarity != null) {
                accParts.push(`Acc1: ${Math.round(failed.snSimilarity)}`);
            }
            if (failed.iqdbSimilarity != null) {
                accParts.push(`Acc2: ${Math.round(failed.iqdbSimilarity)}`);
            }
            if (accParts.length > 0) {
                notFoundMsg += `\n${accParts.join(' ')}`;
            }
        }
        global.replyMsg(context, notFoundMsg, false, true);
    }
    return false;
}

// 异步方法添加E-Hentai作品信息
async function illustAddEhentai(url, context) {
    try {
        const apiContext = await getApiContext(context);
        const response = await koharuAxios.post('/api/ehentai/add', {
            url,
            ...apiContext
        });
        return response.data;
    } catch (error) {
        console.error('收藏 - EHentai 添加失败:', error);
        throw error;
    }
}
// NHentai 直接收录已移除（nhentai-add 接口已下线）
// 收藏 nhentai 链接时通过 processIllustObj type='nhentai' 分支提示用户
// 异步方法添加作品信息
async function illustAddPixiv(illustId, context) {
    const apiContext = await getApiContext(context);
    const response = await koharuAxios.post('/api/pixiv/add', {
        illust: illustId,
        ...apiContext
    }).catch(function (error) {
        throw error;
    });
    return response.data;
}

async function illustAddDanbooru(illustId, context) {
    const apiContext = await getApiContext(context);
    const response = await koharuAxios.post('/api/danbooru/add', {
        illust: illustId,
        ...apiContext
    }).catch(function (error) {
        throw error;
    });
    return response.data;
}


// 异步方法为作品打分
export async function illustRating(illustObj, context, rate) {

    let url;
    if (illustObj.type === 'pixiv') {
        url = '/api/pixiv/rate';
    }
    if (illustObj.type === 'danbooru') {
        url = '/api/danbooru/rate';
    }
    const apiContext = await getApiContext(context);
    koharuAxios.post(url, {
        illust: illustObj.id,
        rate,
        ...apiContext
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
        console.error('书库 - 评分失败:', error);
        if (!error.response) {
            global.replyMsg(context, `书库暂时维护中，已加入缓存`, false, true);
        }
    });
}

// 异步方法移除作品
export function illustRemove(illustObj, context) {
    let url;
    if (illustObj instanceof String) {
        url = '/api/pixiv/remove';
    } else {
        switch (illustObj.type) {
            case 'pixiv':
                url = '/api/pixiv/remove';
                break;
            case 'danbooru':
                url = '/api/danbooru/remove';
                break;
            default:
                url = '/api/pixiv/remove';
                break;
        }
    }
    koharuAxios.delete(url, {
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
        console.error('书库 - 移除失败:', error);
        if (!error.response) {
            global.replyMsg(context, `书库暂时维护中，已加入缓存`, false, true);
        }
    });
}


export async function getCommon(context) {
    const replys = global.config.bot.replys;



    const query = CQ.unescape(context.message.replace('/来点', '').trim());

    const clearAirGruop = [515647056];

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
                    console.error('声音回复 - footFetishismReply 获取语音文件失败:', error);
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


    koharuAxios.post('/api/common/search', {
        query,
        limit: 1,
        qq_id: context.user_id,
        group_id: context.group_id ?? 0
    }).then(async response => {
        if (response.data.error) {
            global.replyMsg(context, response.data.error, false, true);
        }
        else {
            // 获取追踪信息用于后续 /trace 命令
            const trace = response.data.trace || null;

            const searchResult = new SearchResult(response.data);
            if (searchResult.data.length > 0) {
                const illust = searchResult.data[0].data;
                // 输出来源链接到控制台，便于调试
                if (searchResult.data[0].type === 'pixiv') {
                    console.log('搜索 - 来源:', `https://www.pixiv.net/artworks/${illust.id_illust}`);
                } else if (searchResult.data[0].type === 'danbooru') {
                    console.log('搜索 - 来源:', `https://danbooru.donmai.us/posts/${illust.id_danbooru}`);
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

                            replyPixivRatingMsg(illust.id_illust, context, preSendMsgs.join('\n'), trace);

                            if (sendUrls[0]) {
                                replyPixivRatingMsg(illust.id_illust, context, await CQ.imgPreDl(sendUrls[0]), trace);
                            }
                        }
                    }
                    else {
                        preSendMsgs.push(`${titleStr}原图集：https://pixiv.net/i/${illust.id_illust}`);
                        replyPixivRatingMsg(illust.id_illust, context, preSendMsgs.join('\n'), trace);

                        const preMsg = illust.meta_large_pages.map(pageUrl => {
                            const url = getSetuUrl(proxy, pageUrl);
                            if (url) {
                                return CQ.img(url);
                            }
                            return null;
                        }).filter(Boolean);
                        replyPixivRatingMsg(illust.id_illust, context, preMsg.join(''), trace);
                    }

                } else if (searchResult.data[0].type === 'danbooru') {
                    // 有pixiv id则发送pixiv
                    if (illust.pixiv_id) {
                        replyDanbooruRatingMsg(illust.id_danbooru, context, `原图：https://www.pixiv.net/artworks/${illust.pixiv_id}`, true, trace);
                    } else {
                        replyDanbooruRatingMsg(illust.id_danbooru, context, `原图：${illust.source}`, true, trace);
                    }

                    if (illust.large_file_url) {
                        if (illust.large_file_url.startsWith('https://cdn.donmai.us/')) {
                            try {
                                const Rvhost = global.config.reverseProxy;
                                // 如果 reverseProxy 为空，则直接使用原始 URL
                                const url = Rvhost ? `${Rvhost}/${illust.large_file_url}` : illust.large_file_url;

                                try {
                                    // 使用 Rvhost URL，启用多代理轮询，但禁用URL直发兜底以便在此处进行URL切换重试
                                    const imgCQ = await downloadImage(url, context, { useNetworkProxy: !!Rvhost, allowUrlFallback: false });
                                    await sendImgWithAntiShieldFallback(imgCQ, illust.large_file_url, illust.id_danbooru, context, false, trace);
                                } catch (error) {
                                    // 如果使用Rvhost失败，则尝试不使用Rvhost直接请求（使用原始URL）
                                    console.warn('图片下载 - Rvhost URL 失败，尝试原始URL:', error.message);
                                    const imgCQ = await downloadImage(illust.large_file_url, context, { useNetworkProxy: false, allowUrlFallback: true });
                                    await sendImgWithAntiShieldFallback(imgCQ, illust.large_file_url, illust.id_danbooru, context, false, trace);
                                }
                            } catch (error) {
                                console.error('图片下载 - Danbooru 下载失败:', error);
                            }
                        } else {
                            try {
                                await sendImgWithAntiShieldFallback(await CQ.imgPreDl(illust.large_file_url), illust.large_file_url, illust.id_danbooru, context, false, trace);
                            } catch (error) {
                                console.error('图片下载 - Danbooru 预下载失败:', error);
                            }
                        }
                    }
                }
            } else {
                // 没有找到作品，但保存 trace 信息以便用户通过 /trace 查看
                replyNoResultMsg(context, `没找到这样的作品呢，请老师多多投稿哟~`, trace);
            }
        }
    }).catch(error => {
        console.error('搜索 - commonSearch 发送消息失败：', error);
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
        console.log('推本 - 搜索关键词:', keyword);

        // 调用新的API接口
        const apiContext = await getApiContext(context);
        // 不传 use_exhentai，启用中文优先四级回退策略
        const response = await koharuAxios.post('/api/ehentai/search-and-add', {
            keyword,
            ...apiContext
        });

        const result = response.data;

        if (result.action === 'added') {
            // 成功自动入库
            const gallery = result.data.gallery;
            const searchStrategy = result.data.search_strategy || '';
            const rating = gallery.realRating || gallery.rating || 0;
            let msg = `${gallery.rawTitle}\n好书收录📚 ！${rating}⭐ ${gallery.pageCount}P`;

            if (searchStrategy) {
                msg += ` [${searchStrategy}]`;
            }
            msg += `:`;

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

                msg += `\n${commentsToShow.map(comment => `-${comment}`).join('\n')}`;
            }

            // 先发送封面图
            if (gallery.cover && gallery.cover.url) {
                try {
                    const coverCQ = await CQ.imgPreDl(gallery.cover.url);
                    await global.replyMsg(context, coverCQ, false, false);
                } catch (e) {
                    console.warn('推本 - 封面图下载失败，跳过:', e.message);
                }
            }

            // 发送主消息（无论有无评论都必须发送）
            console.log('推本 - 结果: 返回消息长度:', msg.length);
            const ret = await global.replyMsg(context, msg, false, true);
            console.log('推本 - 发送结果:', ret);
            if (ret?.retcode === 1200) {
                console.warn('推本 - 发送结果: 发送失败，可能被禁言或群组被禁言');
                const ret1 = await global.replyMsg(context, `好书收录📚 ！${rating}⭐ ${gallery.pageCount}P:\n${gallery.rawTitle}\n`, false, true);
                console.log('推本 - 发送结果: 分步结果1', ret1);
            }


        } else if (result.action === 'select') {
            // 需要用户选择（所有回退策略均无唯一结果）
            const galleries = result.data.galleries;
            if (!galleries || galleries.length === 0) {
                const strategy = result.search_strategy || result.data?.search_strategy || '';
                const hint = strategy ? `（已尝试: ${strategy}）` : '';
                global.replyMsg(context, `没有找到相关结果，请尝试其他关键词${hint}`, false, true);
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
        console.error('推本 - 功能出错:', error);
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
        const apiContext = await getApiContext(context);
        // 使用 search-and-add 接口处理 URL（支持直接收录 + 中文优先搜索）
        const response = await koharuAxios.post('/api/ehentai/search-and-add', {
            keyword: link,
            ...apiContext
        });

        const result = response.data;

        if (result.action === 'added') {
            const gallery = result.data.gallery || {};
            const rating = gallery.realRating || gallery.rating || 0;
            let msg = result.message || '收藏成功';

            if (gallery.rawTitle) {
                msg += `\n${gallery.rawTitle}`;
            } else if (result.data && result.data.title) {
                msg += `\n${result.data.title}`;
            }

            if (rating) {
                msg += `\n评分：${rating}⭐`;
            }

            if (gallery.pageCount) {
                msg += `  ${gallery.pageCount}P`;
            }

            msg += `\n链接：${link}`;

            // 发送封面图
            if (gallery.cover && gallery.cover.url) {
                try {
                    const coverCQ = await CQ.imgPreDl(gallery.cover.url);
                    await global.replyMsg(context, coverCQ, false, false);
                } catch (e) {
                    console.warn('收藏 - 封面图下载失败，跳过:', e.message);
                }
            }
            global.replyMsg(context, msg, false, true);
        } else {
            // 回退到基础 add 接口
            const addResponse = await koharuAxios.post('/api/ehentai/add', {
                url: link,
                ...apiContext
            });
            const addResult = addResponse.data;
            const addData = addResult.data || {};
            let msg = addResult.message || '收藏完成';
            if (addData.title) {
                msg += `\n${addData.title}`;
            }
            msg += `\n链接：${link}`;
            global.replyMsg(context, msg, false, true);
        }
        return true;
    } catch (error) {
        console.error('收藏 - EhentaiSelect 添加画廊失败:', error);
        if (error.response && error.response.data && error.response.data.message) {
            global.replyMsg(context, `添加失败: ${error.response.data.message}`, false, true);
        } else {
            global.replyMsg(context, '添加画廊功能暂时不可用，请稍后再试', false, true);
        }
        return true;
    }
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
                    console.error('声音回复 - collectReply 获取语音文件失败:', error);
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
                console.error('声音回复 - limitedReply 获取语音文件失败:', error);
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
        console.log('标签处理 - 处理并播放语音，tags:', tags);
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
        console.error('标签处理 - 处理并播放语音出错:', error);
    }
}

/**
 * 图片搜索存档功能，仅使用saucenao和Iqdb，搜索完一张就立即处理入库
 * @param {Object} context 消息上下文
 * @param {boolean} isFromReply 是否来自引用消息（用于决定是否使用reply模式）
 * @returns {Promise<{hasResult: boolean, failedResults: Array<{index: number, snSimilarity: number|null, iqdbSimilarity: number|null}>}>} 搜索结果对象
 */
export async function ArchivedImg(context, isFromReply = false) {

    // 得到图片链接并搜图
    const msg = context.message;
    const imgs = getImgs(msg);

    const incorrectImgs = _.remove(imgs, ({ url }) => !/^https?:\/\/[^&]+\//.test(url));
    if (incorrectImgs.length) {
        if (global.config.bot.debug) console.warn('图片存档 - 非法图片列表:', incorrectImgs);
        global.replyMsg(context, '部分图片无法获取，请尝试使用其他设备QQ发送', false, true);
    }

    if (!imgs.length) return { hasResult: false, failedResults: [] };

    let hasAnyResult = false; // 是否有任何一张图片成功入库
    const failedResults = []; // 记录所有失败图片的相似度信息

    for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        
        // 如果不是第一张图，等待10秒避免触发限流
        if (i > 0) {
            console.log(`图片存档 - 等待10秒后搜索第 ${i + 1} 张图片`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        console.log(`图片存档 - 开始收藏 ${i + 1}/${imgs.length}:`, img.url);

        // 检查图片比例
        if (
            global.config.bot.stopSearchingHWRatioGt > 0 &&
            !(await checkImageHWRatio(img.url, global.config.bot.stopSearchingHWRatioGt))
        ) {
            console.log('图片存档 - 图片比例不符合要求，跳过');
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
        }

        if (!snRes.success || snRes.lowAcc) {
            useIqdb = true;
            console.log('图片存档 - SauceNAO 低相似度:', snRes.msg);
        } else {
            // Saucenao搜索成功且相似度高，输出结果到控制台
            console.log('图片存档 - SauceNAO 高相似度:', snRes.msg);
            resultUrl = snRes.msg;
        }

        // iqdb
        if (useIqdb) {
            const { ReturnMsg, success: iqdbSuc, isLowAcc, similarity: iqdbSim, asErr } = await IqDB(img.url).catch(asErr => ({ asErr }));
            if (asErr) {
                console.error('图片存档 - IQDB 错误:', asErr);
                logError(asErr);
            } else {
                // 记录 iqdb 相似度（仅在搜索成功时）
                if (iqdbSuc && iqdbSim != null) {
                    iqdbSimilarity = iqdbSim;
                }
                
                const cleanMsg = ReturnMsg.replace(/base64:\/\/[^\]]+/, 'base64://[image_data]');

                if (iqdbSuc && !isLowAcc) {
                    // Iqdb搜索成功且相似度高，输出结果到控制台
                    console.log('图片存档 - IQDB 高相似度:', cleanMsg);
                    resultUrl = ReturnMsg;
                } else {
                    // 优化日志输出，移除base64图像数据
                    console.warn('图片存档 - IQDB 低相似度:', cleanMsg);
                }
            }
        }

        // 搜索完成后立即尝试匹配图站并入库
        if (resultUrl !== "") {
            const illustObj = matchUrlToIllust(resultUrl);
            if (illustObj) {
                console.log(`图片存档 - 匹配到图站 ${i + 1}/${imgs.length}:`, illustObj);
                await processIllustObj(illustObj, context, isFromReply);
                hasAnyResult = true;
            } else {
                // 有搜索结果URL但无法匹配到图站，记录失败
                failedResults.push({ index: i + 1, snSimilarity, iqdbSimilarity });
            }
        } else {
            // 没有搜索结果，记录失败
            failedResults.push({ index: i + 1, snSimilarity, iqdbSimilarity });
        }
    }

    // 返回是否有成功入库的结果，以及所有失败图片的相似度信息
    return { 
        hasResult: hasAnyResult, 
        failedResults 
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
async function processIllustObj(illustObj, context, shouldReply = true) {
    if (illustObj.type === 'pixiv') {
        try {
            const result = await illustAddPixiv(illustObj.id, context);
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
            } else {
                // 构建合并消息（参考Danbooru的实现方式）
                const texts = [];
                texts.push(`${result.message}:${result.author}<${result.title}>\n${result.caption}`);
                
                if (result.isR18) {
                    texts.push('R18？？？  不可以涩涩！ 死刑！');
                    replyPixivRatingMsg(illustObj.id, context, texts.join('\n'));
                } else if (result.meta_single_page) {
                    const url = getSetuUrl(proxy, result.meta_large);
                    if (url) {
                        try {
                            const imgCQ = await CQ.imgPreDl(url);
                            texts.push(imgCQ);
                        } catch (e) {
                            console.error('投稿 - pixiv.meta_single_page 图片预下载失败:', e);
                        }
                    }
                    replyPixivRatingMsg(illustObj.id, context, texts.join('\n'));
                } else if (result.meta_large_pages) {
                    const imgCQs = result.meta_large_pages.map(pageUrl => {
                        const url = getSetuUrl(proxy, pageUrl);
                        if (url) {
                            return CQ.img(url);
                        }
                        return null;
                    }).filter(Boolean);
                    if (imgCQs.length > 0) {
                        texts.push(imgCQs.join(''));
                    }
                    replyPixivRatingMsg(illustObj.id, context, texts.join('\n'));
                } else {
                    // 没有图片信息，只发送文本
                    replyPixivRatingMsg(illustObj.id, context, texts.join('\n'));
                }
                replyCollectReply(context, result);
            }
        } catch (error) {
            handleApiError(error, context, "投稿");
        }
        return true;
    } else if (illustObj.type === 'danbooru') {
        try {
            const result = await illustAddDanbooru(illustObj.id, context);
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
            } else {
                const texts = [];
                if (result.pixiv_id) {
                    texts.push(`${result.message}\n来源：https://www.pixiv.net/artworks/${result.pixiv_id}`);
                } else {
                    texts.push(`${result.message}\n来源：${result.source}`);
                }
                if (result.rating === 'e') {
                    global.replyMsg(context, '是限制级？？ 不可以涩涩！ 死刑！', false, true);
                } else if (result.large_file_url || result.file_url) {
                    const imageUrl = result.large_file_url || result.file_url;
                    try {
                        if (!imageUrl.startsWith('https://cdn.donmai.us/')) {
                            try {
                                const Rvhost = global.config.reverseProxy;
                                const url = Rvhost ? `${Rvhost}/${imageUrl}` : imageUrl;
                                const imgCQ = await downloadImage(url, context, { useNetworkProxy: !!Rvhost, allowUrlFallback: false });
                                await sendImgWithAntiShieldFallback([...texts, imgCQ].join('\n'), imageUrl, illustObj.id, context, shouldReply);
                            } catch (error) {
                                console.warn('图片下载 - Rvhost URL 失败，尝试原始URL:', error.message);
                                const imgCQ = await downloadImage(imageUrl, context, { useNetworkProxy: false, allowUrlFallback: true });
                                await sendImgWithAntiShieldFallback([...texts, imgCQ].join('\n'), imageUrl, illustObj.id, context, shouldReply);
                            }
                        } else {
                            try {
                                const imgCQ = await downloadImage(imageUrl, context, { useNetworkProxy: true, allowUrlFallback: false });
                                await sendImgWithAntiShieldFallback([...texts, imgCQ].join('\n'), imageUrl, illustObj.id, context, shouldReply);
                            } catch (error) {
                                console.warn('图片下载 - 所有方式失败，降级为URL直发:', error.message);
                                const imgCQ = await downloadImage(imageUrl, context, { useNetworkProxy: false, allowUrlFallback: true });
                                await sendImgWithAntiShieldFallback([...texts, imgCQ].join('\n'), imageUrl, illustObj.id, context, shouldReply);
                            }
                        }
                        replyCollectReply(context, result);
                    } catch (e) {
                        console.error('投稿 - 处理出错:', e);
                    }
                } else {
                    try {
                        texts.push('（已收藏）');
                        replyDanbooruRatingMsg(illustObj.id, context, texts.join('\n'), shouldReply);
                        replyCollectReply(context, result);
                    } catch (e) {
                        console.error('投稿 - 处理缺图权限出错:', e);
                    }
                }
            }
        } catch (error) {
            handleApiError(error, context, "投稿");
        }
        return true;
    } else if (illustObj.type === 'ehentai') {
        try {
            const result = await illustAddEhentai(illustObj.url, context);
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
            } else {
                replyEhentaiRatingMsg(illustObj.url, context, `${result.message}\n来源：${illustObj.url}`);
                replyCollectReply(context, result);
            }
        } catch (error) {
            handleApiError(error, context, "投稿");
        }
        return true;
    } else if (illustObj.type === 'nhentai') {
        try {
            const result = await illustAddNhentai(illustObj.gid, context);
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
            } else {
                replyNhentaiRatingMsg(illustObj.gid, context, `${result.message}\n来源：https://nhentai.net/g/${illustObj.gid}/`);
                replyCollectReply(context, result);
            }
        } catch (error) {
            handleApiError(error, context, "投稿");
        }
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
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3);
                console.log(`[EHentai消息] ✓ 发送成功 (message_id: ${msgRet.data.message_id})`);
            } else {
                console.error(`[EHentai消息] ✗ 发送失败 (retcode: ${msgRet?.retcode}, status: ${msgRet?.status})`);
                console.error(`[EHentai消息] 群号: ${context.group_id}, 用户: ${context.user_id}`);
                console.error(`[EHentai消息] 错误信息: ${msgRet?.message}`);
                console.error(`[EHentai消息] 完整返回:`, msgRet);
            }
        }).catch(err => {
            console.error('[EHentai消息] ✗ 发送异常:', err);
        });
}

function replyNhentaiRatingMsg(gid, context, msg) {
    const record = { gid, type: 'nhentai' };
    global.replyMsg(context, msg, false, true)
        .then(msgRet => {
            if (msgRet && msgRet.retcode === 0) {
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3);
                console.log(`[NHentai消息] ✓ 发送成功 (message_id: ${msgRet.data.message_id})`);
            } else {
                console.error(`[NHentai消息] ✗ 发送失败 (retcode: ${msgRet?.retcode}, status: ${msgRet?.status})`);
                console.error(`[NHentai消息] 群号: ${context.group_id}, 用户: ${context.user_id}`);
                console.error(`[NHentai消息] 错误信息: ${msgRet?.message}`);
                console.error(`[NHentai消息] 完整返回:`, msgRet);
            }
        }).catch(err => {
            console.error('[NHentai消息] ✗ 发送异常:', err);
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
 * 格式化追踪信息为 QQ 消息
 * 根据文档 COMMON_SEARCH_API_MANUAL.md 的 Trace 结构
 * 输出格式参考后端日志：
 *   '女仆'(partial) -> direct[zh=运动服〖女仆〗] -> tag[Jersey maid]
 * @param {object} trace 后端返回的 trace 对象
 * @returns {string} 格式化后的消息文本
 */
export function formatTraceMessage(trace) {
    if (!trace) return '未返回具体跟踪信息';
    
    const lines = [];
    
    // 头部信息：query
    const query = trace.original_query || '';
    lines.push(`🔍query: "${query}"`);
    
    // 分词信息（如果有）
    const tokenization = trace.tokenization;
    if (tokenization && tokenization.tokens && tokenization.tokens.length > 0) {
        const tokens = tokenization.tokens;
        lines.push(`tokenization:\n'${tokenization.original_query}'->[${tokens.map(t => `'${t}'`).join(', ')}]`);
    }
    
    // 关键词追踪
    const keywords = trace.keywords || [];
    if (keywords.length > 0) {
        lines.push('trace:');
        for (const kw of keywords) {
            const line = formatKeywordTraceLine(kw);
            if (line) lines.push(line);
        }
    }
    
    // 限制总长度
    let result = lines.join('\n');
    if (result.length > 3990) {
        result = result.substring(0, 3990) + '\n...';
    }
    
    return result;
}

/**
 * 格式化单个关键词追踪行
 * 格式: '关键词'(match_type) -> resolution_type[hit_info] -> tag[display_name]
 * @param {object} kw 关键词追踪对象
 * @returns {string} 格式化后的单行字符串
 */
function formatKeywordTraceLine(kw) {
    const keyword = kw.keyword || '';
    const matchType = kw.match_type || 'partial'; // exact | partial
    const resolution = kw.resolution || {};
    const resolutionType = resolution.type; // direct | alias | not_found
    const matchedTags = resolution.matched_tags || [];
    const aliasInfo = resolution.alias_info;
    
    // 匹配类型标记
    const matchMark = `(${matchType})`;
    
    if (resolutionType === 'not_found') {
        // 未找到: '关键词'(partial) -> not_found
        return `'${keyword}'${matchMark} -> not_found`;
    } else if (resolutionType === 'alias') {
        // 别名匹配: '要闻'(partial) -> alias[要闻] -> tags[脚掌, 脚趾]
        const aliasName = aliasInfo?.alias_name || keyword;
        const tagNames = matchedTags.map(t => t.display_name || t.name);
        return `'${keyword}'${matchMark}->alias[${aliasName}]->tags[${tagNames.join(', ')}]`;
    } else {
        // direct 直接匹配
        // 需要展示 hit_details 中的高亮信息
        // 格式: '女仆'(partial) -> direct[zh=运动服〖女仆〗] -> tag[Jersey maid]
        if (matchedTags.length === 0) {
            return `'${keyword}'${matchMark}->direct->(无匹配标签)`;
        }
        
        // 每个匹配的标签生成一行
        const tagLines = [];
        for (const tag of matchedTags) {
            const hitDetails = tag.hit_details || [];
            const tagDisplay = tag.display_name || tag.name;
            
            if (hitDetails.length > 0) {
                // 有 hit_details，显示第一个命中信息
                const hit = hitDetails[0];
                const field = hit.field || '';
                // 如果有 highlight 则用 highlight，否则用 value
                const value = hit.highlight || hit.value || '';
                tagLines.push(`${keyword}${matchMark}->direct[${field}=${value}]->tag[${tagDisplay}]`);
            } else {
                // 无 hit_details，简单显示
                tagLines.push(`${keyword}${matchMark}->direct->tag[${tagDisplay}]`);
            }
        }
        return tagLines.join('\n    ');
    }
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
 * 回复无结果消息，并缓存 trace 信息以支持 /trace 查看分词结果
 * @param {object} context 上下文对象
 * @param {string} msg 消息内容
 * @param {object} [trace] 搜索追踪信息（可选）
 */
function replyNoResultMsg(context, msg, trace = null) {
    // 使用特殊的 id 和 type 标记无结果消息
    const record = { id: 0, type: 'no_result' };
    if (trace) record.trace = trace;
    
    global.replyMsg(context, msg, false, true)
        .then(msgRet => {
            if (msgRet?.retcode === 0) {
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3);
                console.log(`[无结果消息] ✓ 发送成功，已缓存trace (message_id: ${msgRet.data.message_id})`);
            } else {
                console.error(`[无结果消息] ✗ 发送失败 (retcode: ${msgRet?.retcode}, status: ${msgRet?.status})`);
            }
        })
        .catch(err => {
            console.error('[无结果消息] ✗ 发送异常:', err);
        });
}

/**
 * 回复Pixiv评级消息
 * @param {number} illustId 插画ID
 * @param {object} context 上下文对象
 * @param {string} msg 消息内容
 * @param {object} [trace] 搜索追踪信息（可选）
 */
function replyPixivRatingMsg(illustId, context, msg, trace = null) {
    const record = { id: illustId, type: 'pixiv' };
    if (trace) record.trace = trace;
    global.replyMsg(context, msg, false, false)
        .then(msgRet => {
            if (msgRet?.retcode === 0) {
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3);
                console.log(`[Pixiv消息] ✓ 发送成功 (message_id: ${msgRet.data.message_id})`);
            } else {
                console.error(`[Pixiv消息] ✗ 发送失败 (retcode: ${msgRet?.retcode}, status: ${msgRet?.status})`);
                console.error(`[Pixiv消息] 群号: ${context.group_id}, 用户: ${context.user_id}`);
                console.error(`[Pixiv消息] 错误信息: ${msgRet?.message}`);
                console.error(`[Pixiv消息] 完整返回:`, msgRet);
            }
        })
        .catch(err => {
            console.error('[Pixiv消息] ✗ 发送异常:', err);
        });
}

/**
 * 从 CQ 码字符串中提取本地文件路径
 * @param {string} msg CQ 码字符串
 * @returns {string|null} 本地文件系统路径，找不到返回 null
 */
function extractLocalPathFromCQ(msg) {
    // 匹配 file:// URI: [CQ:image,file=file:///D:/path/to/file]
    const fileUriMatch = msg.match(/\[CQ:image,[^\]]*file=file:\/\/\/([^\],]+)/i);
    if (fileUriMatch) {
        try { return decodeURIComponent(fileUriMatch[1]).replace(/\//g, '\\'); } catch { return null; }
    }
    // 匹配 Windows 绝对路径: [CQ:image,file=D:\path\to\file]
    const winAbsMatch = msg.match(/\[CQ:image,[^\]]*file=([A-Za-z]:[^\],\s]+)/);
    if (winAbsMatch) return winAbsMatch[1];
    return null;
}

/**
 * 发送 Danbooru 图片消息，若 retcode 1200 则对图片进行反和谐处理后重发，仍失败则降级 URL 直发
 * @param {string} msg 完整消息（文字 + 图片 CQ 码）
 * @param {string} fallbackUrl 图片原始 URL（用于降级直发）
 * @param {number} illustId Danbooru 插画 ID
 * @param {object} context 消息上下文
 * @param {boolean} shouldReply 是否使用回复形式
 * @param {object|null} [trace] 搜索追踪信息
 */
async function sendImgWithAntiShieldFallback(msg, fallbackUrl, illustId, context, shouldReply, trace = null) {
    const record = { id: illustId, type: 'danbooru' };
    if (trace) record.trace = trace;
    const saveRecord = (msgRet) => {
        if (msgRet?.retcode === 0) {
            global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3);
            console.log(`[Danbooru消息] ✓ 发送成功 (message_id: ${msgRet.data.message_id})`);
        }
    };

    const ret = await global.replyMsg(context, msg, false, shouldReply);
    if (ret?.retcode === 0) { saveRecord(ret); return; }

    if (ret?.retcode === 1200) {
        console.warn(`[Danbooru消息] retcode 1200 → 尝试反和谐重发 (illustId: ${illustId})`);
        const localPath = extractLocalPathFromCQ(msg);
        if (localPath) {
            try {
                // RAND_MOD_PX = 0b1: 随机微调四角像素 RGB ±1~2，改变文件 hash 但不改变视觉内容
                const base64 = await imgAntiShieldingFromFilePath(localPath, 0b1);
                const antiMsg = msg.replace(/\[CQ:image,[^\]]+\]/, CQ.img64(base64));
                const ret2 = await global.replyMsg(context, antiMsg, false, shouldReply);
                if (ret2?.retcode === 0) { saveRecord(ret2); console.log('[Danbooru消息] ✓ 反和谐重发成功'); return; }
                console.warn('[Danbooru消息] 反和谐重发失败，降级为URL直发');
            } catch (e) {
                console.error('[Danbooru消息] 反和谐处理出错:', e);
            }
        } else {
            console.warn('[Danbooru消息] retcode 1200 但消息中无本地文件路径，直接降级URL直发');
        }
        // 降级：URL 直发
        const fallbackMsg = msg.replace(/\[CQ:image,[^\]]+\]/, CQ.img(fallbackUrl));
        const ret3 = await global.replyMsg(context, fallbackMsg, false, shouldReply);
        if (ret3?.retcode === 0) saveRecord(ret3);
        else console.error(`[Danbooru消息] URL直发也失败 (retcode: ${ret3?.retcode})`);
    } else {
        console.error(`[Danbooru消息] ✗ 发送失败 (retcode: ${ret?.retcode}, status: ${ret?.status})`);
        console.error(`[Danbooru消息] 群号: ${context.group_id}, 用户: ${context.user_id}`);
        console.error(`[Danbooru消息] 错误信息: ${ret?.message}`);
        console.error('[Danbooru消息] 完整返回:', ret);
    }
}

/**
 * 回复Danbooru评级消息
 * @param {number} illustId 插画ID
 * @param {object} context 上下文对象
 * @param {string} msg 消息内容
 * @param {boolean} reply 是否使用回复形式
 * @param {object} [trace] 搜索追踪信息（可选）
 */
function replyDanbooruRatingMsg(illustId, context, msg, reply = true, trace = null) {
    const record = { id: illustId, type: 'danbooru' };
    if (trace) record.trace = trace;
    global.replyMsg(context, msg, false, reply)
        .then(msgRet => {
            if (msgRet?.retcode === 0) {
                global.setKeyObject(`RtMsg:${context.group_id}:${msgRet.data.message_id}`, record, 60 * 60 * 24 * 3);
                console.log(`[Danbooru消息] ✓ 发送成功 (message_id: ${msgRet.data.message_id})`);
            } else {
                console.error(`[Danbooru消息] ✗ 发送失败 (retcode: ${msgRet?.retcode}, status: ${msgRet?.status})`);
                console.error(`[Danbooru消息] 群号: ${context.group_id}, 用户: ${context.user_id}`);
                console.error(`[Danbooru消息] 错误信息: ${msgRet?.message}`);
                console.error(`[Danbooru消息] 完整返回:`, msgRet);
            }
        })
        .catch(err => {
            console.error('[Danbooru消息] ✗ 发送异常:', err);
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
 * 统一的图片下载函数（带完整降级链）
 * 
 * 降级链：
 * 1. pximgProxy URL转换（始终生效，不降级）
 * 2. 多代理轮询下载（在 axiosProxy.download 内部实现）
 * 3. 直连下载（在 axiosProxy.download 内部实现）
 * 4. URL直发（CQ.img 兜底）
 * 
 * @param {string} url - 图片URL
 * @param {object} context - 上下文对象
 * @param {object} options - 配置选项
 * @param {boolean} [options.useNetworkProxy=true] - 是否使用网络代理（启用多代理轮询+直连降级）
 * @param {boolean} [options.allowUrlFallback=true] - 是否允许URL直发兜底
 * @returns {Promise<string>} CQ码格式的图片
 */
async function downloadImage(url, context, options = {}) {
    const { 
        useNetworkProxy = true,
        allowUrlFallback = true 
    } = options;
    
    let targetUrl = url;
    const host = new URL(url).hostname;

    // 【Layer 0】pximgProxy URL域名替换 - 始终应用于 i.pximg.net，不降级
    if (/^https?:\/\/i\.pximg\.net\//.test(url)) {
        const proxyUrl = getSetuUrl(proxy, url);
        if (proxyUrl) {
            targetUrl = proxyUrl;
            console.log(`[图片下载] Pixiv URL 代理转换: ${host} -> ${new URL(targetUrl).hostname}`);
        }
    }

    // 【Layer 1-2】尝试下载（多代理轮询 + 直连，在 axios.download 内部实现）
    try {
        console.log(`[图片下载] 开始下载: ${new URL(targetUrl).hostname}${new URL(targetUrl).pathname.substring(0, 50)}...`);
        const response = await axios.download(targetUrl, { useProxy: useNetworkProxy });
        const filepath = createCache(url, Buffer.from(response.data));
        console.log(`[图片下载] ✓ 成功缓存 (${filepath}, 大小: ${response.data.length} bytes)`);
        return CQ.img(filepath);
    } catch (error) {
        const errorMsg = error.message || String(error);
        console.error(`[图片下载] ✗ 下载失败: ${errorMsg}`);
        
        // 【Layer 3】URL直发兜底
        if (allowUrlFallback) {
            console.warn(`[图片下载] 降级为URL直发: ${targetUrl.substring(0, 80)}...`);
            return CQ.img(targetUrl);
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
    console.error('书库 - API 错误处理:', error);
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
