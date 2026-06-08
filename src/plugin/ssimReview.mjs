/**
 * SSIM 低相似度搜索结果 · 管理员私聊复核插件
 *
 * 命令（仅管理员私聊有效）：
 *   /复核              进入复核流，自动推送最旧一条待复核
 *   /复核 stats        查看待审/近 7 天处理统计
 *   /复核 耗尽         进入「重试耗尽」复核流（1=重启重试 / 2=删除 / 4=跳过 / 0=退出）
 *   /复核 exit         退出复核会话
 *
 * 复核中可直接回复：
 *   1 / a / approve / 通过 / y
 *   2 / r / retry / 重试 / 重新搜索         【复核流】
 *   2 / d / delete / 删除                       【耗尽流】
 *   4 / s / skip / 跳过                          （不调用后端，仅前进到下一条）
 *   0 / q / exit / 退出 / quit
 *
 * 后端依赖：
 *   GET  /api/admin/image-review/stats
 *   GET  /api/admin/image-review/exhausted-stats
 *   GET  /api/admin/image-review/list?order=oldest&page=1&page_size=1
 *   GET  /api/admin/image-review/list-exhausted?order=oldest&page=1&page_size=1
 *   GET  /api/admin/image-review/<id>/compare       → JPEG bytes
 *   POST /api/admin/image-review/<id>/action        { action, review_note? }
 *   POST /api/admin/image-review/exhausted/<id>/restart
 *   DELETE /api/admin/image-review/exhausted/<id>
 */

import CQ from '../utils/CQcode.mjs';
import logError from '../utils/logError.mjs';
import {
    buildRedisKey,
    delKey,
    getKeyObject,
    setKeyObject,
} from '../utils/redisClient.mjs';
import { koharuAxios } from './koharuApi.mjs';

const SESSION_PREFIX = 'ssimReview';
const SESSION_TTL = 600; // 10 分钟

const ACTION_MAP = {
    // approve
    '1': 'approve', 'a': 'approve', 'approve': 'approve',
    '通过': 'approve', 'y': 'approve', 'yes': 'approve',
    // retry（原 3 合并到 2，取消独立 reject 按钮）
    '2': 'retry', 'r': 'retry', 'retry': 'retry',
    '重试': 'retry', '重新搜索': 'retry',
    // skip（前端处理，不调后端）
    '4': 'skip', 's': 'skip', 'skip': 'skip', '跳过': 'skip',
    // exit
    '0': 'exit', 'q': 'exit', 'exit': 'exit',
    '退出': 'exit', 'quit': 'exit',
};

// 耗尽复核流专用映射：1=重启 / 2=删除 / 4=跳过 / 0=退出
const EXHAUSTED_ACTION_MAP = {
    '1': 'restart', 'r': 'restart', 'restart': 'restart', '重启': 'restart', '重试': 'restart',
    '2': 'delete', 'd': 'delete', 'delete': 'delete', '删除': 'delete',
    '4': 'skip', 's': 'skip', 'skip': 'skip', '跳过': 'skip',
    '0': 'exit', 'q': 'exit', 'exit': 'exit', '退出': 'exit', 'quit': 'exit',
};

function sessionKey(ctx) {
    return buildRedisKey(SESSION_PREFIX, ctx.self_id, ctx.user_id);
}

function isAdminPrivate(ctx) {
    if (ctx.message_type !== 'private') return false;
    return ctx.user_id === global.config?.bot?.admin;
}

function reply(ctx, msg) {
    if (typeof global.replyMsg === 'function') {
        return global.replyMsg(ctx, msg, false, true);
    }
}

function fmtSource(by_source) {
    if (!by_source || Object.keys(by_source).length === 0) return '  （无）';
    return Object.entries(by_source)
        .sort((a, b) => b[1] - a[1])
        .map(([src, n]) => `  · ${src}: ${n}`)
        .join('\n');
}

async function fetchStats() {
    const { data } = await koharuAxios.get('/api/admin/image-review/stats');
    return data;
}

async function fetchOldest() {
    const { data } = await koharuAxios.get('/api/admin/image-review/list', {
        params: { page: 1, page_size: 1, order: 'oldest' },
    });
    return (data?.items ?? [])[0] ?? null;
}

