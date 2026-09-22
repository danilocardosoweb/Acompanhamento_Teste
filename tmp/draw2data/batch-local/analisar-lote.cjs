const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline/promises');
const XLSX = require('xlsx');
const { processDrawing, drawingOptions, ENGINE_VERSION, analysisVersionFor } = require('../../../draw2data/processing.cjs');
const { renderDimensionSnapshot } = require('../../../draw2data/snapshot.cjs');

const input = readline.createInterface({ input: process.stdin, output: process.stdout });
const cli = new Map(process.argv.slice(2).map(arg => { const index = arg.indexOf('='); return index < 0 ? [arg.replace(/^--/, ''), 'true'] : [arg.slice(2, index), arg.slice(index + 1)]; }));
const option = name => cli.get(name);
const ask = async (label, fallback = '') => {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await input.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
};
const unquote = value => String(value || '').trim().replace(/^['"]|['"]$/g, '');
const toolPattern = /(?:^|[^A-Z0-9])((?:[A-Z]{2,4}|\d{2,3})-\d{3,6}[A-Z]?)(?=$|[^A-Z0-9])/i;

function scanPdfs(root, recursive) {
  const files = [], inaccessible = [];
  const visit = folder => {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
    catch (error) { inaccessible.push({ folder, error: error.message }); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isFile() && /\.pdf$/i.test(entry.name) && !entry.name.startsWith('~$')) files.push(full);
      else if (recursive && entry.isDirectory() && !entry.isSymbolicLink()) visit(full);
    }
  };
  visit(root);
  files.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b), 'pt-BR', { numeric: true, sensitivity: 'base' }));
  return { files, inaccessible };
}

function identifyMetadata(fileName, analysis) {
  const stem = path.basename(fileName, path.extname(fileName));
  const fileCode = stem.match(toolPattern)?.[1]?.toUpperCase() || '';
  const pdfCode = analysis.tool && analysis.tool !== 'NAO_IDENTIFICADO' ? analysis.tool.toUpperCase() : '';
  const revision = stem.match(/(?:^|[^A-Z0-9])REV(?:ISAO|ISÃO)?[ ._-]*([A-Z0-9]{1,12})(?=$|[^A-Z0-9])/i)?.[1]?.toUpperCase();
  const tool = fileCode || pdfCode || 'NAO_IDENTIFICADO';
  const conflicts = fileCode && pdfCode && fileCode !== pdfCode;
  const missing = [];
  if (!fileCode && !pdfCode) missing.push('código da ferramenta');
  if (!revision) missing.push('revisão');
  if (conflicts) missing.push(`conflito entre nome (${fileCode}) e texto (${pdfCode})`);
  return {
    tool,
    toolSource: fileCode ? 'NOME_DO_ARQUIVO' : pdfCode ? 'TEXTO_DO_PDF' : 'NAO_IDENTIFICADO',
    sequence: null,
    revision: revision || '00',
    metadataReview: missing.length > 0,
    metadataReviewReason: missing.join('; '),
    codeConflict: Boolean(conflicts)
  };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), remainder = seconds % 60;
  return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':');
}

function probableCause(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (/excede o limite|100\s*mb/.test(message)) return 'PDF maior que o limite de 100 MB definido pela automação.';
  if (/enoent|no such file|não foi possível encontrar|cannot find the path/.test(message)) return 'Arquivo movido/removido ou pasta de rede desconectada durante a leitura.';
  if (/eacces|eperm|permission|acesso negado|access denied/.test(message)) return 'Sem permissão de leitura no arquivo ou na pasta de rede.';
  if (/etimedout|econnreset|enotfound|network|rede|\b53\b/.test(message)) return 'Conexão instável ou indisponível com a pasta de rede.';
  if (/password|encrypted|senha|criptograf/.test(message)) return 'PDF protegido por senha ou criptografado.';
  if (/invalid pdf|corrupt|damaged|xref|arquivo pdf inválido/.test(message)) return 'PDF possivelmente corrompido ou exportado em formato inválido.';
  if (/heap|out of memory|memory|memória/.test(message)) return 'Memória insuficiente; feche outros programas ou processe menos páginas por PDF.';
  if (/worker|pdf\.worker|fake worker/.test(message)) return 'Falha ao iniciar o leitor interno de PDF; verifique as dependências da automação.';
  return 'Falha pontual ao ler o PDF; confira se ele abre normalmente e se a pasta de rede está acessível.';
}

