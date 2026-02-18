/**
 * 群信息缓存工具
 * 使用 Redis 缓存群信息（群名称等），避免频繁调用 API
 */

import { getKeyObject, setKeyObject } from './redisClient.mjs';

const CACHE_PREFIX = 'groupInfo';
const CACHE_EXPIRY = 60 * 60 * 24 * 7; // 7天过期

/**
 * 获取群信息（带缓存）
 * @param {number} groupId 群号
 * @returns {Promise<{group_id: number, group_name: string, member_count: number, max_member_count: number}|null>}
 */
export async function getGroupInfo(groupId) {
    if (!groupId) return null;

    // 尝试从缓存获取
    const cacheKey = `${CACHE_PREFIX}:${groupId}`;
    const cached = await getKeyObject(cacheKey, null);
    
    if (cached) {
        return cached;
    }

    // 缓存未命中，调用 API 获取
    try {
        const { data } = await global.bot('get_group_info', {
            group_id: groupId,
            no_cache: false
        });

        if (data) {
            // 存入缓存
            await setKeyObject(cacheKey, data, CACHE_EXPIRY);
            console.log(`[GroupInfoCache] ✓ 群 ${groupId} 信息已缓存: ${data.group_name}`);
            return data;
        }
    } catch (error) {
        console.error(`[GroupInfoCache] ✗ 获取群 ${groupId} 信息失败:`, error.message);
    }

    return null;
}

/**
 * 获取群名称（带缓存）
 * @param {number} groupId 群号
 * @returns {Promise<string|undefined>} 群名称，失败时返回 undefined
 */
export async function getGroupName(groupId) {
    const info = await getGroupInfo(groupId);
    return info?.group_name;
}

/**
 * 批量获取群信息（带缓存）
 * @param {number[]} groupIds 群号数组
 * @returns {Promise<Map<number, object>>} 群号 -> 群信息的 Map
 */
export async function batchGetGroupInfo(groupIds) {
    const result = new Map();
    
    await Promise.all(
        groupIds.map(async (groupId) => {
            const info = await getGroupInfo(groupId);
            if (info) {
                result.set(groupId, info);
            }
        })
    );
    
    return result;
}

/**
 * 清除指定群的缓存
 * @param {number} groupId 群号
 * @returns {Promise<void>}
 */
export async function clearGroupInfoCache(groupId) {
    const cacheKey = `${CACHE_PREFIX}:${groupId}`;
    try {
        const { redis } = await import('./redisClient.mjs');
        await redis.del(cacheKey);
        console.log(`[GroupInfoCache] ✓ 已清除群 ${groupId} 的缓存`);
    } catch (error) {
        console.error(`[GroupInfoCache] ✗ 清除群 ${groupId} 缓存失败:`, error.message);
    }
}