async function fetchCompareJpeg(id) {
    const { data } = await koharuAxios.get(
        `/api/admin/image-review/${id}/compare`,
        { responseType: 'arraybuffer', validateStatus: () => true },
    );
    if (!data || data.byteLength === undefined) return null;
    // 错误响应会是 JSON；用大小粗略判定
    if (data.byteLength < 256) {
        try {
            const txt = Buffer.from(data).toString('utf8');
            if (txt.trim().startsWith('{')) return null;
        } catch (_) { /* noop */ }
    }
    return Buffer.from(data);
}

async function fetchSingleCacheJpeg(cacheKey) {
    if (!cacheKey) return null;
    try {
        const { data } = await koharuAxios.get(
            `/api/image-cache/serve/${cacheKey}`,
            { responseType: 'arraybuffer', validateStatus: () => true },
        );
        if (!data || data.byteLength < 64) return null;
        return Buffer.from(data);
    } catch (_) {
        return null;
    }
}

async function postAction(id, action, note) {
    const body = { action };
    if (note) body.review_note = note;
    const { data } = await koharuAxios.post(
        `/api/admin/image-review/${id}/action`,
        body,
        { validateStatus: () => true },
    );
    return data;
}

// ----------------------------------------------------------------------
// 重试耗尽复核流 API
// ----------------------------------------------------------------------

async function fetchExhaustedStats() {
    const { data } = await koharuAxios.get('/api/admin/image-review/exhausted-stats');
    return data;
}

async function fetchOldestExhausted() {
    const { data } = await koharuAxios.get('/api/admin/image-review/list-exhausted', {
        params: { page: 1, page_size: 1, order: 'oldest' },
    });
    return (data?.items ?? [])[0] ?? null;
}

async function postExhaustedRestart(id) {
    const { data } = await koharuAxios.post(
        `/api/admin/image-review/exhausted/${id}/restart`,
        {},
        { validateStatus: () => true },
    );
    return data;
}

async function postExhaustedDelete(id) {
    const { data } = await koharuAxios.delete(
        `/api/admin/image-review/exhausted/${id}`,
        { validateStatus: () => true },
    );
    return data;
}

function formatRecordHeader(rec, stats) {
    const ssim = rec.ssim_score !== null && rec.ssim_score !== undefined
        ? Number(rec.ssim_score).toFixed(4) : 'N/A';
    const thr = rec.ssim_threshold_used !== null && rec.ssim_threshold_used !== undefined
        ? Number(rec.ssim_threshold_used).toFixed(4) : 'N/A';
    const src = rec.matched_source || 'unknown';
    const itemId = rec.matched_item_id || 'N/A';
    const who = rec.display_name
        ? `${rec.display_name}(${rec.created_by_qq_id})`
        : `${rec.created_by_qq_id ?? '匿名'}`;
    const where = rec.group_name ? ` @ ${rec.group_name}(${rec.created_by_group_id})` : '';
    const createdAt = rec.created_at || '';
    const pending = stats?.pending !== undefined ? `（剩 ${stats.pending}）` : '';
    return [
        `📋 复核 #${rec.id} ${pending}`,
        `来源: ${src}  ID: ${itemId}`,
        `SSIM: ${ssim} / 阈值: ${thr}`,
        `请求: ${who}${where}`,
        createdAt ? `时间: ${createdAt}` : '',
        '— 回复: 1通过 / 2重试 / 4跳过 / 0退出 —',
    ].filter(Boolean).join('\n');
}

async function pushReviewCard(ctx, rec, stats) {
    const header = formatRecordHeader(rec, stats);
    const jpeg = await fetchCompareJpeg(rec.id);

    if (jpeg) {
        reply(ctx, `${header}\n${CQ.img64(jpeg)}`);
        return;
    }

    // 拼图失败兜底：分别取两张缓存图
    const [origBuf, candBuf] = await Promise.all([
        fetchSingleCacheJpeg(rec.original_cache_key),
        fetchSingleCacheJpeg(rec.source_cache_key),
    ]);

    const parts = [header, '（合成失败，已分别推送原图/候选）'];
    if (origBuf) parts.push(`原图：${CQ.img64(origBuf)}`);
    else parts.push('原图：[缓存不可用]');
    if (candBuf) parts.push(`候选：${CQ.img64(candBuf)}`);
    else parts.push('候选：[缓存不可用]');
    reply(ctx, parts.join('\n'));
}

