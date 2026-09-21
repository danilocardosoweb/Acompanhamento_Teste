const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { processDrawing, analysisVersionFor, drawingOptions } = require('./processing.cjs');
const { renderDimensionSnapshot } = require('./snapshot.cjs');

const DEFAULT_OUTPUT = path.join(os.homedir(), 'Documents', 'Draw2Data-Resultados', 'lote-atualizado');
const CHECKPOINT_NAME = 'checkpoint.json';
const PROGRESS_NAME = 'progresso-lote.json';
const AUDIT_JSON_NAME = 'auditoria-do-lote.json';
const AUDIT_XLSX_NAME = 'auditoria-do-lote.xlsx';
const REPORT_XLSX_NAME = 'relatorio-do-lote.xlsx';

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function hasOption(args, name) {
  return args.includes(name);
}

function asPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function jsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function standardPath(file) {
  return String(file).replace(/\\/g, '/');
}

function fingerprint(file) {
  const stat = fs.statSync(file);
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function sameFingerprint(entry, sourcePath) {
  if (!entry?.fingerprint || !fs.existsSync(sourcePath)) return false;
  const [savedSize, savedMtime] = String(entry.fingerprint).split(':');
  const [currentSize, currentMtime] = fingerprint(sourcePath).split(':');
  return Number(savedSize) === Number(currentSize) && Math.abs(Number(savedMtime) - Number(currentMtime)) < 1;
}

function findPdfFiles(root, recursive) {
  const files = [];
  const inaccessibleFolders = [];
  const visit = folder => {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
    catch (error) { inaccessibleFolders.push({ folder, error: error.message }); return; }
    for (const entry of entries) {
      const sourcePath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (recursive) visit(sourcePath);
        continue;
      }
      if (entry.isFile() && /\.pdf$/i.test(entry.name)) files.push(sourcePath);
    }
  };
  visit(root);
  return { files: files.sort((a, b) => a.localeCompare(b, 'pt-BR')), inaccessibleFolders };
}

function relativeFile(root, sourcePath) {
  return standardPath(path.relative(root, sourcePath));
}

function initialCheckpoint(sourceRoot, recursive, settings) {
  return {
    format: 'draw2data-batch-checkpoint-v2',
    sourceRoot,
    recursive,
    settings,
    createdAt: new Date().toISOString(),
    files: {},
    inaccessibleFolders: [],
    updatedAt: new Date().toISOString(),
    lastRun: null,
  };
}

function loadCheckpoint(output, sourceRoot, recursive, settings) {
  const file = path.join(output, CHECKPOINT_NAME);
  const checkpoint = jsonFile(file, null);
  if (!checkpoint || !checkpoint.files || typeof checkpoint.files !== 'object') return initialCheckpoint(sourceRoot, recursive, settings);
  checkpoint.format = 'draw2data-batch-checkpoint-v2';
  checkpoint.sourceRoot = checkpoint.sourceRoot || sourceRoot;
  checkpoint.recursive = checkpoint.recursive === true;
  checkpoint.settings = checkpoint.settings || settings;
  checkpoint.inaccessibleFolders = Array.isArray(checkpoint.inaccessibleFolders) ? checkpoint.inaccessibleFolders : [];
  return checkpoint;
}

function saveCheckpoint(output, checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  writeJson(path.join(output, CHECKPOINT_NAME), checkpoint);
}

function updateProgress(output, value) {
  writeJson(path.join(output, PROGRESS_NAME), { ...value, updatedAt: new Date().toISOString() });
}

function baseSettings(args, command) {
  const review = command === 'revisar' || command === 'atualizar-motor';
  return drawingOptions({
    mode: 'complete',
    maxPages: asPositiveInteger(optionValue(args, '--max-pages'), review ? 10 : 3),
    includePlain: true,
    minConfidence: 0,
    detailedScan: true,
  });
}

function expectedEngine(relativePath, settings) {
  return analysisVersionFor(path.basename(relativePath), settings);
}

