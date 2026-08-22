// pdfjs-dist 单例加载（Node 端使用 legacy 构建，免独立 worker）
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let pdfjs;

export async function loadPdfjs() {
  if (!pdfjs) {
    const require = createRequire(import.meta.url);
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Node 端 fake worker 通过 import(workerSrc) 加载，必须是 file:// URL
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  }
  return pdfjs;
}

/**
 * 从 PDF Buffer 创建文档对象。
 */
export async function getPdfDocument(buffer) {
  const lib = await loadPdfjs();
  // Buffer 是 Uint8Array 的子类，pdfjs v4 明确要求纯 Uint8Array，故始终拷贝一份
  const data = new Uint8Array(buffer);
  const loadingTask = lib.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  return loadingTask.promise;
}