async function advanceToNext(ctx) {
    let stats;
    try {
        stats = await fetchStats();
    } catch (e) {
        logError('[ssimReview] fetchStats 失败:'); logError(e);
        reply(ctx, '⚠️ 获取统计失败');
    }
    const next = await fetchOldest().catch(e => {
        logError('[ssimReview] fetchOldest 失败:'); logError(e);
        return null;
    });
    if (!next) {
        await delKey(sessionKey(ctx));
        reply(ctx, '✅ 已无待复核记录，已退出复核会话。');
        return;
    }
    await setKeyObject(
        sessionKey(ctx),
        { mode: 'review', currentReviewId: next.id, enteredAt: Date.now() },
        SESSION_TTL,
    );
    await pushReviewCard(ctx, next, stats);
}

// ----------------------------------------------------------------------
// 耗尽复核流卡片推送 & 推进
// ----------------------------------------------------------------------

function formatExhaustedHeader(rec, total) {
    const src = rec.matched_source || 'unknown';
    const itemId = rec.matched_item_id || 'N/A';
    const errType = rec.last_error_type || 'unknown';
    const errMsg = (rec.last_error_message || '').toString().slice(0, 120);
    const retried = `${rec.retry_count ?? '?'}/3`;
    const who = rec.display_name
        ? `${rec.display_name}(${rec.created_by_qq_id})`
        : `${rec.created_by_qq_id ?? '匿名'}`;
    const where = rec.group_name ? ` @ ${rec.group_name}(${rec.created_by_group_id})` : '';
    const createdAt = rec.created_at || '';
    const remain = total !== undefined ? `（剩 ${total}）` : '';
    return [
        `⛔ 重试耗尽 #${rec.id} ${remain}`,
        `状态: ${rec.status} · 重试: ${retried}`,
        `错误: ${errType}${errMsg ? ` · ${errMsg}` : ''}`,
        `原候选: ${src}/${itemId}`,
        `请求: ${who}${where}`,
        createdAt ? `时间: ${createdAt}` : '',
        '— 回复: 1重启重试 / 2删除 / 4跳过 / 0退出 —',
    ].filter(Boolean).join('\n');
}

async function pushExhaustedCard(ctx, rec, total) {
    const header = formatExhaustedHeader(rec, total);
    const buf = await fetchSingleCacheJpeg(rec.original_cache_key);
    if (buf) {
        reply(ctx, `${header}\n${CQ.img64(buf)}`);
    } else {
        reply(ctx, `${header}\n（原图缓存不可用）`);
    }
}

async function advanceToNextExhausted(ctx) {
    let stats;
    try {
        stats = await fetchExhaustedStats();
    } catch (e) {
        logError('[ssimReview] fetchExhaustedStats 失败:'); logError(e);
    }
    const next = await fetchOldestExhausted().catch(e => {
        logError('[ssimReview] fetchOldestExhausted 失败:'); logError(e);
        return null;
    });
    if (!next) {
        await delKey(sessionKey(ctx));
        reply(ctx, '✅ 已无重试耗尽记录，已退出耗尽复核会话。');
        return;
    }
    await setKeyObject(
        sessionKey(ctx),
        { mode: 'exhausted', currentReviewId: next.id, enteredAt: Date.now() },
        SESSION_TTL,
    );
    await pushExhaustedCard(ctx, next, stats?.total);
}

async function showStats(ctx) {
    try {
        const s = await fetchStats();
        const oldest = s.oldest_pending_age_hours !== null && s.oldest_pending_age_hours !== undefined
            ? `${s.oldest_pending_age_hours} 小时` : '无';
        reply(ctx, [
            '📊 SSIM 复核统计',
            `待复核: ${s.pending}`,
            `近 7 天: 通过 ${s.approved_7d} / 拒绝 ${s.rejected_7d} / 重试 ${s.retry_7d}`,
            `最旧待审等待: ${oldest}`,
            '按来源分布:',
            fmtSource(s.by_source),
        ].join('\n'));
    } catch (e) {
        logError('[ssimReview] showStats 失败:'); logError(e);
        reply(ctx, '⚠️ 获取统计失败');
    }
}

