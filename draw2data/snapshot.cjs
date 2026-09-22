const { loadPdfJs } = require('./pdfjs.cjs');

async function renderDimensionSnapshot(bytes, dimension) {
  const pdfjs = await loadPdfJs();
  const pageNumber = Math.round(Number(dimension?.page));
  const x = Number(dimension?.x), y = Number(dimension?.y), width = Number(dimension?.width), height = Number(dimension?.height);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw Error('Esta cota não possui uma posição segura no desenho.');
  }
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: true }).promise;
  try {
    if (pageNumber > document.numPages) throw Error('Página da cota não encontrada no PDF.');
    const page = await document.getPage(pageNumber);
    const scale = 3;
    const viewport = page.getViewport({ scale });
    if (viewport.width * viewport.height > 32000000) throw Error('Página grande demais para gerar o recorte visual.');
    const source = document.canvasFactory.create(viewport.width, viewport.height);
    try {
      await page.render({ canvasContext: source.context, viewport }).promise;
      const margin = Math.max(58, Math.min(92, Math.max(width, height) * 4));
      const pageWidth = viewport.width / scale, pageHeight = viewport.height / scale;
      const left = Math.max(0, x - margin), right = Math.min(pageWidth, x + width + margin);
      const bottom = Math.max(0, y - margin), top = Math.min(pageHeight, y + height + margin);
      const cropX = Math.floor(left * scale), cropY = Math.floor(viewport.height - top * scale);
      const cropWidth = Math.max(1, Math.ceil((right - left) * scale)), cropHeight = Math.max(1, Math.ceil((top - bottom) * scale));
      const crop = document.canvasFactory.create(cropWidth, cropHeight);
      try {
        crop.context.fillStyle = '#ffffff';
        crop.context.fillRect(0, 0, cropWidth, cropHeight);
        crop.context.drawImage(source.canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
        const markerX = (x - left) * scale, markerY = (top - (y + height)) * scale;
        crop.context.fillStyle = 'rgba(0, 158, 149, .16)';
        crop.context.strokeStyle = '#008f88';
        crop.context.lineWidth = 4;
        crop.context.fillRect(markerX - 6, markerY - 6, width * scale + 12, height * scale + 12);
        crop.context.strokeRect(markerX - 6, markerY - 6, width * scale + 12, height * scale + 12);
        if (dimension.debug && dimension.geometryEvidence?.line) {
          const line = dimension.geometryEvidence.line, labScale = 5, cropTop = pageHeight - top;
          crop.context.save();
          crop.context.strokeStyle = '#7c3aed'; crop.context.lineWidth = 3; crop.context.setLineDash([8, 5]);
          crop.context.beginPath(); crop.context.moveTo((line.x0 / labScale - left) * scale, (line.y0 / labScale - cropTop) * scale); crop.context.lineTo((line.x1 / labScale - left) * scale, (line.y1 / labScale - cropTop) * scale); crop.context.stroke();
          crop.context.setLineDash([]); crop.context.fillStyle = '#7c3aed'; crop.context.font = 'bold 16px sans-serif'; crop.context.fillText(`${dimension.decisionClassification || 'REVIEW'} ${Math.round(Number(dimension.dimensionScore || 0))}%`, 10, 22); crop.context.restore();
        }
        const image = crop.canvas.toBuffer('image/png');
        return { bytes: image, page: pageNumber, width: cropWidth, height: cropHeight };
      } finally {
        document.canvasFactory.destroy(crop);
      }
    } finally {
      document.canvasFactory.destroy(source);
    }
  } finally {
    await document.destroy();
  }
}

module.exports = { renderDimensionSnapshot };
