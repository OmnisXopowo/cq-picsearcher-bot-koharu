import Axios from 'axios';
import _ from 'lodash-es';
import { getImgs, hasImage } from '../index.mjs';
import axios from '../utils/axiosProxy.mjs';
import { createCache } from '../utils/cache.mjs';
import { CooldownManager } from '../utils/CooldownManager.mjs';
import CQ from '../utils/CQcode.mjs';
import dailyCountInstance from '../utils/dailyCount.mjs';
import { getGroupName } from '../utils/groupInfoCache.mjs';
import { checkImageHWRatio } from '../utils/image.mjs';
import { imgAntiShieldingFromFilePath } from '../utils/imgAntiShielding.mjs';
import logError from '../utils/logError.mjs';
import { getRawMessage } from '../utils/message.mjs';
import { getKeyObject, setKeyObject, buildRedisKey, buildRedisKeyPattern } from '../utils/redisClient.mjs';
import voiceManager from '../voicesBank/VoiceManager.mjs';
import IqDB from './iqdb.mjs';
import { getLocalReverseProxyURL } from './pximg.mjs';
import saucenao, { snDB } from './saucenao.mjs';

// Koharu API 专用 axios 实例
const koharuApiBaseUrl = global.config.bot.koharuApiBaseUrl || 'http://127.0.0.1:5000';
const koharuApiToken = global.config.bot.koharuApiToken || '';
const koharuAxios = Axios.create({
    baseURL: koharuApiBaseUrl,
    headers: koharuApiToken ? { 'Authorization': `Bearer ${koharuApiToken}` } : {}
});

// E-Hentai Cookie 配置
const exhentaiIpbMemberId = global.config.bot.exhentaiIpbMemberId || '';
const exhentaiIpbPassHash = global.config.bot.exhentaiIpbPassHash || '';
const exhentaiIgneous = global.config.bot.exhentaiIgneous || '';

// E-Hentai 专用 axios 实例（用于访问 exhentai.org 和 e-hentai.org 的图片）
const exhentaiAxios = Axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
});

// 如果配置了 E-Hentai cookies，则添加到请求头
if (exhentaiIpbMemberId && exhentaiIpbPassHash) {
    exhentaiAxios.defaults.headers.common.Cookie = 
        `ipb_member_id=${exhentaiIpbMemberId}; ` +
        `ipb_pass_hash=${exhentaiIpbPassHash}` +
        (exhentaiIgneous ? `; igneous=${exhentaiIgneous}` : '');
    console.log('[E-Hentai] Cookie 已配置');
}

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
 * @returns {Promise<{group_id: number, qq_id: number, display_name: string|undefined, group_name: string|undefined}>}
 */
async function getApiContext(context) {
    const groupName = context.group_id ? await getGroupName(context.group_id, context.self_id) : undefined;
    return {
        group_id: context.group_id ?? 0,
        qq_id: context.user_id,
        display_name: getDisplayName(context),
        group_name: groupName
    };
}

function summarizeLogValue(value, maxLength = 96) {
    if (value == null || value === '') {
        return 'none';
    }

    const normalized = String(value)
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) {
        return 'none';
    }

    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function unwrapKoharuApiPayload(response, endpoint) {
    const payload = response?.data;

    if (!payload || typeof payload !== 'object') {
        return payload ?? null;
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'success')) {
        return payload;
    }

    if (!payload.success) {
        const message = payload.user_message || payload.message || payload.error || 'unknown_error';
        console.warn(`[Koharu API] ${endpoint} 返回 success=false: ${summarizeLogValue(message, 100)}`);
        return null;
    }

    return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

/**
 * 判断是否为管理员私聊场景
 * @param {object} context 消息上下文
 * @returns {boolean}
 */
function isAdminPrivateChat(context) {
    return context.message_type === 'private'
        && global.config.bot.admin
        && context.user_id === global.config.bot.admin;
}

/**
 * 构建批量收藏汇总消息（仅供管理员私聊使用）
 * @param {Array<{index: number, status: string, type?: string, detail?: string, snSimilarity?: number, iqdbSimilarity?: number}>} detailedResults
 * @returns {string|null} 汇总消息文本，全部成功时返回 null
 */