/**
 * 入口路由：`/复核` 命令
 * 返回 true 表示已处理，调用方应短路。
 */
export default async function ssimReview(ctx) {
    if (!isAdminPrivate(ctx)) return false;
    const raw = (ctx.message || '').trim();
    if (!/^\/?复核(\s|$)/.test(raw)) return false;

    const arg = raw.replace(/^\/?复核\s*/, '').trim().toLowerCase();

    if (arg === 'stats' || arg === '统计') {
        await showStats(ctx);
        return true;
    }
    if (arg === 'exit' || arg === '退出' || arg === 'quit' || arg === '0') {
        const existed = await getKeyObject(sessionKey(ctx));
        await delKey(sessionKey(ctx));
        reply(ctx, existed ? '👋 已退出复核会话。' : '当前未在复核会话中。');
        return true;
    }
    if (arg === '耗尽' || arg === 'exhausted' || arg === 'expired') {
        await advanceToNextExhausted(ctx);
        return true;
    }
    if (arg && arg !== '') {
        reply(ctx, '用法：/复核 [stats|耗尽|exit]\n直接 /复核 进入流式复核。');
        return true;
    }

    await advanceToNext(ctx);
    return true;
}

/**
 * 复核会话中的回复分发：仅在 Redis 中存在 session 时才接管。
 * 返回 true 表示已处理。
 */
export async function handleReviewReply(ctx) {
    if (!isAdminPrivate(ctx)) return false;
    const session = await getKeyObject(sessionKey(ctx));
    if (!session || !session.currentReviewId) return false;

    const raw = (ctx.message || '').trim().toLowerCase();
    if (!raw) return false;

    const id = session.currentReviewId;
    const mode = session.mode || 'review';

    // -------------------- 耗尽流 --------------------
    if (mode === 'exhausted') {
        const action = EXHAUSTED_ACTION_MAP[raw];
        if (!action) return false;

        if (action === 'exit') {
            await delKey(sessionKey(ctx));
            reply(ctx, '👋 已退出耗尽复核会话。');
            return true;
        }
        if (action === 'skip') {
            reply(ctx, `⏭️ 已跳过 #${id}，加载下一条…`);
            await advanceToNextExhausted(ctx);
            return true;
        }
        try {
            const result = action === 'restart'
                ? await postExhaustedRestart(id)
                : await postExhaustedDelete(id);
            if (result && result.success) {
                reply(ctx, `✅ #${id} ${action === 'restart' ? '重启重试' : '删除'} 完成`);
            } else {
                const msg = result?.message || result?.error || '未知错误';
                reply(ctx, `❌ #${id} ${action} 失败：${msg}`);
            }
        } catch (e) {
            logError(`[ssimReview] exhausted ${action} 异常 id=${id}:`); logError(e);
            reply(ctx, `❌ #${id} ${action} 请求异常`);
        }
        await advanceToNextExhausted(ctx);
        return true;
    }

    // -------------------- 复核流（默认） --------------------
    const action = ACTION_MAP[raw];
    if (!action) return false;

    if (action === 'exit') {
        await delKey(sessionKey(ctx));
        reply(ctx, '👋 已退出复核会话。');
        return true;
    }

    if (action === 'skip') {
        reply(ctx, `⏭️ 已跳过 #${id}，加载下一条…`);
        await advanceToNext(ctx);
        return true;
    }

    try {
        const result = await postAction(id, action);
        if (result && result.success) {
            reply(ctx, `✅ #${id} ${action} 完成`);
        } else {
            const msg = result?.message || result?.error || '未知错误';
            reply(ctx, `❌ #${id} ${action} 失败：${msg}`);
        }
    } catch (e) {
        logError(`[ssimReview] action ${action} 失败 id=${id}:`); logError(e);
        reply(ctx, `❌ #${id} ${action} 请求异常`);
    }
    await advanceToNext(ctx);
    return true;
}
