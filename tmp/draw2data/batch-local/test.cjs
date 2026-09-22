const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identifyMetadata, scanPdfs, buildArtifacts, buildAuditArtifacts, auditBatch, hasLocation, needsAnalysis, normalizeRoot, formatDuration, probableCause } = require('./analisar-lote.cjs');
const { ENGINE_VERSION, DETAILED_ENGINE_VERSION, FLAT_BAR_ENGINE_VERSION, analysisVersionFor, preferFlatBarProfileView } = require('../../../draw2data/processing.cjs');

const analysis = { tool: 'NAO_IDENTIFICADO', dimensions: [] };
assert.equal(identifyMetadata('42-0312.pdf', analysis).tool, '42-0312');
assert.equal(identifyMetadata('42-314.pdf', analysis).tool, '42-314');
assert.equal(identifyMetadata('45-157B.pdf', analysis).tool, '45-157B');
assert.equal(identifyMetadata('AG-012 SB.PDF', analysis).tool, 'AG-012');
assert.equal(identifyMetadata('BC-002.PDF', analysis).tool, 'BC-002');
const named = identifyMetadata('TP-8377_SEQ04_REV02.pdf', analysis);
assert.equal(ENGINE_VERSION, '3.8-black-and-blue-titleblock-filter');
assert.equal(DETAILED_ENGINE_VERSION, '3.6-black-and-blue-titleblock-filter');
assert.equal(FLAT_BAR_ENGINE_VERSION, '3.7-black-and-blue-titleblock-filter');
assert.equal(analysisVersionFor('BC-507.pdf'), FLAT_BAR_ENGINE_VERSION);
assert.equal(analysisVersionFor('TP-8377.pdf'), ENGINE_VERSION);
assert.equal(analysisVersionFor('TP-8377.pdf', { detailedScan: true }), DETAILED_ENGINE_VERSION);
assert.equal(needsAnalysis({ fingerprint: 'same', analysis: { engineVersion: '3.0-spatial-lab' } }, 'same'), true);
assert.equal(needsAnalysis({ fingerprint: 'same', analysis: { engineVersion: ENGINE_VERSION } }, 'same'), false);
assert.equal(needsAnalysis({ fingerprint: 'same', engineVersion: ENGINE_VERSION, error: 'rede indisponível' }, 'same'), false);
assert.equal(needsAnalysis({ fingerprint: 'same', engineVersion: ENGINE_VERSION, error: 'rede indisponível' }, 'same', ENGINE_VERSION, true), true);
assert.equal(needsAnalysis({ fingerprint: 'old', analysis: { engineVersion: ENGINE_VERSION } }, 'same'), true);
assert.equal(normalizeRoot('U:\\pdf produtos\\'), normalizeRoot('u:/PDF produtos'));
assert.equal(formatDuration(3723000), '01:02:03');
assert.match(probableCause(new Error('EACCES: permission denied')), /permissão/i);
assert.match(probableCause(new Error('ETIMEDOUT')), /rede/i);
assert.equal(named.tool, 'TP-8377');
assert.equal(named.sequence, null);
assert.equal(named.revision, '02');
assert.equal(named.metadataReview, false);
const twoPageSelection = preferFlatBarProfileView([
  { page: 1, x: 15, width: 10, rawText: '160 ± 0,75', symbol: '' },
  { page: 2, x: 60, width: 8, rawText: '160 ± 0,75', symbol: '' },
  { page: 2, x: 85, width: 4, rawText: 'R3', symbol: 'R' }
], [
  { page: 1, width: 100, text: 'EP Especificação Embalagem' },
  { page: 2, width: 100, text: 'Desenho da ferramenta' }
]);
assert.deepEqual(twoPageSelection.dimensions.map(item => item.rawText), ['160 ± 0,75', 'R3']);
assert.deepEqual(twoPageSelection.diagnostics.ignoredPackagingPages, [1]);
const twoPageWithoutRadius = preferFlatBarProfileView([
  { page: 1, x: 12, width: 8, rawText: '120 ± 0,86', symbol: '' },
  { page: 1, x: 18, width: 5, rawText: '3 ± 0,15', symbol: '' },
  { page: 2, x: 65, width: 8, rawText: '120 ± 0,86', symbol: '' },
  { page: 2, x: 82, width: 5, rawText: '3 ± 0,15', symbol: '' }
], [
  { page: 1, width: 100, text: 'Embalagem da ferramenta' },
  { page: 2, width: 100, text: 'Vista técnica' }
]);
assert.equal(twoPageWithoutRadius.diagnostics.ignoredPackagingPages.includes(1), true);
assert.equal(twoPageWithoutRadius.dimensions.every(item => item.page === 2), true);
const uncertainPage = preferFlatBarProfileView([
  { page: 1, x: 10, width: 5, rawText: '120', symbol: '' }
], [{ page: 1, width: 100, text: 'Embalagem' }]);
assert.equal(uncertainPage.dimensions.length, 1);
const samePageSelection = preferFlatBarProfileView([
  { page: 1, x: 15, width: 10, rawText: '160 ± 0,75', symbol: '' },
  { page: 1, x: 60, width: 8, rawText: '160 ± 0,75', symbol: '' },
  { page: 1, x: 85, width: 4, rawText: 'R3', symbol: 'R' }
], [{ page: 1, width: 100, text: 'EP Embalagem Perfil BC' }]);
assert.deepEqual(samePageSelection.dimensions.map(item => item.rawText), ['160 ± 0,75', 'R3']);
const genericTool = identifyMetadata('TP-8377.pdf', analysis);
assert.equal(genericTool.sequence, null);
assert.equal(genericTool.metadataReview, true);
assert.equal(genericTool.metadataReviewReason, 'revisão');
assert.equal(identifyMetadata('desenho sem código.pdf', { tool: 'TP-8360' }).tool, 'TP-8360');
assert.equal(hasLocation({ page: 1, x: 10, y: 20, width: 5, height: 8 }), true);
assert.equal(hasLocation({ page: 0, x: 10, y: 20, width: 5, height: 8 }), false);
assert.equal(hasLocation({ page: 1, x: 10, y: 20, width: 0, height: 8 }), false);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'draw2data-batch-check-'));
try {
  fs.mkdirSync(path.join(output, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(output, '42-0312.pdf'), '%PDF-');
  fs.writeFileSync(path.join(output, '~$rascunho.pdf'), 'temporário');
  fs.writeFileSync(path.join(output, 'sub', 'AG-012 SB.PDF'), '%PDF-');
  assert.deepEqual(scanPdfs(output, false).files.map(file => path.basename(file)), ['42-0312.pdf']);
  assert.equal(scanPdfs(output, true).files.length, 2);
  const manifest = { sourceRoot: 'U:\\', files: { '42-0312.pdf': { relativePath: '42-0312.pdf', sourcePath: 'U:\\42-0312.pdf', sizeBytes: 1000, tool: '42-0312', toolSource: 'NOME_DO_ARQUIVO', sequence: null, revision: '00', metadataReview: true, metadataReviewReason: 'sequência; revisão', analysis: { method: 'VETORIAL', engineVersion: 'test', warnings: [], diagnostics: {}, dimensions: [{ page: 1, rawText: '50 ± 0,2', nominal: 50, tolerancePlus: .2, toleranceMinus: .2, confidence: .9, status: 'CONFIRMADO', source: 'VECTOR' }] } } } };
  buildArtifacts(manifest, output);
  buildArtifacts(manifest, output);
  const profiles = JSON.parse(fs.readFileSync(path.join(output, 'manifesto-perfis.json'), 'utf8'));
  assert.equal(profiles.profiles[0].tool, '42-0312');
  assert.equal(profiles.profiles[0].importStatus, 'REVISAR_CADASTRO');
  assert.ok(fs.statSync(path.join(output, 'relatorio-do-lote.xlsx')).size > 0);
  const workbook = require('xlsx').readFile(path.join(output, 'relatorio-do-lote.xlsx'));
  const sheetRows = require('xlsx').utils.sheet_to_json(workbook.Sheets.Cotas);
  assert.equal(sheetRows[0]['Evidência visual'], 'Sem posição; conferir no PDF original');
  assert.equal(require('xlsx').utils.sheet_to_json(workbook.Sheets.Indicadores).length, 1);

  const source = path.join(output, 'audit-source');
  fs.mkdirSync(source, { recursive: true });
  for (const name of ['DIN-005.PDF', 'DIN-006.PDF', 'DIN-007.PDF']) fs.writeFileSync(path.join(source, name), '%PDF-fixture');
  const fingerprintOf = name => { const stat = fs.statSync(path.join(source, name)); return `${stat.size}:${stat.mtimeMs}`; };
  const settings = { mode: 'complete', maxPages: 10, includePlain: true, minConfidence: 0, detailedScan: true };
  const expected = analysisVersionFor('DIN-007.PDF', settings);
  const auditManifest = {
    sourceRoot: source, settings, files: {
      'DIN-005.PDF': { relativePath: 'DIN-005.PDF', sourcePath: path.join(source, 'DIN-005.PDF'), fingerprint: fingerprintOf('DIN-005.PDF'), tool: 'DIN-005', revision: '00', analysis: { engineVersion: '3.3-old', dimensions: [], warnings: [] } },
      'DIN-007.PDF': { relativePath: 'DIN-007.PDF', sourcePath: path.join(source, 'DIN-007.PDF'), fingerprint: fingerprintOf('DIN-007.PDF'), tool: 'DIN-007', revision: '00', analysis: { engineVersion: expected, dimensions: [{ page: 1, x: 20, y: 30, width: 10, height: 4, rawText: '50', nominal: 50, confidence: .55, status: 'REVISAR', reviewReason: 'Conferir' }], warnings: [] } },
      'REMOVIDO.PDF': { relativePath: 'REMOVIDO.PDF', sourcePath: path.join(source, 'REMOVIDO.PDF'), tool: 'REMOVIDO', revision: '00', analysis: { engineVersion: expected, dimensions: [], warnings: [] } }
    }
  };
  const auditScan = { files: ['DIN-005.PDF', 'DIN-006.PDF', 'DIN-007.PDF'].map(name => path.join(source, name)), inaccessible: [] };
  const audit = auditBatch(auditManifest, auditScan, settings);
  assert.equal(audit.summary.notAnalyzed, 1);
  assert.equal(audit.summary.noDimensions, 1);
  assert.equal(audit.summary.olderEngine, 1);
  assert.equal(audit.summary.reviewDimensions, 1);
  assert.equal(audit.summary.sourceFilesNotFound, 1);
  const offlineAudit = auditBatch(auditManifest, { files: [], inaccessible: [{ folder: source, error: 'ETIMEDOUT' }] }, settings);
  assert.equal(offlineAudit.summary.inaccessibleFolders, 1);
  assert.ok(offlineAudit.sourceMissing.every(row => row.Status === 'ORIGEM_INACESSÍVEL'));
  const din005Audit = audit.files.find(row => row.relativePath === 'DIN-005.PDF');
  assert.match(din005Audit.flags, /VERSÃO_ANTERIOR/);
  assert.match(din005Audit.flags, /SEM_COTAS/);
  assert.equal(audit.files.find(row => row.relativePath === 'DIN-006.PDF').status, 'NÃO_ANALISADO');
  const checkpoint = path.join(output, 'checkpoint.json');
  fs.writeFileSync(checkpoint, '{"sentinel":"preservar"}');
  buildAuditArtifacts(auditManifest, auditScan, output, settings);
  assert.equal(fs.readFileSync(checkpoint, 'utf8'), '{"sentinel":"preservar"}');
  const auditBook = require('xlsx').readFile(path.join(output, 'auditoria-do-lote.xlsx'));
  assert.ok(auditBook.SheetNames.includes('Pendentes'));
  assert.ok(auditBook.SheetNames.includes('Sem cotas'));
  assert.ok(auditBook.SheetNames.includes('Cotas revisar'));
  const noDimensions = require('xlsx').utils.sheet_to_json(auditBook.Sheets['Sem cotas']);
  assert.equal(noDimensions.find(row => row.Arquivo === 'DIN-005.PDF').Situação, 'VERSÃO_ANTERIOR');
} finally { fs.rmSync(output, { recursive: true, force: true }); }
console.log('Draw2Data local batch filename metadata: OK');