function buildBatchSummary(detailedResults) {
    if (!detailedResults || detailedResults.length === 0) return null;

    const total = detailedResults.length;
    const successCount = detailedResults.filter(r => r.status === 'success').length;
    const hasNonSuccess = detailedResults.some(r => r.status !== 'success');

    if (!hasNonSuccess) return null;

    const lines = [`📊 批量收藏报告 (${successCount}/${total} 成功)`];

    for (const r of detailedResults) {
        const acc = [];
        if (r.snSimilarity != null) acc.push(`Acc1:${Math.round(r.snSimilarity)}`);
        if (r.iqdbSimilarity != null) acc.push(`Acc2:${Math.round(r.iqdbSimilarity)}`);
        const accStr = acc.length > 0 ? ` ${acc.join(' ')}` : '';

        switch (r.status) {
            case 'success':
                lines.push(`✅ [${r.index}] ${r.type || '未知'} 入库成功`);
                break;
            case 'api_error':
                lines.push(`⚠️ [${r.index}] ${r.type || '未知'}: ${r.detail || '处理异常'}${accStr}`);
                break;
            case 'queued':
                lines.push(`⏳ [${r.index}] 后台队列${accStr}`);
                break;
            case 'archived':
                lines.push(`📦 [${r.index}] 已归档${accStr}`);
                break;
            case 'archive_failed':
                lines.push(`❌ [${r.index}] 归档失败${accStr}`);
                break;
            case 'skipped':
                lines.push(`⏭️ [${r.index}] ${r.detail || '已跳过'}`);
                break;
            default:
                lines.push(`❓ [${r.index}] ${r.status}${accStr}`);
        }
    }

    const archivedCount = detailedResults.filter(r => r.status === 'archived' || r.status === 'queued').length;
    if (archivedCount > 0) {
        lines.push(`📦 归档/队列: ${archivedCount}张`);
    }

    return lines.join('\n');
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
    let archiveResult = null;
    
    if (hasImage(context.message)) {
        // 图片搜索和入库在 ArchivedImg 中完成
        archiveResult = await ArchivedImg(context, isFromReply);
        isImg = true;
        
        // 如果有成功入库的结果，直接返回 true（已处理完成）
        if (archiveResult && archiveResult.hasResult) {
            // 管理员私聊：如果有任何非 success 的图片，追加汇总报告
            if (isAdminPrivateChat(context) && archiveResult.detailedResults?.length > 1) {
                const summary = buildBatchSummary(archiveResult.detailedResults);
                if (summary) {
                    global.replyMsg(context, summary, false, true);
                }
            }
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
        // 管理员私聊：使用增强格式的汇总报告
        if (isAdminPrivateChat(context) && archiveResult?.detailedResults?.length > 0) {
            const summary = buildBatchSummary(archiveResult.detailedResults);
            if (summary) {
                global.replyMsg(context, summary, false, true);
            } else {
                // 全部成功但 hasResult 为 false（不应该发生，兆底）
                global.replyMsg(context, `未搜索到收录图站`, false, true);
            }
        } else {
            // 非管理员/非私聊：保持原有行为
            let notFoundMsg = `未搜索到收录图站`;
            
            // 如果有图片已提交到归档队列，追加提示
            const queuedCount = archiveResult?.queuedCount || 0;
            if (queuedCount > 0) {
                notFoundMsg += `（已提交${queuedCount}张至归档队列）`;
            }
            
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


/**
 * 提交失败的搜索任务到后端归档队列（两阶段协议）
 * 
 * 阶段 1: 发送 image_url + local_path（不含 base64）
 * 阶段 2: 如果阶段 1 返回 needs_retry_with_base64=true，携带 base64 重试
 * 
 * @param {MsgImage} img - 图片对象
 * @param {object} context - 消息上下文
 * @param {object} options - 额外信息
 * @param {object|null} options.searchResults - 搜索引擎返回的原始数据
 * @param {string|null} options.lastErrorType - 失败的错误类型
 * @param {string|null} options.lastErrorMessage - 失败的错误消息
 * @returns {Promise<{success: boolean, queue_id?: number}>}
 */
async function submitToArchiveQueue(img, context, options = {}) {
    const { searchResults = null, lastErrorType = null, lastErrorMessage = null } = options;
    
    try {
        const apiContext = await getApiContext(context);
        const localPath = await img.getPath().catch((e) => {
            console.warn(`[图片归档] getPath 失败 (file=${img.file}):`, e?.message || e);
            return undefined;
        });
        const urlSummary = summarizeLogValue(img.url, 88);
        
        // 阶段 1: URL + local_path
        const payload = {
            image_url: img.url,
            source_site: 'qq_cdn',
            image_local_path: localPath || null,
            search_results_json: searchResults,
            last_error_type: lastErrorType,
            last_error_message: lastErrorMessage,
            qq_id: apiContext.qq_id,
            group_id: apiContext.group_id,
            display_name: apiContext.display_name,
            group_name: apiContext.group_name,
        };

        console.log(
            `[图片归档] 提交归档队列: qq=${apiContext.qq_id} group=${apiContext.group_id} ` +
            `local_path=${localPath ? 'yes' : 'no'} error_type=${lastErrorType || 'none'} url=${urlSummary}`
        );
        
        const response = await koharuAxios.post('/api/image-archive/queue', payload);
        const result = response.data;

        console.log(
            `[图片归档] 阶段1响应: status=${result?.status || 'unknown'} ` +
            `queue_id=${result?.queue_id ?? 'none'} cached=${result?.image_cached === true} ` +
            `needs_base64=${result?.needs_retry_with_base64 === true}`
        );
        
        // 阶段 2: 如果后端无法缓存图片，携带 base64 重试
        if (result.needs_retry_with_base64) {
            console.log(`[图片归档] 阶段1缓存失败，开始 base64 重试: url=${urlSummary}`);
            try {
                // 通过 local_path 读取文件或通过 URL 下载
                const MAX_BASE64_FILE_SIZE = 20 * 1024 * 1024; // 20MB 上限
                let base64Data = null;
                const imgPath = localPath || await img.getPath().catch((e) => {
                    console.warn(`[图片归档] base64 重试 getPath 失败 (file=${img.file}):`, e?.message || e);
                    return null;
                });
                if (imgPath) {
                    const { readFileSync, statSync } = await import('fs');
                    const fileSize = statSync(imgPath).size;
                    if (fileSize > MAX_BASE64_FILE_SIZE) {
                        console.warn(`图片归档 - 文件过大，跳过 base64 重试: ${fileSize} bytes`);
                        return result;
                    }
                    base64Data = readFileSync(imgPath).toString('base64');
                } else if (img.isUrlValid) {
                    const dlResp = await axios.get(img.url, { responseType: 'arraybuffer', timeout: 30000 });
                    if (dlResp.data.byteLength > MAX_BASE64_FILE_SIZE) {
                        console.warn(`图片归档 - 下载文件过大，跳过 base64 重试: ${dlResp.data.byteLength} bytes`);
                        return result;
                    }
                    base64Data = Buffer.from(dlResp.data).toString('base64');
                }
                if (base64Data) {
                    console.log(`[图片归档] 发送 base64 重试: queue_id=${result?.queue_id ?? 'none'} url=${urlSummary}`);
                    const retryPayload = {
                        ...payload,
                        image_base64: base64Data,
                    };
                    const retryResponse = await koharuAxios.post('/api/image-archive/queue', retryPayload);
                    console.log(
                        `[图片归档] base64 重试完成: status=${retryResponse.data?.status || 'unknown'} ` +
                        `queue_id=${retryResponse.data?.queue_id ?? 'none'} cached=${retryResponse.data?.image_cached === true}`
                    );
                    return retryResponse.data;
                }
                console.warn(`[图片归档] 无法生成 base64 重试数据: url=${urlSummary}`);
            } catch (retryErr) {
                console.warn('图片归档 - base64 重试失败:', retryErr.message || retryErr);
                return result;
            }
        }
        
        if (!result?.success || (!result?.queue_id && result?.status !== 'duplicate')) {
            console.warn(
                `[图片归档] 队列响应异常: status=${result?.status || 'unknown'} ` +
                `queue_id=${result?.queue_id ?? 'none'} message=${summarizeLogValue(result?.message, 80)}`
            );
        } else {
            console.log(`图片归档 - 已提交到队列: id=${result.queue_id} cached=${result.image_cached}`);
        }
        return result;
    } catch (error) {
        const status = error.response?.status || 'network';
        const message = error.response?.data?.user_message || error.response?.data?.message || error.message || error;
        console.error(`[图片归档] 提交失败: status=${status} message=${summarizeLogValue(message, 100)}`);
        return { success: false };
    }
}


/**
 * 成功入库后提交图片到缓存系统（SSIM 校验 + S3 同步）
 * 
 * @param {MsgImage|null} img - QQBot 图片对象（可选，URL 入库时无图片）
 * @param {string} linkedRecordType - 关联记录类型: illust_collection / danbooru_collection
 * @param {number|string} linkedRecordId - 关联记录 ID
 * @param {object} context - 消息上下文
 * @param {string|null} sourceImageUrl - 来源全尺寸图片 URL（由 /add 端点返回，直接传入可跳过 DB 查询）
 */
async function submitImageCacheAfterAdd(img, linkedRecordType, linkedRecordId, context, sourceImageUrl = null) {
    // URL 入库没有图片对象，跳过
    if (!img) return;

    try {
        const apiContext = await getApiContext(context);
        const localPath = await img.getPath().catch((e) => {
            console.warn(`[图片缓存] getPath 失败 (file=${img.file}):`, e?.message || e);
            return undefined;
        });

        // 验证 sourceImageUrl 有效性
        const normalizedSourceUrl = (sourceImageUrl && typeof sourceImageUrl === 'string' && sourceImageUrl.startsWith('http'))
            ? sourceImageUrl
            : null;

        const payload = {
            image_url: img.url,
            source_site: 'qq_cdn',
            image_local_path: localPath || null,
            linked_record_type: linkedRecordType,
            linked_record_id: typeof linkedRecordId === 'string' ? parseInt(linkedRecordId) : linkedRecordId,
            source_image_url: normalizedSourceUrl,
            qq_id: apiContext.qq_id,
            group_id: apiContext.group_id,
        };

        console.log(
            `[图片缓存] 开始提交: type=${linkedRecordType} id=${linkedRecordId} ` +
            `source_url=${normalizedSourceUrl ? summarizeLogValue(normalizedSourceUrl, 88) : 'none'}`
        );

        const response = await koharuAxios.post('/api/image-cache/submit', payload);
        const result = response.data;
        console.log(
            `[图片缓存] 提交完成: cache_key=${result.cache_key} ssim=${result.ssim_score} ` +
            `passed=${result.ssim_passed} role=${result.image_role || 'unknown'}`
        );
    } catch (error) {
        // 缓存提交失败不影响入库结果，但需要输出详细错误
        const status = error?.response?.status;
        const detail = error?.response?.data?.error || error?.response?.data?.message || '';
        console.error(
            `[图片缓存] 提交失败 (HTTP ${status || 'N/A'}): ${error.message || error}` +
            (detail ? ` | detail: ${detail}` : '')
        );
    }
}


/**
 * 内存缓存：60 秒内同一用户跳过重复 pending 查询
 * key: qq_id, value: 上次查询的时间戳
 */
const _pendingCheckCache = new Map();
const PENDING_CHECK_INTERVAL_MS = 60_000;

/**
 * 检查是否有待通知的异步搜索结果，有则发送并标记已通知
 * @param {Object} context 消息上下文
 * @returns {Promise<number>} 通知的结果数
 */
async function checkAndNotifyPendingResults(context) {
    try {
        const apiContext = await getApiContext(context);
        if (apiContext.qq_id == null) return 0;

        // 60 秒内同一用户跳过查询
        const lastCheck = _pendingCheckCache.get(apiContext.qq_id);
        if (lastCheck && Date.now() - lastCheck < PENDING_CHECK_INTERVAL_MS) return 0;
        _pendingCheckCache.set(apiContext.qq_id, Date.now());

        let response;
        try {
            response = await koharuAxios.get('/api/image-archive/pending-notifications', {
                params: { qq_id: apiContext.qq_id, limit: 5 },
            });
        } catch (httpError) {
            // HTTP 失败时清除缓存，确保下次请求可以重试
            _pendingCheckCache.delete(apiContext.qq_id);
            throw httpError;
        }
        const results = response.data?.data;
        if (!results || !results.length) return 0;

        // 构建通知消息
        const lines = [`📦 你有 ${results.length} 个搜索结果:`];
        const queueIds = [];
        for (const r of results) {
            queueIds.push(r.id);
            const source = r.matched_source || '未知';
            const itemId = r.matched_item_id || '';
            const status = r.status === 'completed' ? '✅' : '❌';
            const sim = r.ssim_score != null ? ` (SSIM ${(r.ssim_score * 100).toFixed(1)}%)` : '';
            const credit = r.credit_awarded ? ' +1积分' : '';
            lines.push(`${status} ${source}/${itemId}${sim}${credit}`);
        }
        global.replyMsg(context, lines.join('\n'), false, true);

        // 标记已通知
        await koharuAxios.post('/api/image-archive/mark-notified', {
            qq_id: apiContext.qq_id,
            queue_ids: queueIds,
        });
        return results.length;
    } catch (error) {
        console.warn('通知检查失败（不影响收藏）:', error.message || error);
        return 0;
    }
}


/**
 * 当 QQBot 搜索失败时，调用 Flask 后端搜索作为后备（过渡阶段）
 * @param {string} imageUrl 图片 URL
 * @param {string|null} localPath 本地文件路径
 * @returns {Promise<Object|null>} 搜索结果或 null
 */
async function fallbackToBackendSearch(imageUrl, localPath, context = null) {
    const urlSummary = summarizeLogValue(imageUrl, 88);
    const qqId = context?.user_id ?? 'unknown';
    const groupId = context?.group_id ?? 0;

    console.log(
        `[图片回退] 请求 Flask 搜索: qq=${qqId} group=${groupId} ` +
        `local_path=${localPath ? 'yes' : 'no'} url=${urlSummary}`
    );

    try {
        const response = await koharuAxios.post('/api/image-search/search', {
            image_url: imageUrl,
            original_image_path: localPath || undefined,
            qq_id: context?.user_id,
            group_id: context?.group_id ?? 0,
        });

        const result = unwrapKoharuApiPayload(response, '/api/image-search/search');

        if (!result || typeof result !== 'object') {
            console.warn(`[图片回退] Flask 搜索返回空载荷: url=${urlSummary}`);
            return { empty: true, reason: 'empty_payload' };
        }

        const resultStatus = result.status || (result.title && result.title !== 'No results found' ? 'matched' : 'empty');
        console.log(
            `[图片回退] Flask 搜索响应: status=${resultStatus} ` +
            `title=${summarizeLogValue(result.title, 48)} source=${summarizeLogValue(result.source_url, 88)}`
        );

        // 后端返回 queued 状态表示搜索降级为异步
        if (result?.status === 'queued') {
            return { queued: true, queue_id: result.queue_id, result };
        }
        // 后端搜索有结果且标题有效
        if (result?.title && result.title !== 'No results found') {
            const sourceUrl = result.source_url || '';
            const illustObj = matchUrlToIllust(sourceUrl);
            if (illustObj) {
                return { matched: true, illustObj, result };
            }
            console.warn(`[图片回退] Flask 命中结果但无法映射图站: source=${summarizeLogValue(sourceUrl, 88)}`);
            return { empty: true, reason: 'unmatched_source_url', result };
        }
        const reason = result?.message || 'no_result';
        console.log(`[图片回退] Flask 搜索未命中: reason=${summarizeLogValue(reason, 72)}`);
        return { empty: true, reason, result };
    } catch (error) {
        const status = error.response?.status || 'network';
        const message = error.response?.data?.user_message || error.response?.data?.message || error.message || error;
        console.warn(`[图片回退] Flask 搜索失败: status=${status} message=${summarizeLogValue(message, 100)} url=${urlSummary}`);
        return { error: true, message, statusCode: error.response?.status ?? null };
    }
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
            global.replyMsg(context, result.data.error, false, true);
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

        const cooldownKey = buildRedisKey('foot_cooldown', context.self_id, context.group_id, context.user_id);
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

    const setuCooldownKey = buildRedisKey('setu', context.self_id, context.group_id, context.user_id);
    const isOverLimit = await cooldownManager.SlidingWindowCooldown(setuCooldownKey, 60, 3);
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
                    } else if (illust.meta_single_page) {
                        sendImg = illust.meta_single_page;
                    } else if (illust.meta_large) {
                        sendImg = illust.meta_large;
                    }
                    const titleStr = searchResult.data.title ? `${searchResult.data.title}\n` : '';

                    if (RndIndex === -1) {
                        preSendMsgs.push(`${titleStr}原图：https://pixiv.net/i/${illust.id_illust}`);
                        const sendUrls = [];
                        if (setting.sendPximgProxies.length) {
                            for (const imgProxy of setting.sendPximgProxies) {
                                const imgUrl = getSetuUrl(imgProxy, sendImg);
                                if (imgUrl) {
                                    sendUrls.push(imgUrl);
                                }
                            }
                        }

                        if (sendUrls.length === 1) preSendMsgs.push(`代理：${sendUrls[0]}`);
                        else if (sendUrls.length > 1) preSendMsgs.push('代理：', ...sendUrls);

                        replyPixivRatingMsg(illust.id_illust, context, preSendMsgs.join('\n'), trace);

                        const requestUrl = getPixivRequestUrl(sendImg);
                        if (requestUrl) {
                            console.log(
                                `[Pixiv发送] 搜索结果单图预下载: illust=${illust.id_illust} ` +
                                `url=${summarizeLogValue(requestUrl, 120)}`
                            );
                            replyPixivRatingMsg(illust.id_illust, context, await CQ.imgPreDl(requestUrl), trace);
                        }
                    }
                    else {
                        preSendMsgs.push(`${titleStr}原图集：https://pixiv.net/i/${illust.id_illust}`);
                        replyPixivRatingMsg(illust.id_illust, context, preSendMsgs.join('\n'), trace);

                        const preMsg = illust.meta_large_pages.map(pageUrl => {
                            const url = getPixivRequestUrl(pageUrl);
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
        else if (error.response.data?.user_message) {
            global.replyMsg(context, error.response.data.user_message, false, true);
        }
        else if (error.response.data?.message) {
            global.replyMsg(context, error.response.data.message, false, true);
        }
        else if (error.response.status === 400) {
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
    const rawInput = CQ.unescape(context.message.replace('/推本', '').replace('/tb', '').trim());
    
    // 检测 --SFW 或 --sfw 参数
    const sfwRegex = /\s*--[Ss][Ff][Ww]\s*$/;
    const shouldSendCover = sfwRegex.test(rawInput);
    
    // 从关键词中移除 --SFW 参数
    const keyword = rawInput.replace(sfwRegex, '').trim();

    // 如果没有关键词，提示用户输入
    if (!keyword) {
        global.replyMsg(context, '请输入要搜索的关键词，例如：/推本+只属于老师的捣蛋鬼 或 /推本+只属于老师的捣蛋鬼 --sfw（添加--sfw参数可显示封面图）', false, true);
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
            let msg = `${gallery.rawTitle}\n好书收录📚 ！${rating}⭐ ${gallery.pageCount}P：`;

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

            // 发送主消息（无论有无评论都必须发送）
            console.log('推本 - 结果: 返回消息长度:', msg.length);
            const ret = await global.replyMsg(context, msg, false, true);
            console.log('推本 - 发送结果:', ret);
            if (ret?.retcode === 1200) {
                console.warn('推本 - 发送结果: 发送失败，可能被禁言或群组被禁言');
                const ret1 = await global.replyMsg(context, `好书收录📚 ！${rating}⭐ ${gallery.pageCount}P:\n${gallery.rawTitle}\n`, false, true);
                console.log('推本 - 发送结果: 分步结果1', ret1);
            }

            // 异步发送封面图，不阻塞主消息发送
            if (shouldSendCover && gallery.cover && gallery.cover.url) {
                (async () => {
                    try {
                        const coverCQ = await CQ.imgPreDl(gallery.cover.url);
                        await global.replyMsg(context, coverCQ, false, false);
                        console.log('推本 - 封面图异步发送完成');
                    } catch (e) {
                        console.warn('推本 - 封面图下载失败，跳过:', e.message);
                    }
                })();
            }


        } else if (result.action === 'error') {
            // 后端返回结构化错误（ip_banned / sad_panda / quota_exceeded 等）
            const userMessage = result.user_message || result.message || '搜索失败，请稍后重试';
            global.replyMsg(context, userMessage, false, true);
            return true;

        } else if (result.action === 'select') {
            // 需要用户选择（所有回退策略均无唯一结果）
            const galleries = result.data.galleries;
            if (!galleries || galleries.length === 0) {
                const strategy = result.search_strategy || result.data?.search_strategy || '';
                const hints = result.hints || result.data?.hints || [];
                let msg = '没有找到相关结果';
                if (strategy) {
                    msg += `（已尝试: ${strategy}）`;
                }
                if (hints.length > 0) {
                    msg += '\n💡 ' + hints.join('\n💡 ');
                } else {
                    msg += '，请尝试其他关键词';
                }
                global.replyMsg(context, msg, false, true);
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
                const cacheKey = buildRedisKey('tbSelect', context.self_id, context.group_id, msgRet.data.message_id);
                await setKeyObject(cacheKey, {
                    galleries,
                    userId: context.user_id,
                    context,
                    shouldSendCover
                }, 60 * 60 * 24 * 3); // 3天过期，与评分功能保持一致
            }
        } else {
            // 未知的action
            global.replyMsg(context, result.message || '操作完成，但返回了未知结果', false, true);
        }
    } catch (error) {
        console.error('推本 - 功能出错:', error);
        if (error.response && error.response.data) {
            // 优先使用 user_message（后端已本地化的友好消息）
            const userMsg = error.response.data.user_message || error.response.data.message;
            if (userMsg) {
                global.replyMsg(context, `推本失败: ${userMsg}`, false, true);
            } else {
                global.replyMsg(context, '推本功能暂时不可用，请稍后再试', false, true);
            }
        } else {
            global.replyMsg(context, '推本功能暂时不可用，请稍后再试', false, true);
        }
    }

    return true;
}

/**
 * 处理用户选择的 ehentai 画廊
 * @param {string} link 画廊链接
 * @param {object} context 消息上下文
 * @param {boolean} shouldSendCover 是否发送封面图（默认false）
 * @returns {Promise<boolean>} 是否成功处理
 */
export async function handleEhentaiSelect(link, context, shouldSendCover = false) {
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
            const title = gallery.rawTitle || (result.data && result.data.title) || '';
            let msg = `${title}\n好书收录📚 ！${rating}⭐ ${gallery.pageCount}P：`;

            // 添加评论内容显示（与 pushDoujinshi 逻辑保持一致）
            if (gallery.comments && gallery.comments.length > 0) {
                // 混淆评论中的 http 链接，避免被 QQ 识别为可点击链接
                const filteredComments = gallery.comments.map(comment =>
                    comment.replace(/(https?):\/\/([^\s]+)/g, (match, protocol, rest) => {
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
                    const commentLength = comment.length + 3; // +3 for prefix and newline

                    if (totalLength + commentLength <= maxLength) {
                        commentsToShow.push(comment);
                        totalLength += commentLength;
                    } else {
                        break;
                    }
                }

                msg += `\n${commentsToShow.map(comment => `-${comment}`).join('\n')}`;
            }


            // 先发送主消息
            console.log('收藏 - 结果: 返回消息长度:', msg.length);
            const ret = await global.replyMsg(context, msg, false, true);
            if (ret?.retcode === 1200) {
                console.warn('收藏 - 发送结果: 发送失败，可能被禁言');
                await global.replyMsg(context, `好书收录📚 ！${rating}⭐ ${gallery.pageCount}P:\n${title}\n`, false, true);
            }

            // 异步发送封面图，不阻塞主消息发送
            if (shouldSendCover && gallery.cover && gallery.cover.url) {
                (async () => {
                    try {
                        const coverCQ = await CQ.imgPreDl(gallery.cover.url);
                        await global.replyMsg(context, coverCQ, false, false);
                        console.log('收藏 - 封面图异步发送完成');
                    } catch (e) {
                        console.warn('收藏 - 封面图下载失败，跳过:', e.message);
                    }
                })();
            }
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
            global.replyMsg(context, msg, false, true);
        }
        return true;
    } catch (error) {
        console.error('收藏 - EhentaiSelect 添加画廊失败:', error);
        if (error.response && error.response.data) {
            const userMsg = error.response.data.user_message || error.response.data.message;
            if (userMsg) {
                global.replyMsg(context, `添加失败: ${userMsg}`, false, true);
            } else {
                global.replyMsg(context, '添加画廊功能暂时不可用，请稍后再试', false, true);
            }
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
 * 后端搜索回退 + 归档队列处理（统一 resultUrl 存在/不存在两种场景的共通逻辑）
 * @param {object} params
 * @param {MsgImage} params.img - 图片对象
 * @param {object} params.context - 消息上下文
 * @param {boolean} params.isFromReply - 是否来自引用消息
 * @param {number} params.index - 图片序号（1-based）
 * @param {number} params.totalCount - 图片总数
 * @param {number|null} params.snSimilarity - SauceNAO 相似度
 * @param {number|null} params.iqdbSimilarity - IQDB 相似度
 * @param {object} params.archiveOptions - 归档队列参数
 * @param {object} params.archiveOptions.searchResults - 搜索引擎原始数据
 * @param {string} params.archiveOptions.lastErrorType - 失败的错误类型
 * @param {string} params.archiveOptions.lastErrorMessage - 失败的错误消息
 * @returns {Promise<{outcome: string, hasResult: boolean, failedResult?: object, detailedResult: object}>}
 */
async function handleBackendFallback({ img, context, isFromReply, index, totalCount, snSimilarity, iqdbSimilarity, archiveOptions }) {
    const localPath = await img.getPath().catch((e) => {
        console.warn(`[图片存档] getPath 失败 (file=${img.file}):`, e?.message || e);
        return undefined;
    });
    console.log(
        `[图片存档] 开始回退 Flask: index=${index}/${totalCount} ` +
        `sn=${snSimilarity != null ? Math.round(snSimilarity) : 'none'} ` +
        `iqdb=${iqdbSimilarity != null ? Math.round(iqdbSimilarity) : 'none'}` +
        (archiveOptions.searchResults?.resultUrl ? ` source=${summarizeLogValue(archiveOptions.searchResults.resultUrl, 88)}` : '')
    );
    const backendResult = await fallbackToBackendSearch(img.url, localPath || null, context);
    if (backendResult?.matched) {
        console.log(`图片存档 - 后端搜索匹配 ${index}/${totalCount}:`, backendResult.illustObj);
        const processResult = await processIllustObj(backendResult.illustObj, context, isFromReply, img);
        return {
            outcome: 'matched',
            hasResult: true,
            detailedResult: { index, status: processResult?.success ? 'success' : 'api_error', type: backendResult.illustObj.type, detail: processResult?.error, snSimilarity, iqdbSimilarity },
        };
    } else if (backendResult?.queued) {
        console.log(`图片存档 - 后端搜索降级为异步 ${index}/${totalCount}: queue_id=${backendResult.queue_id}`);
        global.replyMsg(context, `⏳ 搜索超时已提交后台队列 (#${backendResult.queue_id})`, false, true);
        return {
            outcome: 'queued',
            hasResult: false,
            detailedResult: { index, status: 'queued', snSimilarity, iqdbSimilarity },
        };
    } else {
        console.log(
            `[图片存档] Flask 回退未命中，转归档队列: index=${index}/${totalCount} ` +
            `reason=${summarizeLogValue(backendResult?.reason || backendResult?.message, 72)}`
        );
        const queueResult = await submitToArchiveQueue(img, context, {
            searchResults: archiveOptions.searchResults,
            lastErrorType: archiveOptions.lastErrorType,
            lastErrorMessage: archiveOptions.lastErrorMessage,
        });
        if (queueResult && queueResult.success) {
            console.log(
                `[图片存档] 归档队列已提交: index=${index}/${totalCount} ` +
                `queue_id=${queueResult.queue_id ?? 'none'} status=${queueResult.status || 'unknown'} ` +
                `cached=${queueResult.image_cached === true}`
            );
            return {
                outcome: 'archived',
                hasResult: false,
                failedResult: { index, snSimilarity, iqdbSimilarity },
                detailedResult: { index, status: 'archived', snSimilarity, iqdbSimilarity },
            };
        } else {
            console.warn(`[图片存档] 归档队列提交失败: index=${index}/${totalCount} url=${summarizeLogValue(img.url, 88)}`);
            return {
                outcome: 'archive_failed',
                hasResult: false,
                failedResult: { index, snSimilarity, iqdbSimilarity },
                detailedResult: { index, status: 'archive_failed', snSimilarity, iqdbSimilarity },
            };
        }
    }
}

/**
 * 图片搜索存档功能，仅使用saucenao和Iqdb，搜索完一张就立即处理入库
 * @param {Object} context 消息上下文
 * @param {boolean} isFromReply 是否来自引用消息（用于决定是否使用reply模式）
 * @returns {Promise<{hasResult: boolean, failedResults: Array<{index: number, snSimilarity: number|null, iqdbSimilarity: number|null}>, queuedCount: number, detailedResults: Array<{index: number, status: string, type?: string, detail?: string, snSimilarity?: number, iqdbSimilarity?: number}>}>} 搜索结果对象
 */
export async function ArchivedImg(context, isFromReply = false) {

    // 前置通知检查：展示之前异步搜索的完成结果
    await checkAndNotifyPendingResults(context);

    // 得到图片链接并搜图
    const msg = context.message;
    const imgs = getImgs(msg);

    const incorrectImgs = _.remove(imgs, ({ url }) => !/^https?:\/\/[^&]+\//.test(url));
    if (incorrectImgs.length) {
        if (global.config.bot.debug) console.warn('图片存档 - 非法图片列表:', incorrectImgs);
        global.replyMsg(context, '部分图片无法获取，请尝试使用其他设备QQ发送', false, true);
    }

    if (!imgs.length) return { hasResult: false, failedResults: [], queuedCount: 0 };

    let hasAnyResult = false; // 是否有任何一张图片成功入库
    const failedResults = []; // 记录所有失败图片的相似度信息
    let queuedCount = 0; // 已提交归档队列的数量
    const detailedResults = []; // 每张图片的详细处理状态（管理员汇总用）

    for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        
        // 如果不是第一张图，等待5秒避免触发限流
        if (i > 0) {
            console.log(`图片存档 - 等待5秒后搜索第 ${i + 1} 张图片`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        console.log(`图片存档 - 开始收藏 ${i + 1}/${imgs.length}:`, img.url);

        // 检查图片比例
        if (
            global.config.bot.stopSearchingHWRatioGt > 0 &&
            !(await checkImageHWRatio(img.url, global.config.bot.stopSearchingHWRatioGt))
        ) {
            console.log('图片存档 - 图片比例不符合要求，跳过');
            detailedResults.push({ index: i + 1, status: 'skipped', detail: '图片比例不符合' });
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
                const _r1 = await processIllustObj(illustObj, context, isFromReply, img);
                hasAnyResult = true;
                detailedResults.push({ index: i + 1, status: _r1?.success ? 'success' : 'api_error', type: illustObj.type, detail: _r1?.error, snSimilarity, iqdbSimilarity });
            } else {
                // 有搜索结果URL但无法匹配到图站 → 后端搜索回退
                const fbResult = await handleBackendFallback({
                    img, context, isFromReply,
                    index: i + 1, totalCount: imgs.length,
                    snSimilarity, iqdbSimilarity,
                    archiveOptions: {
                        searchResults: { resultUrl, snSimilarity, iqdbSimilarity },
                        lastErrorType: 'no_site_match',
                        lastErrorMessage: `搜索到结果但无法匹配图站: ${resultUrl.substring(0, 200)}`,
                    },
                });
                if (fbResult.hasResult) hasAnyResult = true;
                if (fbResult.outcome === 'queued' || fbResult.outcome === 'archived') queuedCount++;
                if (fbResult.failedResult) failedResults.push(fbResult.failedResult);
                detailedResults.push(fbResult.detailedResult);
            }
        } else {
            // 没有搜索结果 → 后端搜索回退
            const fbResult = await handleBackendFallback({
                img, context, isFromReply,
                index: i + 1, totalCount: imgs.length,
                snSimilarity, iqdbSimilarity,
                archiveOptions: {
                    searchResults: { snSimilarity, iqdbSimilarity },
                    lastErrorType: 'no_result',
                    lastErrorMessage: 'SauceNAO 和 IQDB 均未找到匹配结果',
                },
            });
            if (fbResult.hasResult) hasAnyResult = true;
            if (fbResult.outcome === 'queued' || fbResult.outcome === 'archived') queuedCount++;
            if (fbResult.failedResult) failedResults.push(fbResult.failedResult);
            detailedResults.push(fbResult.detailedResult);
        }
    }

    // 返回是否有成功入库的结果，以及所有失败图片的相似度信息
    return { 
        hasResult: hasAnyResult, 
        failedResults,
        queuedCount,
        detailedResults,
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
async function processIllustObj(illustObj, context, shouldReply = true, sourceImg = null) {
    // 返回值: { success: boolean, type: string, error?: string } 或 false（未知类型兜底）
    // 对象是 truthy，与原 return true 对插件框架兼容；return false 保持不变
    if (illustObj.type === 'pixiv') {
        let _processStatus = { success: true, type: 'pixiv' };
        try {
            const result = await illustAddPixiv(illustObj.id, context);
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
                _processStatus = { success: false, type: 'pixiv', error: result.error };
            } else {
                // 成功入库后提交图片缓存（直接传入源图片 URL 避免 DB 竞态）
                const pixivSourceUrl = result.meta_single_page || result.meta_large || null;
                submitImageCacheAfterAdd(sourceImg, 'illust_collection', illustObj.id, context, pixivSourceUrl);
                // 构建合并消息（参考Danbooru的实现方式）
                const texts = [];
                texts.push(`${result.message}:${result.author}<${result.title}>\n${result.caption}`);
                
                if (result.isR18) {
                    texts.push('R18？？？  不可以涩涩！ 死刑！');
                    replyPixivRatingMsg(illustObj.id, context, texts.join('\n'));
                } else if (result.meta_single_page || result.meta_large) {
                    const sourceUrl = result.meta_single_page || result.meta_large;
                    const url = getPixivRequestUrl(sourceUrl);
                    if (url) {
                        try {
                            console.log(
                                `[Pixiv发送] 投稿单图预下载: illust=${illustObj.id} ` +
                                `source=${result.meta_single_page ? 'meta_single_page' : 'meta_large'} ` +
                                `url=${summarizeLogValue(url, 120)}`
                            );
                            const imgCQ = await CQ.imgPreDl(url);
                            texts.push(imgCQ);
                        } catch (e) {
                            console.error('投稿 - pixiv.meta_single_page 图片预下载失败:', e);
                        }
                    }
                    replyPixivRatingMsg(illustObj.id, context, texts.join('\n'));
                } else if (result.meta_large_pages && result.meta_large_pages.length > 0) {
                    const imgCQs = result.meta_large_pages.map(pageUrl => {
                        const url = getPixivRequestUrl(pageUrl);
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
            _processStatus = { success: false, type: 'pixiv', error: error.response?.data?.user_message || error.response?.data?.message || error.message || '未知错误' };
        }
        return _processStatus;
    } else if (illustObj.type === 'danbooru') {
        let _processStatus = { success: true, type: 'danbooru' };
        try {
            const result = await illustAddDanbooru(illustObj.id, context);
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
                _processStatus = { success: false, type: 'danbooru', error: result.error };
            } else {
                // 成功入库后提交图片缓存（直接传入源图片 URL 避免 DB 竞态）
                const danbooruSourceUrl = result.file_url || result.large_file_url || null;
                submitImageCacheAfterAdd(sourceImg, 'danbooru_collection', illustObj.id, context, danbooruSourceUrl);
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
            _processStatus = { success: false, type: 'danbooru', error: error.response?.data?.user_message || error.response?.data?.message || error.message || '未知错误' };
        }
        return _processStatus;
    } else if (illustObj.type === 'ehentai') {
        let _processStatus = { success: true, type: 'ehentai' };
        try {
            const result = await illustAddEhentai(illustObj.url, context);
            if (result.error) {
                global.replyMsg(context, result.error, false, true);
                _processStatus = { success: false, type: 'ehentai', error: result.error };
            } else {
                // E-Hentai 无单图来源 URL，不执行 SSIM 检查
                replyEhentaiRatingMsg(illustObj.url, context, `${result.message}\n来源：${illustObj.url}`);
                replyCollectReply(context, result);
            }
        } catch (error) {
            handleApiError(error, context, "投稿");
            _processStatus = { success: false, type: 'ehentai', error: error.response?.data?.user_message || error.response?.data?.message || error.message || '未知错误' };
        }
        return _processStatus;
    } else if (illustObj.type === 'nhentai') {
        // NHentai 直接收录功能开发中（nhentai-add 接口尚未实装）
        // TODO: 后续实现 nhentai 收录 API 后替换此提示
        global.replyMsg(context, `NHentai 收录功能正在开发中，暂时无法收录`, false, true);
        return { success: false, type: 'nhentai', error: 'NHentai 收录功能正在开发中' };
    }
    return false;
}


/**
 * /搜索结果 命令处理器
 * @param {Object} context 消息上下文
 * @returns {Promise<boolean>} 是否处理了命令
 */
export async function searchResults(context) {
    try {
        const apiContext = await getApiContext(context);
        if (apiContext.qq_id == null) {
            global.replyMsg(context, '未能获取用户信息', false, true);
            return true;
        }

        // 解析页码: /搜索结果 2 → page=2
        const rawMsg = getRawMessage(context);
        const pageMatch = rawMsg.match(/\/搜索结果\s*(\d+)?/);
        const page = pageMatch?.[1] ? parseInt(pageMatch[1]) : 1;

        const response = await koharuAxios.get('/api/image-archive/user-results', {
            params: { qq_id: apiContext.qq_id, page, page_size: 5 },
        });
        const data = response.data?.data;
        if (!data || !data.items?.length) {
            global.replyMsg(context, '📋 暂无搜索记录', false, true);
            return true;
        }

        const totalPages = Math.ceil(data.total / 5);
        const lines = [`📋 你的搜索结果 (第${page}页/共${totalPages}页)`, '─────────────'];

        for (let i = 0; i < data.items.length; i++) {
            const r = data.items[i];
            let icon = '⏳';
            let info = '搜索中...';

            if (r.status === 'completed') {
                icon = '✅';
                const source = r.matched_source || '未知';
                const itemId = r.matched_item_id || '';
                const sim = r.ssim_score != null ? ` (${(r.ssim_score * 100).toFixed(1)}%)` : '';
                const credit = r.credit_awarded ? ' +1积分' : '';
                info = `${source}/${itemId}${sim}${credit}`;
            } else if (r.status === 'failed') {
                icon = '❌';
                info = `未找到来源 (已重试 ${r.retry_count}/3)`;
            } else if (r.status === 'expired') {
                icon = '⏰';
                info = '已过期';
            } else if (r.status === 'processing') {
                icon = '🔄';
                info = '处理中...';
            }

            lines.push(`${i + 1}. ${icon} #${r.id} ${info}`);
        }

        if (totalPages > 1) {
            lines.push(`\n使用 /搜索结果 ${page + 1} 查看下一页`);
        }

        global.replyMsg(context, lines.join('\n'), false, true);
        return true;
    } catch (error) {
        console.error('搜索结果查询失败:', error.message || error);
        global.replyMsg(context, '查询失败，请稍后再试', false, true);
        return true;
    }
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
                const cacheKey = buildRedisKey('RtMsg', context.self_id, context.group_id, msgRet.data.message_id);
                global.setKeyObject(cacheKey, record, 60 * 60 * 24 * 3);
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
                const cacheKey = buildRedisKey('RtMsg', context.self_id, context.group_id, msgRet.data.message_id);
                global.setKeyObject(cacheKey, record, 60 * 60 * 24 * 3);
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
    if (!proxy || !url) {
        return null;
    }

    const trimmedProxy = String(proxy).trim();
    if (!trimmedProxy) {
        return null;
    }

    const templateData = getPixivProxyTemplateData(url);
    if (!/{{.+}}/.test(trimmedProxy)) {
        return new URL(templateData.path, trimmedProxy).href;
    }

    return _.template(trimmedProxy, { interpolate: /{{([\s\S]+?)}}/g })(templateData);
}

function getPixivProxyTemplateData(url) {
    const path = new URL(url).pathname.replace(/^\//, '');
    const fileMatch = path.match(/(?<pid>\d+)_p(?<page>\d+)(?:_[^./]+)?\.(?<ext>[a-zA-Z0-9]+)$/);

    return {
        path,
        pid: fileMatch?.groups?.pid || '',
        p: fileMatch?.groups?.page || '',
        uid: '',
        ext: fileMatch?.groups?.ext || '',
    };
}

function getPixivRequestUrl(url) {
    if (!url) {
        return null;
    }

    return proxy ? getSetuUrl(proxy, url) : getLocalReverseProxyURL(url);
}

export function checkRatingMsg(msgRet, selfId) {
    const cacheKey = buildRedisKey('RtMsg', selfId, msgRet.group_id, msgRet.message_id);
    return getKeyObject(cacheKey);
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
 * @param {number|string} selfId 机器人QQ号
 * @returns {Promise<object|null>} 画廊选择数据或null
 */
export async function checkGallerySelectMsg(msgRet, selfId) {
    const cacheKey = buildRedisKey('tbSelect', selfId, msgRet.group_id, msgRet.message_id);
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
                const cacheKey = buildRedisKey('RtMsg', context.self_id, context.group_id, msgRet.data.message_id);
                global.setKeyObject(cacheKey, record, 60 * 60 * 24 * 3);
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
                const cacheKey = buildRedisKey('RtMsg', context.self_id, context.group_id, msgRet.data.message_id);
                global.setKeyObject(cacheKey, record, 60 * 60 * 24 * 3);
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
            const cacheKey = buildRedisKey('RtMsg', context.self_id, context.group_id, msgRet.data.message_id);
            global.setKeyObject(cacheKey, record, 60 * 60 * 24 * 3);
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
                const cacheKey = buildRedisKey('RtMsg', context.self_id, context.group_id, msgRet.data.message_id);
                global.setKeyObject(cacheKey, record, 60 * 60 * 24 * 3);
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
 * 解析 XP 诊断报告周期参数
 * @param {string} rawParam 原始参数字符串（已去除命令前缀）
 * @returns {string} 周期值
 */
function parseXpPeriod(rawParam) {
    const periodMap = [
        ['--365d', '365days'],
        ['--180d', '180days'],
        ['--90d',  '90days'],
        ['--30d',  '30days'],
        ['--14d',  '14days'],
        ['--7d',   '7days'],
        ['--monthly', 'monthly'],
        ['--month',   'monthly'],
        ['--weekly',  'weekly'],
        ['--week',    'weekly'],
    ];
    const param = rawParam.trim().toLowerCase();
    for (const [flag, val] of periodMap) {
        if (param.includes(flag)) return val;
    }
    return 'all';
}

/**
 * 处理 /我的xp 命令，生成并发送个人统计卡片
 * @param {object} context 消息上下文
 * @returns {Promise<boolean>}
 */
export async function myXpDiagnosisReport(context) {
    const rawParam = context.message.replace('/我的xp', '');
    const period = parseXpPeriod(rawParam);

    // 用户冷却：每天 1 次，零点重置（参考占卜功能）
    const limitKey = buildRedisKey('xpCardUser', context.self_id, context.user_id);
    const currentCount = dailyCountInstance.get(limitKey) || 0;
    if (currentCount >= 1) {
        global.replyMsg(context, '📊 个人统计卡片每天只能生成一次，请明天再试', false, true);
        return true;
    }
    dailyCountInstance.add(limitKey);

    try {
        const apiContext = await getApiContext(context);
        const response = await koharuAxios.post('/api/stats/card/image', {
            scope: 'user',
            qq_id: context.user_id,
            display_name: apiContext.display_name,
            period,
        }, { responseType: 'arraybuffer' });
        const imgCQ = CQ.img64(response.data);
        await global.replyMsg(context, imgCQ, false, false);
    } catch (error) {
        const status = error.response?.status;
        if (status === 503) {
            global.replyMsg(context, '📊 统计卡片生成服务维护中暂时不可用', false, true);
        } else if (status === 422) {
            // 样本不足 — 后端返回 INSUFFICIENT_SAMPLES
            if (period === 'all') {
                global.replyMsg(context, '📊 你的收藏数据还太少了，请多多收藏一些作品吧~', false, true);
            } else {
                global.replyMsg(context, '📊 你的收藏数据还太少了，请尝试选择更长的统计周期或多收藏一些作品吧~', false, true);
            }
        } else if (status === 404) {
            global.replyMsg(context, '📊 暂无你的统计数据，快去收藏作品吧', false, true);
        } else {
            global.replyMsg(context, '📊 统计卡片生成失败，请稍后重试', false, true);
            logError('[myXpDiagnosisReport] error');
            logError(error);
        }
    }
    return true;
}

/**
 * 处理 /群友xp 命令，生成并发送群组统计卡片
 * @param {object} context 消息上下文
 * @returns {Promise<boolean>}
 */
export async function groupXpDiagnosisReport(context) {
    // 仅在群聊中使用
    if (!context.group_id) {
        global.replyMsg(context, '请在群聊中使用此命令', false, true);
        return true;
    }

    const rawParam = context.message.replace('/群友xp', '');
    const period = parseXpPeriod(rawParam);

    // 群组冷却：每天 1 次，零点重置
    const limitKey = buildRedisKey('xpCardGroup', context.self_id, context.group_id);
    const currentCount = dailyCountInstance.get(limitKey) || 0;
    if (currentCount >= 1) {
        global.replyMsg(context, '📊 群组统计卡片每天只能生成一次，请明天再试', false, true);
        return true;
    }
    dailyCountInstance.add(limitKey);

    try {
        const apiContext = await getApiContext(context);
        const response = await koharuAxios.post('/api/stats/card/image', {
            scope: 'group',
            group_id: context.group_id,
            group_name: apiContext.group_name,
            period,
        }, { responseType: 'arraybuffer' });
        const imgCQ = CQ.img64(response.data);
        await global.replyMsg(context, imgCQ, false, false);
    } catch (error) {
        const status = error.response?.status;
        if (status === 503) {
            global.replyMsg(context, '📊 统计卡片生成服务维护中暂时不可用', false, true);
        } else if (status === 422) {
            // 样本不足 — 后端返回 INSUFFICIENT_SAMPLES
            if (period === 'all') {
                global.replyMsg(context, '📊 该群组收藏数据还太少了，请多多收藏一些作品吧~', false, true);
            } else {
                global.replyMsg(context, '📊 该群组收藏数据还太少了，请尝试选择更长的统计周期或多收藏一些作品吧~', false, true);
            }
        } else if (status === 403) {
            global.replyMsg(context, '📊 该群组无权查看统计卡片', false, true);
        } else if (status === 404) {
            global.replyMsg(context, '📊 暂无该群组的统计数据', false, true);
        } else {
            global.replyMsg(context, '📊 统计卡片生成失败，请稍后重试', false, true);
            logError('[groupXpDiagnosisReport] error');
            logError(error);
        }
    }
    return true;
}

/**
 * 获取帮助说明卡片（Playwright 渲染图片）
 * 当用户私聊/@ bot 且未命中任何指令时调用
 * @param {object} context 消息上下文
 * @returns {Promise<boolean>}
 */
export async function getHelpCard(context) {
    // 用户冷却：每用户 5 分钟 1 次
    // const cooldownKey = buildRedisKey('helpCard', context.self_id, context.user_id);
    // const isOverLimit = await cooldownManager.SlidingWindowCooldown(cooldownKey, 300, 1);
    // if (isOverLimit) {
    //     // 冷却期间降级为文字回复
    //     global.replyMsg(context, global.config.bot.replys.default, true);
    //     return true;
    // }

    try {
        const response = await koharuAxios.get('/api/help-card/commands/image', {
            responseType: 'arraybuffer',
        });
        const imgCQ = CQ.img64(response.data);
        await global.replyMsg(context, imgCQ, false, false);
    } catch (error) {
        // 渲染失败降级为文字回复
        logError('[getHelpCard] error');
        logError(error);
        global.replyMsg(context, global.config.bot.replys.default, true);
    }
    return true;
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
 * ExHentai 下载降级链：
 * ├─ Layer 0: 检查并添加 pximgProxy URL 转换（如适用）
 * ├─ Layer 1: ExHentai 直连 + Cookie 认证（如已配置）
 * ├─ Layer 2: 多代理轮询（带 Cookie 自动传递）+ 直连（在 axiosProxy.download 内部）
 * ├─ Layer 3: Puppeteer 绕过（带 Cookie 支持）
 * ├─ Layer 4: FlareSolverr 绕过（如配置）
 * └─ Layer 5: URL 直发兜底（仅当 allowUrlFallback=true）
 * 
 * Pixiv/Danbooru 下载降级链：
 * ├─ Layer 0: pximgProxy URL 转换
 * ├─ Layer 1: 多代理轮询 + 直连
 * ├─ Layer 2: Puppeteer/FlareSolverr（如适用）
 * └─ Layer 3: URL 直发兜底
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
    const isExhentai = /^(exhentai\.org|e-hentai\.org|s\.exhentai\.org)$/.test(host);
    const isPximg = /^i\.pximg\.net$/.test(host);
    
    // 【Layer 0】pximgProxy URL域名替换 - 始终应用于 i.pximg.net，不降级
    if (isPximg) {
        const proxyUrl = getSetuUrl(proxy, url);
        if (proxyUrl) {
            targetUrl = proxyUrl;
            console.log(`[图片下载] Pixiv URL 代理转换: ${host} -> ${new URL(targetUrl).hostname}`);
        }
    }

    // 【Layer 1-5】尝试下载（完整降级链）
    try {
        console.log(`[图片下载] 开始下载: ${new URL(targetUrl).hostname}${new URL(targetUrl).pathname.substring(0, 50)}...`);
        
        // ExHentai 特殊处理：Layer 1 - 如果配置了 cookies，优先尝试直连下载
        if (isExhentai && (exhentaiIpbMemberId && exhentaiIpbPassHash)) {
            try {
                console.log(`[E-Hentai] Layer 1: 尝试 Cookie 认证直连...`);
                const response = await exhentaiAxios.get(targetUrl, { responseType: 'arraybuffer', timeout: 30000 });
                const filepath = await createCache(url, Buffer.from(response.data));
                console.log(`[图片下载] ✓ ExHentai Cookie 认证成功 (${filepath}, 大小: ${response.data.length} bytes)`);
                return CQ.img(filepath);
            } catch (error) {
                const errorMsg = error.message || String(error);
                console.warn(`[E-Hentai] Layer 1 失败 (${errorMsg})，继续下一层级...`);
                // 继续降级到 Layer 2
            }
        }
        
        // Layer 2: 多代理轮询 + 直连（axiosProxy.download 内部自动处理 Cookie）
        console.log(`[图片下载] Layer 2: 尝试多代理轮询...`);
        const response = await axios.download(targetUrl, { useProxy: useNetworkProxy });
        const filepath = await createCache(url, Buffer.from(response.data));
        console.log(`[图片下载] ✓ Layer 2 代理轮询成功 (${filepath}, 大小: ${response.data.length} bytes)`);
        return CQ.img(filepath);
        
    } catch (error) {
        const errorMsg = error.message || String(error);
        console.error(`[图片下载] ✗ Layer 2 全部失败: ${errorMsg}`);
        
        // 【Layer 3-4】URL直发兜底 - Puppeteer 和 FlareSolverr 在 axiosProxy.download 内已尝试
        // 这里仅作为兜底处理，实际的高级降级在 axiosProxy.download 中完成
        
        // 【Layer 5】URL直发兜底
        if (allowUrlFallback) {
            console.warn(`[图片下载] Layer 5: 降级为URL直发 (${targetUrl.substring(0, 80)}...)`);
            return CQ.img(targetUrl);
        }
        
        throw error;
    }
}

/**
 * 咪咪缩小术 — /咪咪缩小术
 * 支持两种触发方式：
 *   1. 回复一条包含图片的消息并发送 /咪咪缩小术
 *   2. 直接发送 /咪咪缩小术 并附带一张图片
 * @param {object} context 消息上下文
 * @returns {Promise<boolean>}
 */
export async function breastReduction(context) {
    try {
        // 清理 reply CQ 码和 at CQ 码后检查命令前缀
        // 回复消息时 QQ 会自动附带 [CQ:at,qq=...] 标签，必须一并去除
        const cleanMsg = context.message.replace(/^\[CQ:reply,id=-?\d+.*?\]/, '').replace(/^\s*\[CQ:at[^\]]*\]\s*/, '').trim();
        if (!cleanMsg.startsWith('/咪咪缩小术')) return false;

        let imageUrl = null;

        // 方式 1: 回复消息中的图片
        const rMsgId = _.get(/^\[CQ:reply,id=(-?\d+).*\]/.exec(context.message), 1);
        if (rMsgId) {
            const { data } = await global.bot('get_msg', { message_id: Number(rMsgId) });
            if (data) {
                const imgs = getImgs(getRawMessage(data));
                if (imgs.length === 1) {
                    imageUrl = imgs[0].url;
                } else if (imgs.length > 1) {
                    global.replyMsg(context, '只支持单张图片的咪咪缩小术，请回复只有一张图片的消息', false, true);
                    return true;
                }
            }
        }

        // 方式 2: 当前消息中直接附带的图片
        if (!imageUrl) {
            const inlineImgs = getImgs(context.message);
            if (inlineImgs.length === 1) {
                imageUrl = inlineImgs[0].url;
            } else if (inlineImgs.length > 1) {
                global.replyMsg(context, '只支持单张图片的咪咪缩小术哦～', false, true);
                return true;
            }
        }

        // 两种方式都未获取到图片
        if (!imageUrl) {
            global.replyMsg(context, '请回复一条包含图片的消息，或直接发送 /咪咪缩小术 并附带一张图片～', false, true);
            return true;
        }

        const apiCtx = await getApiContext(context);

        // ── 固定两步流程：先检测出吐槽，再编辑 ──

        // Step 1: 调用独立检测 API（视觉模型分析图片内容）
        let detectResult;
        try {
            const { data } = await koharuAxios.post('/api/ai-image/detect', {
                plugin_id: 'breast_reduction',
                image_url: imageUrl,
                qq_id: apiCtx.qq_id,
                group_id: apiCtx.group_id || undefined,
            });
            detectResult = data;
        } catch (error) {
            handleApiError(error, context, '咪咪缩小术');
            return true;
        }

        // 发送小春的检测吐槽（无论是否可以缩小都发，这是核心体验）
        if (detectResult.detection_comment) {
            global.replyMsg(context, `🎀 ${detectResult.detection_comment}`, false, true);
        }

        // 如果不能缩小，到此结束
        if (!detectResult.can_proceed) {
            return true;
        }

        // Step 2: 执行编辑（跳过检测，因为已在 Step 1 完成）
        const { data: result } = await koharuAxios.post('/api/ai-image/process', {
            plugin_id: 'breast_reduction',
            image_url: imageUrl,
            qq_id: apiCtx.qq_id,
            group_id: apiCtx.group_id || undefined,
            skip_detection: true,
        });

        // 构建回复消息
        const parts = [];

        if (result.success && (result.result_image_base64 || result.result_image_url)) {
            // 发送结果吐槽 + 缩小后的图片
            if (result.result_comment) {
                parts.push(result.result_comment);
            }
            // 优先使用 base64 直发（最可靠，无需再下载），其次用 URL 预下载
            let imgCQ;
            if (result.result_image_base64) {
                imgCQ = CQ.img64(result.result_image_base64);
            } else {
                imgCQ = await CQ.imgPreDl(result.result_image_url);
            }
            parts.push(imgCQ);
        } else {
            // 失败情况
            parts.push(result.user_message || '编辑失败了…请稍后再试');
        }

        const replyText = parts.join('');
        global.replyMsg(context, replyText, false, true);
        return true;

    } catch (error) {
        handleApiError(error, context, '咪咪缩小术');
        return true;
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
    else if (error.response.data?.user_message) {
        global.replyMsg(context, error.response.data.user_message, false, true);
    }
    else if (error.response.data?.message) {
        // 统一错误格式兼容：读取 message 字段
        global.replyMsg(context, error.response.data.message, false, true);
    }
    else if (error.response.status === 400) {
        global.replyMsg(context, `书库暂时维护中`, false, true);
    }
    else {
        global.replyMsg(context, `${action}失败，请稍后重试`, false, true);
    }
}
