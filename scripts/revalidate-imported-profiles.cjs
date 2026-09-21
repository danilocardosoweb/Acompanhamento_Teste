const fs = require('fs');
const os = require('os');
const path = require('path');
const { processDrawing, analysisVersionFor } = require('../draw2data/processing.cjs');

const root = path.join(__dirname, '..');
const defaultCheckpoint = path.join(os.homedir(), 'Documents', 'Draw2Data-Resultados', 'pasta-23101f3e', 'checkpoint.json');

function options(argv) {
  const result = { checkpoint: defaultCheckpoint, limit: Infinity, match: '', commit: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--checkpoint') result.checkpoint = argv[++i];
    else if (argv[i] === '--limit') result.limit = Number(argv[++i]);
    else if (argv[i] === '--match') result.match = String(argv[++i] || '').toUpperCase();
    else if (argv[i] === '--commit') result.commit = true;
    else if (argv[i] === '--help') result.help = true;
    else throw Error(`Opção desconhecida: ${argv[i]}`);
  }
  if (!(result.limit > 0)) throw Error('Use --limit maior que zero.');
  return result;
}

function keyOf(item) {
  return `${String(item.tool || '').trim().toUpperCase()}|${item.sequence == null ? '' : item.sequence}|${String(item.revision || '00').trim()}`;
}

function fingerprint(file) {
  const stat = fs.statSync(file);
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function validDimensions(analysis) {
  return (analysis?.dimensions || []).filter(item => item && item.status !== 'IGNORADO' && Number.isFinite(Number(item.nominal)));
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

async function main() {
  const input = options(process.argv.slice(2));
  if (input.help) {
    console.log('Uso: node scripts/revalidate-imported-profiles.cjs [--checkpoint "C:\\...\\checkpoint.json"] [--match 19-0065] [--limit 10] [--commit]');
    return;
  }
  const checkpointPath = path.resolve(input.checkpoint);
  const credentialsPath = path.join(root, '.cloud-credentials.json');
  if (!fs.existsSync(checkpointPath) || !fs.existsSync(credentialsPath)) throw Error('Checkpoint ou configuração da base não encontrado.');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const progressPath = path.join(path.dirname(checkpointPath), 'revalidacao-base-draw2data.json');
  let progress = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, 'utf8')) : { format: 'draw2data-database-revalidation-v1', items: {} };
  progress.startedAt ||= new Date().toISOString();
  progress.mode = input.commit ? 'COMMIT' : 'SIMULACAO';

  async function call(action, { method = 'GET', body } = {}) {
    const url = new URL(credentials.endpoint); url.searchParams.set('action', action);
    const response = await fetch(url, { method, headers: { 'x-collector-token': credentials.token, 'Content-Type': 'application/json' }, body });
    if (!response.ok) throw Error(`${action}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response;
  }

  const profiles = (await (await call('control-profiles')).json()).filter(item => /\(importado\)/i.test(String(item.name || '')));
  if (input.commit) {
    for (const profile of profiles) await call('control-profiles-update', { method: 'POST', body: JSON.stringify({ id: profile.id, active: false }) });
  }
  const entries = Object.values(checkpoint.files || {});
  const byKey = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  }
  const selected = profiles.filter(profile => !input.match || `${profile.tool} ${profile.name}`.toUpperCase().includes(input.match)).slice(0, input.limit);
  let corrected = 0, pending = 0, failed = 0, skipped = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const profile = selected[index], candidates = (byKey.get(keyOf(profile)) || []).filter(entry => entry.sourcePath && fs.existsSync(entry.sourcePath));
    const entry = candidates.sort((a, b) => (path.basename(a.sourcePath).toUpperCase() === `${profile.tool}.PDF` ? -1 : 0) - (path.basename(b.sourcePath).toUpperCase() === `${profile.tool}.PDF` ? -1 : 0))[0];
    const saved = progress.items[profile.id];
    if (entry && saved?.status === 'CORRIGIDO_SUSPENSO' && saved.fingerprint === fingerprint(entry.sourcePath) && saved.engineVersion === analysisVersionFor(path.basename(entry.sourcePath), { detailedScan: true })) {
      skipped += 1; continue;
    }
    if (!entry) {
      pending += 1; progress.items[profile.id] = { tool: profile.tool, status: 'ORIGINAL_NAO_ENCONTRADO', updatedAt: new Date().toISOString() }; writeJson(progressPath, progress); continue;
    }
    try {
      console.log(`[${index + 1}/${selected.length}] ${profile.tool} · analisando`);
      const bytes = fs.readFileSync(entry.sourcePath);
      const analysis = await processDrawing(path.basename(entry.sourcePath), bytes, { mode: 'complete', maxPages: 10, includePlain: true, minConfidence: 0, detailedScan: true });
      const dimensions = validDimensions(analysis);
      entry.analysis = analysis; entry.error = null; entry.fingerprint = fingerprint(entry.sourcePath); entry.reviewedAt = new Date().toISOString();
      if (dimensions.length < 2) {
        pending += 1;
        progress.items[profile.id] = { tool: profile.tool, file: entry.relativePath, status: 'AGUARDA_REVISAO_MANUAL', dimensions: dimensions.length, suggestions: analysis.suggestions?.length || 0, fingerprint: entry.fingerprint, engineVersion: analysis.engineVersion, updatedAt: new Date().toISOString() };
      } else {
        if (input.commit) await call('control-profiles-update', { method: 'POST', body: JSON.stringify({ id: profile.id, dimensions, active: false }) });
        corrected += 1;
        progress.items[profile.id] = { tool: profile.tool, file: entry.relativePath, status: input.commit ? 'CORRIGIDO_SUSPENSO' : 'PRONTO_PARA_CORRIGIR', dimensions: dimensions.length, suggestions: analysis.suggestions?.length || 0, fingerprint: entry.fingerprint, engineVersion: analysis.engineVersion, updatedAt: new Date().toISOString() };
      }
      writeJson(checkpointPath, checkpoint); writeJson(progressPath, progress);
    } catch (error) {
      failed += 1; progress.items[profile.id] = { tool: profile.tool, file: entry.relativePath, status: 'FALHOU', error: error.message, updatedAt: new Date().toISOString() }; writeJson(progressPath, progress);
      console.error(`${profile.tool}: ${error.message}`);
    }
  }
  progress.updatedAt = new Date().toISOString(); progress.summary = { importedProfiles: profiles.length, selected: selected.length, corrected, pendingManualReview: pending, failed, skipped, activeAfterRun: 0 };
  writeJson(progressPath, progress); writeJson(checkpointPath, checkpoint);
  console.log(JSON.stringify({ ...progress.summary, progress: progressPath }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
