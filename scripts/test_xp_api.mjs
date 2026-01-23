/**
 * xp医生 API 测试脚本
 * 测试窗口模式下多条群聊消息的请求响应
 * 
 * 测试内容：
 * 1. emohaa 心理咨询模型
 * 2. GLM-4-Flash-250414 免费模型（用于智能回复判断）
 */

import https from 'https';

// ============ 配置 ============
const apiKey = '75625aaf77abfdd2b74d5b284e4de142.1SpPb6BuBOkq2Lo0';

// xp医生配置
const xpDoctorConfig = {
  model: 'emohaa',
  api: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  meta: {
    user_info: '一位在QQ群体社交中寻求心理支持的QQ群群友',
    bot_info: '持有执业执照的Xenial Psychology（友善关系心理学）专家，专注于人际关系模式分析、社交焦虑干预与群体动力学研究。采用非评判性倾听、认知重构与角色扮演疗法，帮助个体建立健康的社交边界与情感表达方式。所有咨询遵循PAC（Professionally Anonymous Consultation）保密协议。',
    bot_name: 'X.P.咨询师',
    user_name: '群友'
  }
};

// GLM-4-Flash 智能判断配置
const flashJudgeConfig = {
  model: 'GLM-4-Flash-250414',  // 免费模型
  api: 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
};

// 模拟群聊上下文（已清理CQ码后的格式）
const groupContext = [
  '群友A: 最近工作压力好大啊',
  '群友B: 我也是，感觉每天都很焦虑',
  '群友C: [图片]',
  '群友A: 有没有什么好的解压方法？',
  '群友D: [@] 你怎么看',
  '测试用户: 我感觉有点抑郁'
].join('\n');

// ============ 工具函数 ============

// 创建JWT token (简化版，实际项目中使用auth.mjs)
function createSimpleJWT(apiKey) {
  return `Bearer ${apiKey}`;
}

// 发送API请求
function sendRequest(requestBody, testName) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(requestBody);
    
    const options = {
      hostname: 'open.bigmodel.cn',
      port: 443,
      path: '/api/paas/v4/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': createSimpleJWT(apiKey),
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`\n===== [${testName}] 响应状态 =====`);
        console.log('Status:', res.statusCode);
        
        try {
          const json = JSON.parse(data);
          console.log(`\n===== [${testName}] 响应内容 =====`);
          console.log(JSON.stringify(json, null, 2));
          
          if (json.choices && json.choices[0]) {
            console.log(`\n===== [${testName}] AI 回复内容 =====`);
            console.log(json.choices[0].message?.content || '无内容');
          }
          
          if (json.error) {
            console.log(`\n===== [${testName}] 错误信息 =====`);
            console.log(json.error);
          }
          
          resolve(json);
        } catch (e) {
          console.log('原始响应:', data);
          reject(e);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error(`[${testName}] 请求错误:`, e.message);
      reject(e);
    });
    
    req.write(postData);
    req.end();
  });
}

// ============ 测试用例 ============

// 测试1: xp医生 emohaa 模型
async function testEmohaa() {
  console.log('\n' + '='.repeat(60));
  console.log('测试1: xp医生 emohaa 心理咨询模型');
  console.log('='.repeat(60));
  
  const requestBody = {
    model: xpDoctorConfig.model,
    messages: [
      {
        role: 'system',
        content: xpDoctorConfig.meta.bot_info
      },
      {
        role: 'assistant',
        content: `【当前群聊讨论背景，请结合以下内容理解用户的问题】\n${groupContext}`
      },
      {
        role: 'user',
        content: 'xp医生，我最近在群里和朋友聊天时总感觉自己说的话很奇怪，害怕别人觉得我很烦，这是怎么回事？'
      }
    ],
    meta: xpDoctorConfig.meta,
    stream: false
  };
  
  console.log('模型:', xpDoctorConfig.model);
  console.log('场景: 窗口模式 + 群聊上下文');
  console.log('\n===== 请求体 =====');
  console.log(JSON.stringify(requestBody, null, 2));
  console.log('\n===== 发送请求中... =====');
  
  return sendRequest(requestBody, 'emohaa');
}

