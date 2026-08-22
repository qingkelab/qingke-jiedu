import puppeteer from 'puppeteer-core';
import { config } from './config.js';

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: config.chromePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
        ],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/**
 * 将网页渲染为全页截图（超长页面按 config.webSegmentHeight 分段）。
 * @returns {Promise<Array<{pageNumber:number, width:number, height:number, buffer:Buffer, label:string}>>}
 */
export async function webToImages(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: config.webViewportWidth,
      height: 900,
      deviceScaleFactor: config.webDeviceScale,
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.fetchTimeoutMs });
    // 等待字体与懒加载稳定
    await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    const metrics = await page.evaluate(() => {
      const h = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0,
      );
      const w = Math.max(
        document.body ? document.body.scrollWidth : 0,
        document.documentElement ? document.documentElement.scrollWidth : 0,
        window.innerWidth,
      );
      return { height: h, width: w };
    });

    const width = Math.min(metrics.width, config.webViewportWidth);
    const height = Math.max(metrics.height, 900);
    const seg = Math.floor(config.webSegmentHeight / config.webDeviceScale);

    const images = [];
    let idx = 0;
    for (let y = 0; y < height; y += seg) {
      const h = Math.min(seg, height - y);
      idx += 1;
      const buf = await page.screenshot({
        clip: { x: 0, y, width, height: h },
      });
      images.push({
        pageNumber: idx,
        width: Math.round(width * config.webDeviceScale),
        height: Math.round(h * config.webDeviceScale),
        buffer: buf,
        label: height > seg ? `第 ${idx} 段` : '全页',
      });
    }
    return images;
  } finally {
    await page.close();
  }
}

/** 关闭浏览器（进程退出时调用） */
export async function closeBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      /* ignore */
    }
    browserPromise = null;
  }
}