function buildArtifacts(manifest, output) {
  const results = Object.values(manifest.files || {}), successful = results.filter(row => row.analysis);
  const counts = new Map();
  for (const row of successful) {
    const key = `${row.tool}|${row.revision || '00'}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const files = successful.map(row => {
    const key = `${row.tool}|${row.revision || '00'}`;
    const duplicateCount = counts.get(key) || 0;
    const dimensions = row.analysis.dimensions || [];
    const result = row.tool === 'NAO_IDENTIFICADO' ? 'REVISAR_CÓDIGO'
      : !dimensions.length ? 'SEM_COTAS'
      : dimensions.length > 500 ? 'EXCEDE_LIMITE_DO_PERFIL'
      : duplicateCount > 1 ? 'POSSÍVEL_CONFLITO'
      : row.metadataReview ? 'REVISAR_CADASTRO'
      : dimensions.some(item => item.status !== 'CONFIRMADO') ? 'REVISAR_COTAS'
      : 'PRONTO_PARA_CONFERÊNCIA';
    return {
      'Arquivo': row.relativePath,
      'Ferramenta sugerida': row.tool,
      'Origem do código': row.toolSource,
      'Sequência': 'Por inspeção',
      'Revisão sugerida': row.revision || '00',
      'Cotas': dimensions.length,
      'Cotas para revisar': dimensions.filter(item => item.status !== 'CONFIRMADO').length,
      'Método': row.analysis.method,
      'Identificação': result,
      'Evidências visuais': (row.analysis.dimensions || []).filter(item => item.evidencePath).length,
      'Cotas sem evidência': (row.analysis.dimensions || []).filter(item => !item.evidencePath).length,
      'Motivo da conferência': [row.metadataReviewReason, duplicateCount > 1 ? `${duplicateCount} arquivos usam esta mesma chave de ferramenta/revisão` : ''].filter(Boolean).join(' · ')
    };
  });
  const dimensions = successful.flatMap(row => (row.analysis.dimensions || []).map(item => ({
    'Arquivo': row.relativePath,
    'Ferramenta sugerida': row.tool,
    'Sequência': 'Informada no Controle Dimensional',
    'Revisão sugerida': row.revision || '00',
    'Página': item.page,
    'Texto lido': item.rawText,
    'Nominal': item.nominal,
    'Tol. +': item.tolerancePlus ?? '',
    'Tol. -': item.toleranceMinus ?? '',
    'Limite inferior': item.toleranceMinus == null ? '' : Number(item.nominal) - Number(item.toleranceMinus),
    'Limite superior': item.tolerancePlus == null ? '' : Number(item.nominal) + Number(item.tolerancePlus),
    'Confiança': `${Math.round(Number(item.confidence || 0) * 100)}%`,
    'Status': item.status,
    'Motivo de revisão': item.reviewReason || '',
    'Método de leitura': item.source,
    'Evidência visual': item.evidencePath || (item.evidenceStatus === 'FALHA_AO_GERAR' ? `Falha: ${item.evidenceError || 'erro desconhecido'}` : hasLocation(item) ? 'Não gerada; conferir no PDF original' : 'Sem posição; conferir no PDF original')
  })));
  const failures = results.filter(row => row.error).map(row => ({ 'Arquivo': row.relativePath, 'Erro': row.error, 'Possível causa': row.probableCause || probableCause(row.error) }));
  const workbook = XLSX.utils.book_new();
  const addSheet = (name, rows, empty) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [empty]), name);
  addSheet('Arquivos', files, { 'Identificação': 'Nenhum arquivo processado' });
  addSheet('Cotas', dimensions, { 'Texto lido': 'Nenhuma cota encontrada' });
  addSheet('Falhas', failures, { 'Erro': 'Nenhuma falha registrada' });
  const run = manifest.lastRun || {};
  addSheet('Indicadores', [{
    'Início da rodada': run.startedAt || '',
    'Fim/última atualização': run.updatedAt || '',
    'PDFs encontrados': run.totalFiles ?? results.length,
    'PDFs processados nesta rodada': run.processedThisRun ?? 0,
    'Falhas nesta rodada': run.failedThisRun ?? 0,
    'Tempo decorrido': formatDuration(run.durationMs),
      'Média por PDF': run.averageMsPerFile ? `${(run.averageMsPerFile / 1000).toFixed(1)} s` : ''
  }], { 'PDFs encontrados': 0 });
  const evidenceSheet = workbook.Sheets.Cotas;
  dimensions.forEach((row, index) => {
    const evidencePath = row['Evidência visual'];
    if (!evidencePath || !/^evidencias[\\/]/.test(evidencePath)) return;
    const address = XLSX.utils.encode_cell({ r: index + 1, c: Object.keys(dimensions[0] || {}).indexOf('Evidência visual') });
    if (evidenceSheet[address]) evidenceSheet[address].l = { Target: `./${evidencePath.replace(/\\/g, '/')}`, Tooltip: 'Abrir recorte do desenho com a cota destacada' };
  });
  XLSX.writeFile(workbook, path.join(output, 'relatorio-do-lote.xlsx'));

  const profiles = successful.map(row => ({
    tool: row.tool,
    sequence: row.sequence,
    revision: row.revision || '00',
    name: `${row.tool} · Rev. ${row.revision || '00'}`,
    dimensions: row.analysis.dimensions || [],
    originalDrawing: { relativePath: row.relativePath, absolutePath: row.sourcePath, sizeBytes: row.sizeBytes },
    analysis: { method: row.analysis.method, engineVersion: row.analysis.engineVersion, warnings: row.analysis.warnings || [], diagnostics: row.analysis.diagnostics || {} },
    importStatus: files.find(item => item.Arquivo === row.relativePath)?.Identificação || 'REVISAR'
  }));
  atomicJson(path.join(output, 'manifesto-perfis.json'), {
    format: 'draw2data-profile-import-v1', generatedAt: new Date().toISOString(), sourceRoot: manifest.sourceRoot,
    note: 'Resultados são candidatos para revisão. Confirme ferramenta, sequência, revisão, cotas e vínculos dos PDFs antes de importar.',
    profiles
  });
  const errorLog = { generatedAt: new Date().toISOString(), inaccessibleFolders: manifest.inaccessibleFolders || [], files: failures };
  atomicJson(path.join(output, 'falhas-e-pastas.json'), errorLog);
}

function auditBatch(manifest, scan, settings = manifest.settings || {}) {
  const keyOf = value => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase('pt-BR');
  const records = new Map(Object.entries(manifest.files || {}).map(([key, value]) => [keyOf(key), { key, value }]));
  const scanned = new Set(), expectedByProfile = new Map();
  const files = scan.files.map(file => {
    const relativePath = path.relative(manifest.sourceRoot || path.dirname(file), file);
    const key = keyOf(relativePath), entry = records.get(key), previous = entry?.value;
    scanned.add(key);
    let stat, statError = '';
    try { stat = fs.statSync(file); } catch (error) { statError = error.message; }
    const fingerprint = stat ? `${stat.size}:${stat.mtimeMs}` : '';
    const fingerprintMatches = Boolean(previous && fingerprint && previous.fingerprint === fingerprint);
    const expectedEngine = analysisVersionFor(path.basename(file), settings);
    const actualEngine = previous?.analysis?.engineVersion || previous?.engineVersion || '';
    const dimensions = previous?.analysis?.dimensions || [];
    const flags = [];
    const add = flag => { if (!flags.includes(flag)) flags.push(flag); };
    if (!previous) add('NÃO_ANALISADO');
    else if (!fingerprintMatches) add('ARQUIVO_ALTERADO');
    if (statError) add('ERRO_AO_CONFERIR_ORIGEM');
    if (previous?.error) add('FALHA');
    else if (previous && !previous.analysis) add('REGISTRO_INCOMPLETO');
    if (previous?.analysis && actualEngine !== expectedEngine) add('VERSÃO_ANTERIOR');
    if (previous?.analysis) {
      if (!dimensions.length) add('SEM_COTAS');
      else if (dimensions.length === 1) add('POUCAS_COTAS');
      if (previous.metadataReview) add('REVISAR_IDENTIFICAÇÃO');
      if (dimensions.some(item => item.status !== 'CONFIRMADO')) add('REVISAR_COTAS');
      if (dimensions.some(item => Number(item.confidence || 0) < .6)) add('BAIXA_CONFIANÇA');
      if (dimensions.some(item => hasLocation(item) && !item.evidencePath && item.evidenceStatus !== 'GERADA')) add('EVIDÊNCIA_AUSENTE');
      if (dimensions.some(item => !hasLocation(item))) add('COTA_SEM_POSIÇÃO');
      if ((previous.analysis.warnings || []).some(message => /primeiras\s+\d+\s+de\s+\d+\s+página/i.test(message))) add('PÁGINAS_NÃO_ANALISADAS');
      const profileKey = `${previous.tool || 'NAO_IDENTIFICADO'}|${previous.revision || '00'}`;
      expectedByProfile.set(profileKey, (expectedByProfile.get(profileKey) || 0) + 1);
    }
    if (previous?.tool === 'NAO_IDENTIFICADO' || previous?.codeConflict) add('REVISAR_IDENTIFICAÇÃO');
    const priority = ['ERRO_AO_CONFERIR_ORIGEM', 'FALHA', 'NÃO_ANALISADO', 'ARQUIVO_ALTERADO', 'VERSÃO_ANTERIOR', 'REGISTRO_INCOMPLETO', 'SEM_COTAS', 'POUCAS_COTAS', 'REVISAR_IDENTIFICAÇÃO', 'REVISAR_COTAS', 'PÁGINAS_NÃO_ANALISADAS', 'EVIDÊNCIA_AUSENTE', 'COTA_SEM_POSIÇÃO', 'BAIXA_CONFIANÇA'];
    const status = priority.find(flag => flags.includes(flag)) || 'ATUALIZADO';
    return {
      relativePath, fileName: path.basename(file), tool: previous?.tool || '', revision: previous?.revision || '',
      status, flags, fingerprintMatches, expectedEngine, actualEngine,
      dimensions: dimensions.length, dimensionsToReview: dimensions.filter(item => item.status !== 'CONFIRMADO').length,
      metadataReview: Boolean(previous?.metadataReview), warnings: (previous?.analysis?.warnings || []).join(' · '),
      error: previous?.error || statError, probableCause: previous?.probableCause || (previous?.error ? probableCause(previous.error) : ''),
      durationMs: previous?.durationMs || '', analysisCurrent: Boolean(previous?.analysis && !previous.error && fingerprintMatches && actualEngine === expectedEngine),
      _dimensions: dimensions, _previous: previous
    };
  });
  for (const row of files) {
    if (row._previous?.analysis && expectedByProfile.get(`${row.tool || 'NAO_IDENTIFICADO'}|${row.revision || '00'}`) > 1) {
      if (!row.flags.includes('POSSÍVEL_CONFLITO')) row.flags.push('POSSÍVEL_CONFLITO');
      if (row.status === 'ATUALIZADO') row.status = 'POSSÍVEL_CONFLITO';
    }
  }
  const inaccessible = scan.inaccessible || [];
  const sourceMissing = [];
  for (const [key, record] of records) {
    if (scanned.has(key)) continue;
    const relativePath = record.value.relativePath || record.key;
    const inaccessibleMatch = inaccessible.find(item => {
      const relativeFolder = path.relative(manifest.sourceRoot || '', item.folder || '');
      const prefix = keyOf(relativeFolder === '.' ? '' : relativeFolder);
      return !prefix || key === prefix || key.startsWith(`${prefix}/`);
    });
    sourceMissing.push({
      Arquivo: relativePath,
      Ferramenta: record.value.tool || '',
      Status: inaccessibleMatch ? 'ORIGEM_INACESSÍVEL' : 'ORIGEM_NÃO_LOCALIZADA',
      'Último caminho conhecido': record.value.sourcePath || '',
      'Possível causa': inaccessibleMatch ? probableCause(inaccessibleMatch.error) : 'O arquivo registrado não apareceu na varredura atual; pode ter sido movido, renomeado ou removido.'
    });
  }
  const reviewItems = files.flatMap(row => row._dimensions.filter(item => item.status !== 'CONFIRMADO').map(item => ({
    Arquivo: row.relativePath, Ferramenta: row.tool, Revisão: row.revision, Página: item.page,
    'Texto lido': item.rawText, Nominal: item.nominal, 'Tol. +': item.tolerancePlus ?? '', 'Tol. -': item.toleranceMinus ?? '',
    Confiança: `${Math.round(Number(item.confidence || 0) * 100)}%`, Status: item.status || 'REVISAR',
    Motivo: item.reviewReason || 'Confirme no desenho antes de importar.', Evidência: item.evidencePath || (hasLocation(item) ? 'Não gerada; conferir no PDF original' : 'Sem posição; conferir no PDF original')
  })));
  const countFlag = flag => files.filter(row => row.flags.includes(flag)).length;
  const current = files.filter(row => row.analysisCurrent).length;
  const pending = files.filter(row => row.flags.some(flag => ['NÃO_ANALISADO', 'ARQUIVO_ALTERADO', 'VERSÃO_ANTERIOR', 'FALHA', 'REGISTRO_INCOMPLETO'].includes(flag))).length;
  const summary = {
    generatedAt: new Date().toISOString(), sourceRoot: manifest.sourceRoot || '',
    filesFound: files.length, manifestRecords: Object.keys(manifest.files || {}).length, analysisCurrent: current,
    pendingOrOutdated: pending, notAnalyzed: countFlag('NÃO_ANALISADO'), changed: countFlag('ARQUIVO_ALTERADO'),
    olderEngine: countFlag('VERSÃO_ANTERIOR'), failures: countFlag('FALHA'), noDimensions: countFlag('SEM_COTAS'),
    fewDimensions: countFlag('POUCAS_COTAS'), reviewDimensions: reviewItems.length,
    filesWithReviewDimensions: countFlag('REVISAR_COTAS'), metadataReview: countFlag('REVISAR_IDENTIFICAÇÃO'),
    lowConfidenceFiles: countFlag('BAIXA_CONFIANÇA'), missingEvidenceFiles: countFlag('EVIDÊNCIA_AUSENTE'),
    pagesNotAnalyzed: countFlag('PÁGINAS_NÃO_ANALISADAS'), possibleConflicts: countFlag('POSSÍVEL_CONFLITO'),
    sourceFilesNotFound: sourceMissing.length, inaccessibleFolders: inaccessible.length
  };
  const publicFiles = files.map(({ _dimensions, _previous, ...row }) => ({ ...row, flags: row.flags.join(' · ') }));
  return { summary, files: publicFiles, reviewItems, sourceMissing, inaccessible };
}

function buildAuditArtifacts(manifest, scan, output, settings = manifest.settings || {}) {
  const audit = auditBatch(manifest, scan, settings);
  const progressPath = path.join(output, 'progresso-lote.json');
  try {
    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    audit.lastProgress = {
      status: progress.status || 'SEM_REGISTRO', updatedAt: progress.updatedAt || '', currentFile: progress.currentFile || '',
      filesFound: progress.filesFound ?? '', processedThisRun: progress.processedThisRun ?? 0,
      pendingAtStart: progress.pendingAtStart ?? '', pendingAfterRun: progress.pendingAfterRun ?? '',
      failedThisRun: progress.failedThisRun ?? 0, estimatedRemainingMs: progress.estimatedRemainingMs ?? ''
    };
  } catch { audit.lastProgress = { status: 'SEM_REGISTRO' }; }
  const workbook = XLSX.utils.book_new();
  const addSheet = (name, rows, empty) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [empty]), name);
  const summaryLabels = {
    generatedAt: 'Auditoria gerada em', sourceRoot: 'Pasta de origem', filesFound: 'PDFs encontrados', manifestRecords: 'Registros no checkpoint',
    analysisCurrent: 'Análises atuais', pendingOrOutdated: 'Pendentes ou desatualizados', notAnalyzed: 'Nunca analisados', changed: 'Arquivos alterados',
    olderEngine: 'Análises em versão anterior do motor', failures: 'Falhas de leitura', noDimensions: 'PDFs sem cotas encontradas', fewDimensions: 'PDFs com apenas uma cota',
    reviewDimensions: 'Cotas pendentes de revisão', filesWithReviewDimensions: 'PDFs com cotas para revisar', metadataReview: 'PDFs com identificação para revisar',
    lowConfidenceFiles: 'PDFs com leituras de baixa confiança', missingEvidenceFiles: 'PDFs com evidências visuais ausentes', pagesNotAnalyzed: 'PDFs com páginas não analisadas',
    possibleConflicts: 'Possíveis conflitos de ferramenta/revisão', sourceFilesNotFound: 'Registros sem arquivo de origem', inaccessibleFolders: 'Pastas inacessíveis'
  };
  const progressLabels = { status: 'Situação da última execução', updatedAt: 'Última atualização', currentFile: 'Arquivo em processamento', filesFound: 'PDFs localizados', processedThisRun: 'Processados na rodada', pendingAtStart: 'Pendentes no início', pendingAfterRun: 'Pendentes ao final', failedThisRun: 'Falhas na rodada', estimatedRemainingMs: 'Estimativa restante (ms)' };
  const summaryRows = [
    ...Object.entries(audit.summary).map(([indicator, value]) => ({ Indicador: summaryLabels[indicator] || indicator, Valor: value })),
    ...Object.entries(audit.lastProgress).map(([indicator, value]) => ({ Indicador: `Último progresso · ${progressLabels[indicator] || indicator}`, Valor: value }))
  ];
  addSheet('Resumo auditoria', summaryRows, { Indicador: 'Sem dados', Valor: 0 });
  const reportFiles = rows => rows.map(row => ({
    Arquivo: row.relativePath, Ferramenta: row.tool, Revisão: row.revision, Situação: row.status, Pendências: row.flags,
    'Motor esperado': row.expectedEngine, 'Motor usado': row.actualEngine, 'Análise atual': row.analysisCurrent ? 'Sim' : 'Não',
    Cotas: row.dimensions, 'Cotas para revisar': row.dimensionsToReview, 'Identificação para revisar': row.metadataReview ? 'Sim' : 'Não',
    'Tempo da leitura (ms)': row.durationMs, Avisos: row.warnings, Erro: row.error, 'Possível causa': row.probableCause
  }));
  addSheet('Cobertura', reportFiles(audit.files), { Arquivo: 'Nenhum PDF localizado' });
  addSheet('Pendentes', reportFiles(audit.files.filter(row => /NÃO_ANALISADO|ARQUIVO_ALTERADO|VERSÃO_ANTERIOR|FALHA|REGISTRO_INCOMPLETO/.test(row.flags))), { Arquivo: 'Nenhuma pendência de processamento' });
  addSheet('Sem cotas', reportFiles(audit.files.filter(row => /SEM_COTAS|POUCAS_COTAS/.test(row.flags))), { Arquivo: 'Nenhum arquivo sem cotas' });
  const reviewSheet = XLSX.utils.json_to_sheet(audit.reviewItems.length ? audit.reviewItems : [{ Arquivo: 'Nenhuma cota pendente de revisão' }]);
  const evidenceColumn = Object.keys(audit.reviewItems[0] || {}).indexOf('Evidência');
  if (evidenceColumn >= 0) audit.reviewItems.forEach((row, index) => {
    if (!/^evidencias[\\/]/i.test(String(row.Evidência || ''))) return;
    const cell = XLSX.utils.encode_cell({ r: index + 1, c: evidenceColumn });
    if (reviewSheet[cell]) reviewSheet[cell].l = { Target: `./${row.Evidência.replace(/\\/g, '/')}`, Tooltip: 'Abrir evidência visual da cota' };
  });
  XLSX.utils.book_append_sheet(workbook, reviewSheet, 'Cotas revisar');
  addSheet('Origem não localizada', audit.sourceMissing, { Arquivo: 'Todos os registros possuem origem localizada' });
  addSheet('Falhas de acesso', [
    ...audit.files.filter(row => row.error).map(row => ({ Tipo: 'Falha no PDF', Arquivo: row.relativePath, Erro: row.error, 'Possível causa': row.probableCause })),
    ...audit.inaccessible.map(row => ({ Tipo: 'Pasta inacessível', Arquivo: row.folder, Erro: row.error, 'Possível causa': probableCause(row.error) }))
  ], { Tipo: 'Acesso', Arquivo: 'Nenhuma falha registrada' });
  XLSX.writeFile(workbook, path.join(output, 'auditoria-do-lote.xlsx'));
  atomicJson(path.join(output, 'auditoria-do-lote.json'), audit);
  return audit;
}

function hasLocation(item) {
  return Number.isInteger(Number(item?.page)) && Number(item.page) > 0
    && [item.x, item.y, item.width, item.height].every(value => Number.isFinite(Number(value)))
    && Number(item.x) >= 0 && Number(item.y) >= 0 && Number(item.width) > 0 && Number(item.height) > 0;
}

function needsAnalysis(previous, fingerprint, engineVersion = ENGINE_VERSION, retryFailures = false) {
  if (!previous || previous.fingerprint !== fingerprint) return true;
  if (previous.error) return retryFailures || previous.engineVersion !== engineVersion;
  return previous.analysis?.engineVersion !== engineVersion;
}

function normalizeRoot(root) {
  return path.resolve(root).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase('en-US');
}

function resumePointerPath(sourceHash) {
  return path.join(os.homedir(), 'Documents', 'Draw2Data-Resultados', '.resume-index', `${sourceHash}.json`);
}

function readResumePointer(sourceHash, sourceRoot) {
  const file = resumePointerPath(sourceHash);
  try {
    const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (normalizeRoot(pointer.sourceRoot) !== normalizeRoot(sourceRoot)) return null;
    const output = path.resolve(pointer.output);
    const checkpoint = path.join(output, 'checkpoint.json');
    if (!fs.existsSync(checkpoint)) return null;
    return { file, output, checkpoint };
  } catch { return null; }
}

function safeSegment(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'arquivo';
}

async function addVisualEvidence(row, output) {
  const dimensions = row.analysis?.dimensions || [];
  if (!dimensions.length) return;
  const evidenceRoot = path.join(output, 'evidencias', safeSegment(row.relativePath));
  let pdfBytes;
  for (let index = 0; index < dimensions.length; index++) {
    const item = dimensions[index];
    if (!hasLocation(item)) {
      item.evidenceStatus = 'SEM_LOCALIZACAO';
      continue;
    }
    const relativeEvidencePath = path.join('evidencias', safeSegment(row.relativePath), `${String(index + 1).padStart(3, '0')}-p${item.page}.png`);
    const evidenceFile = path.join(output, relativeEvidencePath);
    try {
      if (!pdfBytes) pdfBytes = fs.readFileSync(row.sourcePath);
      fs.mkdirSync(evidenceRoot, { recursive: true });
      const snapshot = await renderDimensionSnapshot(pdfBytes, item);
      fs.writeFileSync(evidenceFile, snapshot.bytes);
      item.evidencePath = relativeEvidencePath;
      item.evidenceStatus = 'GERADA';
    } catch (error) {
      item.evidenceStatus = 'FALHA_AO_GERAR';
      item.evidenceError = String(error.message || error);
    }
  }
}

async function main() {
  console.log('\nDraw2Data · análise local em lote');
  console.log('Aceita caminho mapeado (U:\\) ou UNC (\\\\servidor\\compartilhamento\\pasta).');
  const auditOnly = /^s|true|1$/i.test(option('audit-only') || 'false');
  let sourceRoot = unquote(option('folder') ?? await ask('Pasta com os PDFs'));
  if (!sourceRoot) throw Error('Informe o caminho da pasta de origem.');
  let sourceRootError = '';
  let sourceIsDirectory = false;
  try { sourceIsDirectory = fs.statSync(sourceRoot).isDirectory(); } catch (error) { sourceRootError = error.message; }
  if (!sourceIsDirectory) {
    if (!auditOnly) throw Error(sourceRootError ? `A pasta não está acessível: ${sourceRootError}` : 'O caminho informado não é uma pasta.');
    sourceRootError ||= 'A pasta de origem não está acessível; conecte a unidade de rede para conferir os arquivos.';
    sourceRoot = path.resolve(sourceRoot);
  } else sourceRoot = fs.realpathSync(sourceRoot);
  const sourceLabel = path.basename(sourceRoot).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 48) || 'pasta';
  const sourceHash = crypto.createHash('sha1').update(sourceRoot.toLowerCase()).digest('hex').slice(0, 8);
  const previousRun = readResumePointer(sourceHash, sourceRoot);
  const suggestedOutput = previousRun?.output || path.join(os.homedir(), 'Documents', 'Draw2Data-Resultados', `${sourceLabel}-${sourceHash}`);
  if (previousRun) console.log(`Checkpoint encontrado. Resultados locais: ${suggestedOutput}`);
  let savedRecursive;
  if (previousRun) {
    try { savedRecursive = JSON.parse(fs.readFileSync(previousRun.checkpoint, 'utf8')).recursive; } catch {}
  }
  const recursive = option('recursive') !== undefined ? !/^n|false|0$/i.test(option('recursive'))
    : savedRecursive !== undefined ? Boolean(savedRecursive)
      : /^s/i.test(await ask('Incluir subpastas? S/N', 'S'));
  const modeChoice = option('mode') || (auditOnly ? '1' : await ask('Leitura: 1 completa (mais detalhada) ou 2 somente texto (mais rápida)', '1'));
  const maxPages = Math.max(1, Math.min(10, Number(option('pages') ?? (auditOnly ? 10 : await ask('Máximo de páginas por PDF (1–10)', '10'))) || 10));
  const batchLimit = Math.max(0, Number(option('batch') ?? 0) || 0);
  const retryFailures = auditOnly ? false : option('retry-failures') !== undefined
    ? /^s|true|1$/i.test(option('retry-failures'))
    : /^s/i.test(await ask('Tentar novamente PDFs que já falharam? S/N', 'N'));
  const output = path.resolve(unquote(option('output') ?? await ask('Pasta local para salvar os resultados', suggestedOutput)));
  fs.mkdirSync(output, { recursive: true });
  const checkpointPath = path.join(output, 'checkpoint.json');
  const fromScratch = !auditOnly && /^s|true|1$/i.test(option('from-scratch') || 'false');
  const scan = sourceRootError ? { files: [], inaccessible: [{ folder: sourceRoot, error: sourceRootError }] } : scanPdfs(sourceRoot, recursive);
  for (const item of scan.inaccessible) {
    item.probableCause = probableCause(item.error);
    console.log(`ERRO ao acessar ${item.folder}: ${item.error} · Possível causa: ${item.probableCause}`);
  }
  if (!scan.files.length && !auditOnly) throw Error('Não encontrei PDFs nessa pasta. Confira o endereço e as permissões da rede.');
  let manifest;
  if (fs.existsSync(checkpointPath) && !fromScratch) {
    manifest = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (normalizeRoot(manifest.sourceRoot) !== normalizeRoot(sourceRoot)) throw Error('Esta pasta de resultados já pertence a outra pasta de origem. Escolha outra pasta de saída.');
    console.log(`Retomando lote: ${Object.keys(manifest.files || {}).length} resultado(s) já registrados. As preferências originais serão mantidas.`);
  } else {
    if (fromScratch && fs.existsSync(checkpointPath)) {
      const backup = `${checkpointPath}.anterior-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(checkpointPath, backup);
      console.log(`Reprocessamento desde zero: checkpoint anterior preservado em ${backup}`);
    }
    const selectedMode = modeChoice === '2' || modeChoice.toLowerCase() === 'vector' ? 'vector' : 'complete';
    manifest = { format: 'draw2data-batch-checkpoint-v1', sourceRoot, recursive, settings: drawingOptions({ mode: selectedMode, maxPages, includePlain: true, minConfidence: 0, detailedScan: selectedMode === 'complete' }), createdAt: new Date().toISOString(), files: {}, inaccessibleFolders: [] };
  }
  if (manifest.settings?.mode !== 'vector') manifest.settings = drawingOptions({ ...manifest.settings, detailedScan: true });
  manifest.inaccessibleFolders = scan.inaccessible;
  const pending = scan.files.filter(file => {
    const relativePath = path.relative(sourceRoot, file), previous = manifest.files[relativePath];
    const stat = fs.statSync(file), fingerprint = `${stat.size}:${stat.mtimeMs}`;
    return needsAnalysis(previous, fingerprint, analysisVersionFor(path.basename(file), manifest.settings), true);
  });
  const skippedPreviousFailures = retryFailures ? [] : pending.filter(file => manifest.files[path.relative(sourceRoot, file)]?.error);
  const eligible = retryFailures ? pending : pending.filter(file => !manifest.files[path.relative(sourceRoot, file)]?.error);
  const queue = batchLimit ? eligible.slice(0, batchLimit) : eligible;
  const completed = scan.files.length - pending.length;
  const audit = buildAuditArtifacts(manifest, scan, output, manifest.settings);
  console.log(`\nPDFs encontrados: ${scan.files.length} · análises atuais: ${completed} · pendentes/alterados: ${pending.length} · falhas antigas aguardando nova tentativa: ${skippedPreviousFailures.length} · nesta execução: ${queue.length}`);
  console.log(`Auditoria gerada: ${path.join(output, 'auditoria-do-lote.xlsx')} · ${audit.summary.notAnalyzed} não analisado(s), ${audit.summary.noDimensions} sem cota(s), ${audit.summary.reviewDimensions} cota(s) para revisão.`);
  if (auditOnly) {
    atomicJson(resumePointerPath(sourceHash), { sourceRoot, output, updatedAt: new Date().toISOString() });
    console.log('Auditoria concluída sem processar PDFs. Confira as abas Pendentes, Sem cotas e Cotas revisar.');
    return;
  }
  console.log(batchLimit ? `Limite opcional por rodada: ${batchLimit} PDFs.` : 'Modo contínuo: todos os PDFs pendentes serão processados sem pausas por lote.');
  if (retryFailures) console.log('Arquivos com falha anterior serão tentados novamente.');
  else if (skippedPreviousFailures.length) console.log('Falhas anteriores foram mantidas na aba Falhas de acesso; use retry-failures=true para tentar novamente.');
  console.log(`Resultados locais: ${output}\n`);
  atomicJson(resumePointerPath(sourceHash), { sourceRoot, output, updatedAt: new Date().toISOString() });
  const progressPath = path.join(output, 'progresso-lote.json');
  if (!queue.length) {
    const finalStatus = skippedPreviousFailures.length ? 'CONCLUÍDO_COM_FALHAS_PENDENTES' : pending.length ? 'CONCLUÍDO_COM_PENDÊNCIAS' : 'CONCLUÍDO';
    const updatedAt = new Date().toISOString();
    manifest.lastRun = { ...(manifest.lastRun || {}), status: finalStatus, totalFiles: scan.files.length, pendingAfterRun: pending.length, updatedAt };
    atomicJson(checkpointPath, manifest);
    let previousProgress = {};
    try { previousProgress = JSON.parse(fs.readFileSync(progressPath, 'utf8')); } catch {}
    atomicJson(progressPath, { ...previousProgress, status: finalStatus, filesFound: scan.files.length, pendingAfterRun: pending.length, updatedAt });
    buildArtifacts(manifest, output); buildAuditArtifacts(manifest, scan, output, manifest.settings);
    console.log(pending.length ? `Nenhum PDF elegível para esta rodada. Permanecem ${pending.length} pendência(s), incluindo falhas que aguardam nova tentativa.` : 'Nada novo para analisar nesta rodada; auditoria e relatórios atualizados.');
    return;
  }
  const runStartedMs = Date.now();
  const runStartedAt = new Date(runStartedMs).toISOString();
  let failedThisRun = 0, intervalStartMs = runStartedMs;
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index], relativePath = path.relative(sourceRoot, file), stat = fs.statSync(file), fingerprint = `${stat.size}:${stat.mtimeMs}`;
    const fileStartedMs = Date.now();
    process.stdout.write(`[${completed + index + 1}/${scan.files.length}] ${relativePath} … `);
    try {
      if (stat.size > 100 * 1024 * 1024) throw Error('Arquivo excede o limite local de 100 MB.');
      const analysis = await processDrawing(path.basename(file), fs.readFileSync(file), manifest.settings);
      const metadata = identifyMetadata(path.basename(file), analysis);
      manifest.files[relativePath] = { relativePath, sourcePath: file, fingerprint, sizeBytes: stat.size, durationMs: Date.now() - fileStartedMs, ...metadata, analysis };
      await addVisualEvidence(manifest.files[relativePath], output);
      atomicJson(checkpointPath, manifest);
      console.log(`${metadata.tool} · ${analysis.dimensions.length} cota(s) · ${metadata.metadataReview ? 'conferir identificação' : 'identificação extraída'}`);
    } catch (error) {
      const message = String(error.message || error);
      failedThisRun++;
      manifest.files[relativePath] = { relativePath, sourcePath: file, fingerprint, sizeBytes: stat.size, engineVersion: analysisVersionFor(path.basename(file), manifest.settings), durationMs: Date.now() - fileStartedMs, error: message, probableCause: probableCause(message) };
      console.log(`FALHA · ${message} · Possível causa: ${probableCause(message)}`);
    }
    manifest.updatedAt = new Date().toISOString();
    const processedThisRun = index + 1, durationMs = Date.now() - runStartedMs;
    manifest.lastRun = { startedAt: runStartedAt, updatedAt: manifest.updatedAt, totalFiles: scan.files.length, processedThisRun, failedThisRun, durationMs, averageMsPerFile: durationMs / processedThisRun };
    atomicJson(checkpointPath, manifest);
    const elapsedMs = Date.now() - runStartedMs;
    const averageMsPerFile = elapsedMs / processedThisRun;
    const remainingThisRun = queue.length - processedThisRun;
    const progress = { status: 'EM_ANDAMENTO', sourceRoot, output, currentFile: relativePath, filesFound: scan.files.length, alreadyRegistered: completed, pendingAtStart: pending.length, skippedPreviousFailures: skippedPreviousFailures.length, processedThisRun, failedThisRun, elapsedMs, averageMsPerFile, estimatedRemainingMs: Math.round(averageMsPerFile * remainingThisRun), updatedAt: manifest.updatedAt };
    atomicJson(progressPath, progress);
    if (processedThisRun % 100 === 0 || processedThisRun === queue.length) {
      const intervalMs = Date.now() - intervalStartMs;
      const intervalCount = processedThisRun % 100 || (processedThisRun === queue.length ? processedThisRun % 100 || 100 : 100);
      const remainingMs = Math.round(averageMsPerFile * remainingThisRun);
      console.log(`\nIndicador: ${processedThisRun}/${queue.length} desta rodada · ${intervalCount} PDF(s) em ${formatDuration(intervalMs)} · média ${(averageMsPerFile / 1000).toFixed(1)} s/PDF · ${failedThisRun} falha(s) · restante estimado ${formatDuration(remainingMs)}.\n`);
      buildAuditArtifacts(manifest, scan, output, manifest.settings);
      intervalStartMs = Date.now();
    }
  }
  const remaining = Math.max(0, pending.length - queue.length);
  const eligibleRemaining = Math.max(0, eligible.length - queue.length);
  const finalStatus = eligibleRemaining ? 'RODADA_PARCIAL' : skippedPreviousFailures.length ? 'CONCLUÍDO_COM_FALHAS_PENDENTES' : 'CONCLUÍDO';
  manifest.lastRun.status = finalStatus;
  manifest.lastRun.pendingAfterRun = remaining;
  atomicJson(checkpointPath, manifest);
  let lastProgress = {};
  try { lastProgress = JSON.parse(fs.readFileSync(progressPath, 'utf8')); } catch {}
  atomicJson(progressPath, { ...lastProgress, status: finalStatus, pendingAfterRun: remaining, updatedAt: new Date().toISOString() });
  buildArtifacts(manifest, output);
  buildAuditArtifacts(manifest, scan, output, manifest.settings);
  console.log('\nLote concluído nesta execução. Arquivos gerados:');
  console.log(`- ${path.join(output, 'relatorio-do-lote.xlsx')} (revisão humana)`);
  console.log(`- ${path.join(output, 'manifesto-perfis.json')} (candidatos para importação)`);
  console.log(`- ${checkpointPath} (retomar processamento)`);
  console.log(`- ${progressPath} (indicadores detalhados)`);
  console.log(`Tempo desta rodada: ${formatDuration(Date.now() - runStartedMs)} para ${queue.length} PDF(s); média ${(queue.length ? (Date.now() - runStartedMs) / queue.length / 1000 : 0).toFixed(1)} s/PDF; ${failedThisRun} falha(s).`);
  console.log(remaining ? `Ainda há ${remaining} pendência(s); use a auditoria e execute novamente para continuar ou tentar as falhas.` : 'Todos os PDFs pendentes desta pasta foram processados.');
  console.log(`Auditoria atualizada: ${path.join(output, 'auditoria-do-lote.xlsx')}.`);
  console.log('Nenhum dado foi enviado ao app ou ao Supabase.');
}

if (require.main === module) main().catch(error => { console.error(`\nNão foi possível iniciar o lote: ${error.message}`); process.exitCode = 1; }).finally(() => input.close());
module.exports = { identifyMetadata, scanPdfs, buildArtifacts, buildAuditArtifacts, auditBatch, addVisualEvidence, hasLocation, needsAnalysis, normalizeRoot, readResumePointer, formatDuration, probableCause };
