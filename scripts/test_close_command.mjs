/**
 * 测试窗口关闭命令
 */

import { readFileSync } from 'fs';
import { parse } from 'jsonc-parser';

// 读取配置
const configPath = 'd:\\koharu\\cqps\\config.jsonc';
const configContent = readFileSync(configPath, 'utf-8');
const config = parse(configContent);

// 获取聊天窗口配置
const chatWindowConfig = config.bot.characterglm.chatWindow;

console.log('=== 聊天窗口命令列表 ===');
console.log(`启用状态: ${chatWindowConfig.enable}`);
console.log(`命令数量: ${chatWindowConfig.commands.length}\n`);

chatWindowConfig.commands.forEach((cmd, index) => {
  console.log(`【命令 ${index + 1}】`);
  console.log(`  触发: ${cmd.trigger}`);
  if (cmd.isCloseCommand) {
    console.log(`  类型: 关闭命令 ✅`);
    console.log(`  关闭消息: ${cmd.replyOnClose}`);
  } else {
    console.log(`  类型: 打开命令`);
    console.log(`  角色: ${cmd.characterName}`);
    console.log(`  模型: ${cmd.model}`);
    console.log(`  智能回复: ${cmd.smartReply?.enable ? '启用' : '禁用'}`);
  }
  console.log('');
});

console.log('=== 测试结果 ===');
const closeCmd = chatWindowConfig.commands.find(cmd => cmd.isCloseCommand);
if (closeCmd && closeCmd.trigger === '/结束会诊') {
  console.log('✅ 关闭命令配置正确');
} else {
  console.log('❌ 关闭命令配置有问题');
}
