let pdfModule;
let workerModule;

function installPdfRuntime() {
  const canvas = require('@napi-rs/canvas');
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
  if (!globalThis.ImageData) globalThis.ImageData = canvas.ImageData;
  if (!globalThis.Path2D) globalThis.Path2D = canvas.Path2D;
  return canvas;
}

async function loadPdfJs() {
  installPdfRuntime();
  workerModule ||= import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  await workerModule;
  return pdfModule || (pdfModule = import('pdfjs-dist/legacy/build/pdf.mjs'));
}

module.exports = { installPdfRuntime, loadPdfJs };
