/**
 * CharacterGLM / Emohaa 角色扮演AI模块
 * 
 * 功能：
 * 1. 通过昵称触发AI对话
 * 2. 通过聊天窗口命令开启指定角色会话
 * 3. 支持群聊上下文感知
 * 4. 支持多轮对话历史
 * 5. 支持智能回复判断（免费模型可配置）
 */

import { inspect } from 'util';
import { pick } from 'lodash-es';
import AxiosProxy from '../../utils/axiosProxy.mjs';
import chatWindowManager from '../../utils/chatWindowManager.mjs';
import dailyCountInstance from '../../utils/dailyCount.mjs';
import emitter from '../../utils/emitter.mjs';
import messageContextManager from '../../utils/messageContextManager.mjs';
import replyDecisionService from '../../utils/replyDecisionService.mjs';
import { retryAsync } from '../../utils/retry.mjs';
import { getglmContent, insertglmContent, deleteglmContent, createJWT } from './auth.mjs';

// 开发阶段日志（始终输出）
const log = (...args) => {
  console.log('[CharacterGLM]', ...args);
};

// 模型定义
const Models = {
  characterglm: { 
    model: 'charglm-4', 
    api: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' 
  },
  emohaa: { 
    model: 'emohaa', 
    api: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' 
  }
};

// 配置加载时初始化
emitter.onConfigLoad(() => {
  // 配置免费模型和防抖参数（如果有全局配置）
  const characterglmConfig = global.config?.bot?.characterglm;
  if (characterglmConfig?.smartReplyConfig) {
    const srConfig = characterglmConfig.smartReplyConfig;
    if (srConfig.freeModel) {
      replyDecisionService.configureModel(srConfig.freeModel);
    }
    if (srConfig.debounceDelay !== undefined || srConfig.useRandomDelay !== undefined) {
      replyDecisionService.configureDebounce(
        srConfig.debounceDelay || 3000,
        srConfig.useRandomDelay !== undefined ? srConfig.useRandomDelay : true
      );
      log(`全局智能回复参数已加载: debounce=${srConfig.debounceDelay}ms, random=${srConfig.useRandomDelay}`);
    }
  }
});

/**
 * 匹配消息并获取配置
 * @param {string} text - 消息文本
 * @param {object} context - 消息上下文
 * @returns {object} 匹配结果和配置
 */