// 测试2: GLM-4-Flash 智能回复判断
async function testFlashJudge() {
  console.log('\n' + '='.repeat(60));
  console.log('测试2: GLM-4-Flash-250414 智能回复判断');
  console.log('='.repeat(60));
  
  // 构建判断提示词
  const judgePrompt = `你是一个QQ群聊消息分析助手。你需要判断作为"X.P.咨询师"（一名心理咨询专家）是否应该主动回复当前的群聊消息。

【角色定位】
X.P.咨询师是群里的心理咨询专家，专注于：
- 人际关系问题
- 社交焦虑
- 情绪困扰
- 心理压力

【判断标准】
应该回复的情况（reply: true）：
1. 有人直接@或提到"xp医生"、"医生"、"咨询师"
2. 有人表达明显的心理困扰、情绪问题
3. 有人寻求建议或帮助解决人际关系问题
4. 对话内容涉及心理健康话题且停滞，需要专业引导

不应该回复的情况（reply: false）：
1. 日常闲聊、开玩笑
2. 讨论与心理健康无关的话题（游戏、美食等）
3. 群友之间的正常互动
4. 纯分享内容（图片、链接）无需回应

【当前群聊记录】
${groupContext}

【最新消息】
测试用户: 我感觉有点抑郁

请分析以上内容，判断是否应该回复。只输出JSON格式：
{"reply": true/false, "reason": "判断理由（简短）", "confidence": 0.0-1.0}`;

  const requestBody = {
    model: flashJudgeConfig.model,
    messages: [
      {
        role: 'user',
        content: judgePrompt
      }
    ],
    stream: false,
    temperature: 0.1,  // 低温度，更确定性的输出
    max_tokens: 200,   // 限制输出长度
    response_format: { type: 'json_object' }  // 要求JSON输出
  };
  
  console.log('模型:', flashJudgeConfig.model);
  console.log('场景: 智能判断是否应该回复');
  console.log('\n===== 请求体 =====');
  console.log(JSON.stringify(requestBody, null, 2));
  console.log('\n===== 发送请求中... =====');
  
  return sendRequest(requestBody, 'GLM-4-Flash');
}

// 测试3: GLM-4-Flash 不需要回复的场景
async function testFlashJudgeNoReply() {
  console.log('\n' + '='.repeat(60));
  console.log('测试3: GLM-4-Flash-250414 判断 - 不需要回复场景');
  console.log('='.repeat(60));
  
  const casualContext = [
    '群友A: 今天中午吃什么',
    '群友B: 我想吃火锅',
    '群友C: [图片]',
    '群友A: 这个看起来好好吃',
    '群友D: 晚上一起去？',
    '群友B: 好啊好啊'
  ].join('\n');
  
  const judgePrompt = `你是一个QQ群聊消息分析助手。你需要判断作为"X.P.咨询师"（一名心理咨询专家）是否应该主动回复当前的群聊消息。

【角色定位】
X.P.咨询师是群里的心理咨询专家，专注于：
- 人际关系问题
- 社交焦虑
- 情绪困扰
- 心理压力

【判断标准】
应该回复的情况（reply: true）：
1. 有人直接@或提到"xp医生"、"医生"、"咨询师"
2. 有人表达明显的心理困扰、情绪问题
3. 有人寻求建议或帮助解决人际关系问题
4. 对话内容涉及心理健康话题且停滞，需要专业引导

不应该回复的情况（reply: false）：
1. 日常闲聊、开玩笑
2. 讨论与心理健康无关的话题（游戏、美食等）
3. 群友之间的正常互动
4. 纯分享内容（图片、链接）无需回应

【当前群聊记录】
${casualContext}

【最新消息】
群友B: 好啊好啊

请分析以上内容，判断是否应该回复。只输出JSON格式：
{"reply": true/false, "reason": "判断理由（简短）", "confidence": 0.0-1.0}`;

  const requestBody = {
    model: flashJudgeConfig.model,
    messages: [
      {
        role: 'user',
        content: judgePrompt
      }
    ],
    stream: false,
    temperature: 0.1,
    max_tokens: 200,
    response_format: { type: 'json_object' }
  };
  
  console.log('模型:', flashJudgeConfig.model);
  console.log('场景: 日常闲聊（不需要回复）');
  console.log('\n===== 请求体 =====');
  console.log(JSON.stringify(requestBody, null, 2));
  console.log('\n===== 发送请求中... =====');
  
  return sendRequest(requestBody, 'GLM-4-Flash-NoReply');
}

// ============ 运行测试 ============

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║          xp医生 API 测试套件                                 ║');
  console.log('║  包含: emohaa + GLM-4-Flash-250414 智能判断                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  try {
    // 测试1: emohaa模型
    await testEmohaa();
    
    console.log('\n等待2秒后继续...\n');
    await new Promise(r => setTimeout(r, 2000));
    
    // 测试2: Flash判断（应该回复）
    await testFlashJudge();
    
    console.log('\n等待2秒后继续...\n');
    await new Promise(r => setTimeout(r, 2000));
    
    // 测试3: Flash判断（不应该回复）
    await testFlashJudgeNoReply();
    
    console.log('\n' + '='.repeat(60));
    console.log('所有测试完成！');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('测试过程中出错:', error);
  }
}

// 运行
runAllTests();
