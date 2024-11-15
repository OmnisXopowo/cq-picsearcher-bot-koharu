import CronParser from 'cron-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前模块的文件路径
const __filename = fileURLToPath(import.meta.url);
// 获取当前模块的目录路径
const __dirname = path.dirname(__filename);

// 回退两级目录
const rootDirectory = path.join(__dirname, '../../');
const dataCacheDirectory = path.join(rootDirectory, 'data', 'cache');
const dataFilePath = path.join(dataCacheDirectory, 'map.json');

class DailyCount {
  constructor() {
    this.map = {};
    this.cron = CronParser.parseExpression('0 0 * * *');
    this.dataCacheDirectory = dataCacheDirectory;
    this.dataFilePath = dataFilePath;
    this.loadMap();
    this.clearOnNextDay();
    this.setupHourlyPersistence();
  }

  clearOnNextDay() {
    setTimeout(() => {
      this.map = {};
      this.saveMap();
      this.clearOnNextDay();
    }, this.cron.next().getTime() - Date.now());
  }

  loadMap() {
    try {
      const data = fs.readFileSync(this.dataFilePath, 'utf8');
      this.map = JSON.parse(data);
    } catch (error) {
      // 如果文件不存在或读取出错，则使用空对象
      this.map = {};
      // 确保初始时创建map文件
      this.saveMap();
    }
  }

  saveMap() {
    // 确保目录存在
    if (!fs.existsSync(this.dataCacheDirectory)) {
      fs.mkdirSync(this.dataCacheDirectory, { recursive: true });
    }
    // 写入文件
    fs.writeFileSync(this.dataFilePath, JSON.stringify(this.map), 'utf8');
  }

  setupHourlyPersistence() {
    this.hourlySaveTimer = setInterval(() => {
      this.saveMap();
    }, 60 * 60 * 1000);
  }

  saveAndResetTimer() {
    this.saveMap(); // 立即保存map
    clearInterval(this.hourlySaveTimer); // 清除现有的定时器
    this.setupHourlyPersistence(); // 重新设置定时器
  }


  // 获取调用模块的名称
  getCallerModuleName() {
    const stack = new Error().stack;
    const lines = stack.split('\n').slice(2); // 跳过前两行，因为它们不是堆栈跟踪的一部分
    const callerLine = lines[0];
    const callerFile = callerLine.match(/at [^(]*\((.*)\)/)[1];
    return path.basename(callerFile, '.js');
  }


  getCallerModuleName() {
    try {
      const stack = new Error().stack;
      const lines = stack.split('\n').slice(3);
      const callerLine = lines[0];
      const callerFile = callerLine.match(/(.*):(\d+):(\d+)/)[1];
      return path.basename(callerFile, '.js');
    } catch (error) {
      // 如果获取模块名失败，返回一个默认值
      return 'unknown_module';
    }
  }

  add(key, moduleName) {
    const fullKey = moduleName ? `${key}:${moduleName}` : `${key}:${this.getCallerModuleName()}`;
    if (!(fullKey in this.map)) this.map[fullKey] = 0;
    this.map[fullKey]++;
  }

  sub(key, moduleName) {
    const fullKey = moduleName ? `${key}:${moduleName}` : `${key}:${this.getCallerModuleName()}`;
    if (this.map[fullKey] > 0) this.map[fullKey]--;
  }

  get(key, moduleName) {
    const fullKey = moduleName ? `${key}:${moduleName}` : `${key}:${this.getCallerModuleName()}`;
    return this.map[fullKey] || 0;
  }
}

// 创建DailyCount的单例实例
const dailyCountInstance = new DailyCount();

// 导出单例实例
export default dailyCountInstance;