const getMatchAndConfig = (text, context) => {
  const globalConfig = global.config.bot.characterglm;
  const chatWindowConfig = globalConfig.chatWindow;
  let match = null;
  let isWindowMode = false;
  let choosedModel = Models.characterglm;

  // 1. 检查是否是聊天窗口命令
  if (chatWindowConfig?.enable && chatWindowConfig?.commands) {
    for (const cmd of chatWindowConfig.commands) {
      if (text === cmd.trigger) {
        // 区分关闭命令和打开命令
        if (cmd.isCloseCommand) {
          log(`✅ 匹配到关闭命令: ${cmd.trigger}`);
          return {
            match: null,
            isCommand: true,
            isCloseCommand: true,
            command: cmd,
            choosedModel,
            config: pick(globalConfig, [
              'model', 'prependMessages', 'nickname', 'apiKey',
              'blackGroup', 'whiteGroup', 'meta', 'chatWindow'
            ])
          };
        } else {
          log(`✅ 匹配到窗口命令: ${cmd.trigger} -> ${cmd.characterName}`);
          return {
            match: null,
            isCommand: true,
            isCloseCommand: false,
            command: cmd,
            choosedModel,
            config: pick(globalConfig, [
              'model', 'prependMessages', 'nickname', 'apiKey',
              'blackGroup', 'whiteGroup', 'meta', 'chatWindow'
            ])
          };
        }
      }
    }
  }

  // 2. 检查聊天窗口是否激活
  if (context.group_id && chatWindowManager.isActive(context.group_id)) {
    const characterName = chatWindowManager.getCharacterName(context.group_id);
    
    // 只有启用了 characterName 触发时，才检查消息中是否包含角色名
    if (chatWindowConfig?.enableCharacterNameTrigger && characterName && text.includes(characterName)) {
      match = text;
      isWindowMode = true;
      log(`✅ 窗口模式匹配成功: 消息包含 "${characterName}"`);
      
      // 查找对应的command配置
      const activeCommand = chatWindowConfig?.commands?.find(cmd => cmd.characterName === characterName);
      
      // 窗口模式使用command指定的模型，或默认emohaa
      if (activeCommand?.model === 'emohaa' || (!activeCommand?.model && chatWindowConfig?.useEmohaa)) {
        choosedModel = Models.emohaa;
      } else if (activeCommand?.model === 'charglm-4') {
        choosedModel = Models.characterglm;
      }
      
      // 返回包含command的meta配置（用于独立人设）
      return {
        match,
        isCommand: false,
        isWindowMode: true,
        choosedModel,
        activeCommand, // 传递当前激活的command配置
        config: pick(globalConfig, [
          'model', 'prependMessages', 'nickname', 'apiKey',
          'blackGroup', 'whiteGroup', 'meta', 'chatWindow'
        ])
      };
    }
  }

  // 3. 常规昵称匹配（非窗口模式时，且启用了昵称触发）
  if (!match && globalConfig.nicknameEnable !== false) {
    if (text.startsWith(globalConfig.nickname)) {
      match = text.replace(globalConfig.nickname, '');
      log(`✅ 常规匹配: 消息以昵称 "${globalConfig.nickname}" 开头`);
    } else if (text.includes(globalConfig.nickname)) {
      match = text.replace(globalConfig.nickname, globalConfig.meta.bot_name);
      log(`✅ 常规匹配: 消息包含昵称 "${globalConfig.nickname}"`);
    } else if (text.includes(globalConfig.meta.bot_name)) {
      match = text;
      log(`✅ 常规匹配: 消息包含bot名 "${globalConfig.meta.bot_name}"`);
    }
  }

  return {
    match,
    isCommand: false,
    isWindowMode,
    choosedModel,
    config: pick(globalConfig, [
      'model', 'prependMessages', 'nickname', 'apiKey',
      'blackGroup', 'whiteGroup', 'meta', 'chatWindow'
    ])
  };
};

/**
 * 调用AI API
 * @param {string} prompt - 用户输入
 * @param {object} config - 配置
 * @param {object} context - 消息上下文
 * @param {object} choosedModel - 选用的模型
 * @param {boolean} isWindowMode - 是否为窗口模式
 * @param {object} activeCommand - 窗口模式下激活的命令配置（包含独立的meta）
 * @returns {Promise<string>} AI回复
 */
