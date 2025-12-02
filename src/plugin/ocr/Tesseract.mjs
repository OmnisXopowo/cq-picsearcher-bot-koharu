import { createWorker } from 'tesseract.js';

async function recognizeChineseText(imagePath) {
  const worker = createWorker({
    logger: m => console.log(m)
  });

  try {
    await worker.load();
    await worker.loadLanguage('chi_sim');
    await worker.initialize('chi_sim');

    const { data: { text } } = await worker.recognize(imagePath);
    console.log('Recognized text:', text);
  } catch (error) {
    console.error('Error during recognition:', error);
  } finally {
    await worker.terminate();
  }
}

// 使用示例
// recognizeChineseText('https://xxx/img/chi_sim.png');

/**
 * OCR 识别
 *
 * @param {{ url: string }} url 图片地址
 * @returns {Promise<string[]>} 识别结果
 */
export default async ({ url }) =>{
    const worker = createWorker({
    logger: m => console.log(m)
  });

  try {
    await worker.load();
    await worker.loadLanguage('chi_sim');
    await worker.initialize('chi_sim');

    const { data: { text } } = await worker.recognize(imagePath);
    console.log('Recognized text:', text);
  } catch (error) {
    console.error('Error during recognition:', error);
  } finally {
    await worker.terminate();
  }
};