function analysisDimensions(entry) {
  return Array.isArray(entry?.analysis?.dimensions) ? entry.analysis.dimensions : [];
}

function evidenceFile(output, relativePath, index, page) {
  const safeName = path.basename(relativePath).replace(/[\\/:*?"<>|]/g, '_');
  return path.join(output, 'evidencias', safeName, `${String(index + 1).padStart(3, '0')}-p${page}.png`);
}

async function attachEvidence(bytes, analysis, output, relativePath) {
  const warnings = [];
  const dimensions = [];
  for (let index = 0; index < (analysis.dimensions || []).length; index += 1) {
    const dimension = { ...analysis.dimensions[index] };
    try {
      const snapshot = await renderDimensionSnapshot(bytes, dimension);
      const file = evidenceFile(output, relativePath, index, snapshot.page);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, snapshot.bytes);
      dimension.evidencePath = standardPath(path.relative(output, file));
      dimension.evidenceStatus = 'GERADA';
    } catch (error) {
      dimension.evidenceStatus = 'INDISPONIVEL';
      warnings.push(`Não foi possível gerar a evidência da cota ${index + 1}: ${error.message}`);
    }
    dimensions.push(dimension);
  }
  return { dimensions, warnings };
}

function fileTool(relativePath) {
  const code = path.basename(relativePath, path.extname(relativePath)).trim().toUpperCase();
  return code || 'NAO_IDENTIFICADO';
}

async function analyzeFile(sourcePath, relativePath, output, settings, previous) {
  const startedAt = Date.now();
  const bytes = fs.readFileSync(sourcePath);
  const analysis = await processDrawing(path.basename(relativePath), bytes, settings);
  const evidence = await attachEvidence(bytes, analysis, output, relativePath);
  analysis.dimensions = evidence.dimensions;
  analysis.warnings = [...(analysis.warnings || []), ...evidence.warnings];
  return {
    ...(previous || {}),
    relativePath,
    sourcePath,
    fingerprint: fingerprint(sourcePath),
    sizeBytes: bytes.length,
    durationMs: Date.now() - startedAt,
    tool: analysis.tool && analysis.tool !== 'NAO_IDENTIFICADO' ? analysis.tool : fileTool(relativePath),
    toolSource: analysis.toolSource || 'NOME_DO_ARQUIVO',
    analysis,
    error: null,
    reviewedAt: new Date().toISOString(),
  };
}

function auditFinding({ sourcePath, relativePath, entry, output, settings }) {
  const flags = [];
  const sourceExists = !!sourcePath && fs.existsSync(sourcePath);
  if (!entry) flags.push('NAO_ANALISADO');
  if (entry?.error) flags.push('FALHA_NA_ANALISE');
  if (entry && !sourceExists) flags.push('ORIGINAL_INDISPONIVEL');
  const dimensions = analysisDimensions(entry);
  if (entry && !entry.error && dimensions.length === 0) flags.push('SEM_COTAS');
  if (entry && !entry.error && dimensions.length > 0 && dimensions.length <= 2) flags.push('POUCAS_COTAS');
  const expected = expectedEngine(relativePath, settings);
  if (entry?.analysis?.engineVersion && entry.analysis.engineVersion !== expected) flags.push('MOTOR_DESATUALIZADO');
  const missingEvidence = dimensions.some(dimension => !dimension.evidencePath || !fs.existsSync(path.join(output, dimension.evidencePath)));
  if (dimensions.length && missingEvidence) flags.push('EVIDENCIA_PENDENTE');
  const warnings = entry?.analysis?.warnings || [];
  if (warnings.some(warning => /apenas uma cota|mais raios|nenhuma cota|conferir o desenho original/i.test(String(warning)))) flags.push('LEITURA_INCERTA');
  const reviewRecommended = sourceExists && flags.some(flag => ['NAO_ANALISADO', 'FALHA_NA_ANALISE', 'SEM_COTAS', 'POUCAS_COTAS', 'EVIDENCIA_PENDENTE', 'LEITURA_INCERTA'].includes(flag));
  return {
    relativePath,
    sourcePath: sourcePath || entry?.sourcePath || '',
    tool: entry?.tool || fileTool(relativePath),
    dimensions: dimensions.length,
    engineVersion: entry?.analysis?.engineVersion || '',
    expectedEngine: expected,
    flags,
    reviewRecommended,
    sourceExists,
    warning: warnings.join(' | '),
  };
}

function writeAudit(output, sourceRoot, files, checkpoint, settings) {
  const byRelative = new Map(files.map(sourcePath => [relativeFile(sourceRoot, sourcePath), sourcePath]));
  const relatives = new Set([...byRelative.keys(), ...Object.keys(checkpoint.files || {})]);
  const findings = [...relatives].sort((a, b) => a.localeCompare(b, 'pt-BR')).map(relativePath => auditFinding({
    sourcePath: byRelative.get(relativePath),
    relativePath,
    entry: checkpoint.files[relativePath],
    output,
    settings,
  }));
  const summary = {
    filesFound: files.length,
    registered: Object.keys(checkpoint.files || {}).length,
    pending: findings.filter(item => item.flags.includes('NAO_ANALISADO')).length,
    errors: findings.filter(item => item.flags.includes('FALHA_NA_ANALISE')).length,
    withoutDimensions: findings.filter(item => item.flags.includes('SEM_COTAS')).length,
    sparse: findings.filter(item => item.flags.includes('POUCAS_COTAS')).length,
    staleEngine: findings.filter(item => item.flags.includes('MOTOR_DESATUALIZADO')).length,
    missingEvidence: findings.filter(item => item.flags.includes('EVIDENCIA_PENDENTE')).length,
    recommendedForReview: findings.filter(item => item.reviewRecommended).length,
  };
  const audit = {
    format: 'draw2data-batch-audit-v2',
    generatedAt: new Date().toISOString(),
    sourceRoot,
    output,
    settings,
    summary,
    findings,
  };
  writeJson(path.join(output, AUDIT_JSON_NAME), audit);
  const rows = findings.map(item => ({
    Arquivo: item.relativePath,
    Ferramenta: item.tool,
    'Cotas encontradas': item.dimensions,
    Situação: item.flags.join(' · ') || 'OK',
    'Revisar automaticamente': item.reviewRecommended ? 'SIM' : 'NÃO',
    'Motor usado': item.engineVersion || '—',
    'Motor atual': item.expectedEngine,
    Avisos: item.warning,
  }));
  const overview = Object.entries(summary).map(([item, value]) => ({ Item: item, Quantidade: value }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(overview), 'Resumo');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Itens para revisão');
  XLSX.writeFile(workbook, path.join(output, AUDIT_XLSX_NAME));
  return audit;
}

function writeBatchReport(output, checkpoint) {
  const rows = Object.values(checkpoint.files || {}).sort((a, b) => String(a.relativePath).localeCompare(String(b.relativePath), 'pt-BR')).map(entry => ({
    Arquivo: entry.relativePath,
    Ferramenta: entry.tool || 'NAO_IDENTIFICADO',
    'Cotas encontradas': analysisDimensions(entry).length,
    Situação: entry.error ? 'ERRO' : analysisDimensions(entry).length ? 'ANALISADO' : 'SEM COTAS',
    'Tempo (s)': Math.round(Number(entry.durationMs || 0) / 1000),
    Motor: entry.analysis?.engineVersion || '—',
    Avisos: (entry.analysis?.warnings || []).join(' | '),
    Erro: entry.error || '',
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Resultados');
  XLSX.writeFile(workbook, path.join(output, REPORT_XLSX_NAME));
}

function remainingAnalysisCount(items, checkpoint, settings, command) {
  return items.filter(item => {
    const existing = checkpoint.files[item.relativePath];
    if (!existing || existing.error || !sameFingerprint(existing, item.sourcePath)) return true;
    return command === 'atualizar-motor' && existing.analysis?.engineVersion !== expectedEngine(item.relativePath, settings);
  }).length;
}

async function processQueue({ command, sourceRoot, output, files, checkpoint, settings, queue }) {
  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  const total = queue.length;
  updateProgress(output, {
    status: command === 'revisar' ? 'REVISANDO' : 'EM_ANDAMENTO', sourceRoot, output,
    filesFound: files.length, pendingAtStart: total, processedThisRun: processed, failedThisRun: failed,
    elapsedMs: 0, averageMsPerFile: 0, estimatedRemainingMs: null, currentFile: queue[0]?.relativePath || null,
  });
  for (const item of queue) {
    const currentStartedAt = Date.now();
    try {
      checkpoint.files[item.relativePath] = await analyzeFile(item.sourcePath, item.relativePath, output, settings, checkpoint.files[item.relativePath]);
      console.log(`[${processed + 1}/${total}] ${item.relativePath} · ${analysisDimensions(checkpoint.files[item.relativePath]).length} cota(s)`);
    } catch (error) {
      failed += 1;
      checkpoint.files[item.relativePath] = {
        ...(checkpoint.files[item.relativePath] || {}), relativePath: item.relativePath, sourcePath: item.sourcePath,
        fingerprint: fs.existsSync(item.sourcePath) ? fingerprint(item.sourcePath) : null,
        durationMs: Date.now() - currentStartedAt, error: error.message, reviewedAt: new Date().toISOString(),
      };
      console.error(`[${processed + 1}/${total}] ${item.relativePath} · ERRO: ${error.message}`);
    }
    processed += 1;
    checkpoint.lastRun = {
      command, startedAt: new Date(startedAt).toISOString(), updatedAt: new Date().toISOString(), totalFiles: total,
      processedThisRun: processed, failedThisRun: failed, durationMs: Date.now() - startedAt,
      averageMsPerFile: Math.round((Date.now() - startedAt) / processed),
    };
    saveCheckpoint(output, checkpoint);
    const elapsedMs = Date.now() - startedAt;
    updateProgress(output, {
      status: command === 'revisar' ? 'REVISANDO' : 'EM_ANDAMENTO', sourceRoot, output, filesFound: files.length,
      pendingAtStart: total, processedThisRun: processed, failedThisRun: failed, currentFile: item.relativePath,
      elapsedMs, averageMsPerFile: Math.round(elapsedMs / processed), estimatedRemainingMs: Math.round((elapsedMs / processed) * (total - processed)),
    });
  }
  writeBatchReport(output, checkpoint);
  updateProgress(output, {
    status: failed ? 'CONCLUIDO_COM_ERROS' : 'CONCLUIDO', sourceRoot, output, filesFound: files.length,
    pendingAtStart: total, processedThisRun: processed, failedThisRun: failed, currentFile: null,
    elapsedMs: Date.now() - startedAt, averageMsPerFile: processed ? Math.round((Date.now() - startedAt) / processed) : 0, estimatedRemainingMs: 0,
  });
}

function help() {
  console.log('Uso: node draw2data/batch.cjs <analisar|auditar|revisar|atualizar-motor> --source "U:\\" --output "C:\\..."');
  console.log('Opções: --recursive  --max-pages 3  --limit 100  --match NLD-024  --all-stale');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'analisar';
  if (!['analisar', 'auditar', 'revisar', 'atualizar-motor'].includes(command)) { help(); process.exitCode = 1; return; }
  const sourceRoot = path.resolve(optionValue(args, '--source', 'U:\\'));
  const output = path.resolve(optionValue(args, '--output', DEFAULT_OUTPUT));
  const recursive = hasOption(args, '--recursive');
  const settings = baseSettings(args, command);
  const limit = asPositiveInteger(optionValue(args, '--limit'), Number.MAX_SAFE_INTEGER);
  if (!fs.existsSync(sourceRoot)) throw Error(`Pasta de origem não encontrada: ${sourceRoot}`);
  fs.mkdirSync(output, { recursive: true });
  const discovered = findPdfFiles(sourceRoot, recursive);
  const checkpoint = loadCheckpoint(output, sourceRoot, recursive, settings);
  checkpoint.sourceRoot = sourceRoot;
  checkpoint.recursive = recursive;
  checkpoint.settings = settings;
  checkpoint.inaccessibleFolders = discovered.inaccessibleFolders;
  saveCheckpoint(output, checkpoint);
  const match = String(optionValue(args, '--match', '')).trim().toUpperCase();
  const items = discovered.files.map(sourcePath => ({ sourcePath, relativePath: relativeFile(sourceRoot, sourcePath) })).filter(item => !match || item.relativePath.toUpperCase().includes(match));
  if (command === 'auditar') {
    const audit = writeAudit(output, sourceRoot, discovered.files, checkpoint, settings);
    updateProgress(output, {
      status: 'AUDITORIA_CONCLUIDA', sourceRoot, output, filesFound: discovered.files.length, pendingAtStart: 0,
      processedThisRun: 0, failedThisRun: audit.summary.errors, currentFile: null, elapsedMs: 0, averageMsPerFile: 0,
      estimatedRemainingMs: null, remainingAnalysis: remainingAnalysisCount(items, checkpoint, settings, 'analisar'),
      reviewRecommended: audit.summary.recommendedForReview,
    });
    console.log(`Auditoria concluída: ${audit.summary.recommendedForReview} desenho(s) recomendados para revisão.`);
    return;
  }
  let queue;
  if (command === 'analisar') {
    queue = items.filter(item => {
      const existing = checkpoint.files[item.relativePath];
      return !existing || existing.error || !sameFingerprint(existing, item.sourcePath);
    });
  } else if (command === 'revisar') {
    const audit = writeAudit(output, sourceRoot, discovered.files, checkpoint, settings);
    const selected = new Set(audit.findings.filter(item => item.reviewRecommended || (hasOption(args, '--all-stale') && item.flags.includes('MOTOR_DESATUALIZADO'))).map(item => item.relativePath));
    queue = items.filter(item => selected.has(item.relativePath));
  } else {
    queue = items.filter(item => {
      const existing = checkpoint.files[item.relativePath];
      return !existing || !sameFingerprint(existing, item.sourcePath) || existing.analysis?.engineVersion !== expectedEngine(item.relativePath, settings);
    });
  }
  queue = queue.slice(0, limit);
  if (!queue.length) {
    writeBatchReport(output, checkpoint);
    const audit = writeAudit(output, sourceRoot, discovered.files, checkpoint, settings);
    console.log(`Nenhum desenho pendente. Auditoria: ${audit.summary.recommendedForReview} item(ns) recomendado(s) para revisão.`);
    return;
  }
  console.log(`${command === 'revisar' ? 'Revisando' : 'Analisando'} ${queue.length} desenho(s). O processo continua sozinho e grava o progresso a cada arquivo.`);
  await processQueue({ command, sourceRoot, output, files: discovered.files, checkpoint, settings, queue });
  const audit = writeAudit(output, sourceRoot, discovered.files, checkpoint, settings);
  const remaining = remainingAnalysisCount(items, checkpoint, settings, command);
  const finalStatus = command === 'revisar' ? 'REVISAO_CONCLUIDA' : remaining ? 'ANALISE_PARCIAL' : 'CONCLUIDO';
  updateProgress(output, {
    status: finalStatus, sourceRoot, output, filesFound: discovered.files.length, pendingAtStart: queue.length,
    processedThisRun: queue.length, failedThisRun: checkpoint.lastRun?.failedThisRun || 0, currentFile: null,
    elapsedMs: checkpoint.lastRun?.durationMs || 0, averageMsPerFile: checkpoint.lastRun?.averageMsPerFile || 0, estimatedRemainingMs: null,
    remainingAnalysis: remaining, reviewRecommended: audit.summary.recommendedForReview,
  });
  console.log(`${command === 'revisar' ? 'Revisão' : 'Lote'} concluída. Restam ${remaining} desenho(s) sem análise atual; auditoria aponta ${audit.summary.recommendedForReview} item(ns) para revisão.`);
}

main().catch(error => { console.error(`ERRO: ${error.message}`); process.exitCode = 1; });