const callCharacterAPI = (prompt, config, context, choosedModel, isWindowMode = false, activeCommand = null) => {
  // 群单例，群聊模式
  const singleton = true;
  const MaxSize = 20;

  // 确定使用的meta配置：窗口模式优先使用command的meta，否则使用全局meta
  const effectiveMeta = (isWindowMode && activeCommand?.meta) ? activeCommand.meta : config.meta;
  
  log(`调用API: model=${choosedModel.model}, windowMode=${isWindowMode}, prompt="${prompt.substring(0, 50)}..."`);
  log(`使用人设: ${effectiveMeta?.bot_name || '未配置'}`);

  return retryAsync(async () => {
    const { debug } = global.config.bot;

    // 处理清空上下文命令
    if (prompt === '--r') {
      log(`执行清空上下文命令`);
      deleteglmContent(context.group_id, singleton ? '0' : context.user_id, choosedModel.model);
      if (isWindowMode) {
        messageContextManager.clearContext(context.group_id);
      }
      return '已清空上下文';
    }

    // 获取历史对话记录
    const content = getglmContent(context.group_id, singleton ? '0' : context.user_id, choosedModel.model);

    // 添加用户消息
    content.choices.push({ role: 'user', content: prompt });

    // 构建消息列表
    const messages = [];

    // 添加预设消息（窗口模式使用command的prependMessages，否则使用全局的）
    const effectivePrependMessages = (isWindowMode && activeCommand?.prependMessages) 
      ? activeCommand.prependMessages 
      : config.prependMessages;
    if (Array.isArray(effectivePrependMessages) && effectivePrependMessages.length > 0) {
      messages.push(...effectivePrependMessages);
    }

    // 窗口模式下，添加群聊上下文
    if (isWindowMode && context.group_id) {
      const contextMessages = messageContextManager.getContextMessages(
        context.group_id,
        context.user_id
      );
      if (contextMessages.length > 0) {
        messages.push(...contextMessages);
      }
    }

    // 添加历史对话
    messages.push(...content.choices);
    
    // 输出发送给该模型的messages列表
    log(`发送给${choosedModel.model}的messages:`);
    console.log(messages);

    // 构建请求参数
    const param = {
      model: choosedModel.model,
      messages,
    };

    // 添加meta参数（emohaa模型支持，使用effectiveMeta）
    if (choosedModel.model === 'emohaa' && effectiveMeta) {
      param.meta = {
        user_info: effectiveMeta.user_info || '一位需要心理支持的用户',
        bot_info: effectiveMeta.bot_info || '专业的心理咨询师',
        bot_name: effectiveMeta.bot_name || '心理咨询师',
        user_name: effectiveMeta.user_name || '用户'
      };
      log(`emohaa meta参数: bot_name=${param.meta.bot_name}`);
    }

    // 每次都在messages最前面添加系统消息，增强人设控制
    if (effectiveMeta?.bot_info) {
      param.messages.unshift({ role: 'system', content: effectiveMeta.bot_info });
      log(`添加系统消息: ${effectiveMeta.bot_name || '未命名角色'}`);
    }

    // 如果有request_id则添加（用于会话追踪）
    if (content.request_id) {
      param.request_id = content.request_id;
      log(`使用request_id: ${content.request_id}`);
    }

    // 创建JWT token
    const jwttoken = createJWT(config.apiKey);

    const headers = {
      Authorization: jwttoken,
      'Content-Type': 'application/json',
    };

    if (debug) {
      console.log(`[${choosedModel.model}] 请求参数:`, inspect(param, { depth: null }));
    }

    // 发送请求
    log(`发送API请求到 ${choosedModel.api}`);
    const { data } = await AxiosProxy.post(choosedModel.api, param, {
      headers,
      validateStatus: status => 200 <= status && status < 500,
    });

    if (debug) {
      console.log(`[${choosedModel.model}] 响应:`, inspect(data, { depth: null }));
    }

    // 处理错误响应
    if (data.error) {
      const errorMsg = data.error.message;
      console.error(`[${choosedModel.model}] API错误:`, errorMsg);
      return `ERROR: ${errorMsg}`;
    }

    // 处理正常响应
    if (data.choices && data.choices.length > 0) {
      const choiceResponse = data.choices[0];
      
      if (choiceResponse.finish_reason && choiceResponse.finish_reason.startsWith('stop')) {
        // 清理返回的消息内容
        const returnMessage = choiceResponse.message.content
          .replace(/("*)(\\n*)/g, '')
          .trim();

        log(`收到AI回复: "${returnMessage.substring(0, 50)}${returnMessage.length > 50 ? '...' : ''}"`);

        // 将AI回复添加到历史记录
        content.choices.push(choiceResponse.message);

        // 控制历史记录大小
        while (content.choices.length > MaxSize) {
          content.choices.shift();
        }

        // 保存更新后的上下文
        insertglmContent(
          context.group_id,
          singleton ? '0' : context.user_id,
          content.choices,
          data.request_id,
          choosedModel.model
        );

        return returnMessage;
      }
    }

    console.log(`[${choosedModel.model}] 意外响应:`, data);
    return 'ERROR: 无法获取回答';
  })
    .catch(e => {
      console.error(`[${choosedModel.model}] 请求失败:`, e);
      return `ERROR: ${e.message}`;
    });
};

/**
 * 处理聊天窗口命令
 * @param {object} context - 消息上下文
 * @param {object} command - 命令配置
 * @param {object} config - AI配置
 * @returns {boolean}
 */
const handleWindowCommand = (context, command, config) => {
  log(`处理窗口命令: ${command.trigger} -> ${command.characterName}`);
  
  if (!context.group_id) {
    log(`窗口命令失败: 非群聊环境`);
    global.replyMsg(context, '聊天窗口功能仅支持群聊', false, true);
    return true;
  }

  const chatWindowConfig = config.chatWindow;
  const duration = chatWindowConfig?.duration || 15 * 60 * 1000;

  log(`创建窗口: 群${context.group_id}, 角色=${command.characterName}, 时长=${duration}ms`);

  // 初始化消息上下文
  messageContextManager.initializeContext(context.group_id);

  // 配置智能回复（如果命令启用了smartReply）
  if (command.smartReply?.enable) {
    log(`配置智能回复: 群${context.group_id}, 防抖=${command.smartReply.debounceDelay || 3000}ms`);
    
    messageContextManager.configureSmartReply(context.group_id, {
      enable: true,
      commandConfig: command,
      apiKey: config.apiKey,
      onAutoReply: async (groupId, result) => {
        // 智能回复判断完成后的回调
        log(`智能回复触发: 群${groupId}, reason="${result.reason}"`);
        
        // 构建上下文摘要作为提示
        const contextSummary = messageContextManager.getContextSummary(groupId);
        const autoPrompt = `\n当前对话：\n${contextSummary}`;
        
        // 查找对应的模型
        let choosedModel = Models.characterglm;
        if (command.model === 'emohaa' || (!command.model && chatWindowConfig?.useEmohaa)) {
          choosedModel = Models.emohaa;
        }
        
        // 创建模拟context
        const autoContext = {
          group_id: groupId,
          user_id: 0,  // 自动回复，无特定用户
          message_type: 'group'
        };
        
        // 调用AI（传递command用于独立人设）
        const completion = await callCharacterAPI(
          autoPrompt, 
          config, 
          autoContext, 
          choosedModel, 
          true,  // isWindowMode
          command  // activeCommand
        );
        
        if (completion && !completion.startsWith('ERROR:')) {
          log(`智能回复发送: 群${groupId}, "${completion.substring(0, 50)}..."`);
          // 记录本次回复（用于频率控制）
          replyDecisionService.recordReply(groupId);
          // 发送消息到群组
          global.replyMsg({ 
            group_id: groupId,
            message_type: 'group'
          }, completion, false, true);
        } else if (completion?.startsWith('ERROR:')) {
          log(`智能回复调用失败: ${completion}`);
        }
      }
    });
  }

  // 创建聊天窗口
  chatWindowManager.createWindow(
    context.group_id,
    command.characterName,
    config,
    duration
  );

  // 发送开启消息
  const replyMsg = command.replyOnOpen || 
    `已开启${command.characterName}会诊窗口(${duration / 60000}分钟内有效)，在消息中提及"${command.characterName}"即可触发回复。`;
  
  global.replyMsg(context, replyMsg, false, true);

  return true;
};

/**
 * 处理关闭命令 - 关闭活跃的聊天窗口
 * @param {object} context - 消息上下文
 * @param {object} command - 关闭命令配置
 * @returns {boolean}
 */
const handleCloseCommand = (context, command) => {
  log(`处理关闭命令: ${command.trigger}`);
  
  if (!context.group_id) {
    log(`关闭命令失败: 非群聊环境`);
    global.replyMsg(context, '关闭窗口功能仅支持群聊', false, true);
    return true;
  }

  // 检查是否有活跃的窗口
  if (!chatWindowManager.isActive(context.group_id)) {
    log(`群${context.group_id}无活跃窗口`);
    global.replyMsg(context, '当前没有活跃的会诊窗口', false, true);
    return true;
  }

  const characterName = chatWindowManager.getCharacterName(context.group_id);
  log(`关闭窗口: 群${context.group_id}, 角色=${characterName}`);

  // 清理消息上下文
  messageContextManager.clearContext(context.group_id);
  
  // 关闭窗口
  chatWindowManager.closeWindow(context.group_id);

  // 发送关闭消息
  const replyMsg = command.replyOnClose || '已关闭会诊窗口，期待下次为您服务！';
  global.replyMsg(context, replyMsg, false, true);

  return true;
};

/**
 * 主导出函数 - 处理消息
 * @param {object} context - 消息上下文
 * @returns {Promise<boolean>} 是否已处理消息
 */
export default async context => {  
  const { match, isCommand, isCloseCommand, command, choosedModel, config, isWindowMode, activeCommand } = getMatchAndConfig(context.message, context);

  // 处理关闭命令
  if (isCommand && isCloseCommand && command) {
    return handleCloseCommand(context, command);
  }

  // 处理窗口打开命令
  if (isCommand && command && !isCloseCommand) {
    return handleWindowCommand(context, command, config);
  }

  // 如果没有匹配，不处理
  if (!match) {
    return false;
  }

  // 窗口模式下刷新计时器，并取消待判断任务（用户已主动呼叫，不需要智能判断了）
  if (isWindowMode && context.group_id) {
    log(`窗口模式：刷新计时器，取消智能回复待判断任务`);
    chatWindowManager.refreshWindow(context.group_id);
    messageContextManager.cancelSmartReplyJudge(context.group_id);
  }

  // 检查黑白名单
  if (context.group_id) {
    const { blackGroup, whiteGroup } = config;
    if (blackGroup && blackGroup.has && blackGroup.has(context.group_id)) {
      log(`群${context.group_id}在黑名单中，跳过`);
      return true;
    }
    if (whiteGroup && whiteGroup.size && !whiteGroup.has(context.group_id)) {
      log(`群${context.group_id}不在白名单中，跳过`);
      return true;
    }
  }

  // 检查APIKey配置
  if (!config.apiKey) {
    log(`APIKey未配置`);
    global.replyMsg(context, '未配置 APIKey', false, true);
    return true;
  }

  // 清理消息内容，将CQ码转换为文本说明
  const prompt = match
    ?.replace(/\[CQ:image[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
    .replace(/\[CQ:at,qq=all[^\]]*\]/g, '[@全体成员]')
    .replace(/\[CQ:at[^\]]*\]/g, '[@]')
    .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
    .replace(/\[CQ:reply[^\]]*\]/g, '')
    .replace(/\[CQ:[^\]]+\]/g, '')  // 其他未知CQ码直接移除
    .trim();
  if (!prompt) {
    log(`清理后的prompt为空，跳过`);
    return true;
  }

  // 检查用户每日限制
  const { userDailyLimit } = global.config.bot.characterglm;
  if (userDailyLimit) {
    if (dailyCountInstance.get(context.user_id) >= userDailyLimit) {
      log(`用户${context.user_id}超出每日限制`);
      global.replyMsg(context, '今天玩的够多啦，明天再来吧！', false, true);
      return true;
    } else {
      dailyCountInstance.add(context.user_id);
    }
  }

  log(`准备调用API: prompt="${prompt.substring(0, 30)}...", model=${choosedModel.model}, windowMode=${isWindowMode}`);
  if (activeCommand) {
    log(`使用窗口角色: ${activeCommand.characterName}, meta.bot_name=${activeCommand.meta?.bot_name}`);
  }

  if (global.config.bot.debug) {
    console.log('[characterglm] prompt:', prompt);
    console.log('[characterglm] isWindowMode:', isWindowMode);
    console.log('[characterglm] model:', choosedModel.model);
    console.log('[characterglm] activeCommand:', activeCommand?.characterName);
  }

  // 调用AI获取回复（传递activeCommand用于窗口模式的独立人设）
  const completion = await callCharacterAPI(prompt, config, context, choosedModel, isWindowMode, activeCommand);

  log(`发送回复: "${completion.substring(0, 50)}..."`);
  
  // 发送回复
  global.replyMsg(context, completion, false, true);

  return true;
};

/**
 * 导出聊天窗口管理器，供外部使用
 */
export { chatWindowManager, messageContextManager };