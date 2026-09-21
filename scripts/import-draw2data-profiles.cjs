const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const defaultCheckpoint = path.join(process.env.USERPROFILE || '', 'Documents', 'Draw2Data-Resultados', 'pasta-23101f3e', 'checkpoint.json');

function readOptions(argv) {
  const options = { checkpoint: defaultCheckpoint, minDimensions: 2, commit: false, limit: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--checkpoint') options.checkpoint = argv[++index];
    else if (value === '--min-dimensions') options.minDimensions = Number(argv[++index]);
    else if (value === '--limit') options.limit = Number(argv[++index]);
    else if (value === '--commit') options.commit = true;
    else if (value === '--help') options.help = true;
    else throw Error(`Opção desconhecida: ${value}`);
  }
  if (!Number.isInteger(options.minDimensions) || options.minDimensions < 1 || options.minDimensions > 500) throw Error('Use --min-dimensions entre 1 e 500.');
  if (!(options.limit > 0)) throw Error('Use --limit maior que zero.');
  return options;
}

function help() {
  console.log('Uso: node scripts/import-draw2data-profiles.cjs [--checkpoint "C:\\...\\checkpoint.json"] [--min-dimensions 2] [--limit 50] [--commit]');
  console.log('Sem --commit, apenas lista o que seria importado. A importação nunca sobrescreve um perfil ou revisão existente.');
}

function keyOf(item) {
  return `${String(item.tool || '').trim().toUpperCase()}|${item.sequence == null ? '' : item.sequence}|${String(item.revision || '00').trim()}`;
}

function dimensionRows(entry) {
  return (entry.analysis?.dimensions || []).filter(item => {
    if (!item || item.status === 'IGNORADO') return false;
    const nominal = Number(item.nominal);
    const plus = item.tolerancePlus == null || item.tolerancePlus === '' ? null : Number(item.tolerancePlus);
    const minus = item.toleranceMinus == null || item.toleranceMinus === '' ? null : Number(item.toleranceMinus);
    return Number.isFinite(nominal) && nominal >= 0 && nominal <= 100000 &&
      (plus === null || Number.isFinite(plus) && plus >= 0 && plus <= 100000) &&
      (minus === null || Number.isFinite(minus) && minus >= 0 && minus <= 100000);
  });
}

function isEligible(entry, minimum) {
  const tool = String(entry.tool || '').trim().toUpperCase();
  return !!entry.analysis && !entry.error && tool && tool !== 'NAO_IDENTIFICADO' && !entry.codeConflict &&
    dimensionRows(entry).length >= minimum && typeof entry.sourcePath === 'string' && fs.existsSync(entry.sourcePath) &&
    fs.statSync(entry.sourcePath).size > 0 && fs.statSync(entry.sourcePath).size <= 25 * 1024 * 1024;
}

function candidateScore(entry) {
  const file = path.basename(entry.sourcePath || '').toLowerCase();
  const base = `${String(entry.tool || '').toLowerCase()}.pdf`;
  return [file === base ? 1 : 0, dimensionRows(entry).length, -file.length];
}

function chooseCandidate(entries) {
  return entries.slice().sort((a, b) => {
    const left = candidateScore(a), right = candidateScore(b);
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return right[index] - left[index];
    return String(a.relativePath || '').localeCompare(String(b.relativePath || ''));
  })[0];
}

function saveManifest(file, manifest) {
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (options.help) return help();
  const checkpointPath = path.resolve(options.checkpoint);
  if (!fs.existsSync(checkpointPath)) throw Error(`Checkpoint não encontrado: ${checkpointPath}`);
  const credentialsPath = path.join(root, '.cloud-credentials.json');
  if (!fs.existsSync(credentialsPath)) throw Error('A configuração da base de dados não foi encontrada neste computador.');
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const manifestPath = path.join(path.dirname(checkpointPath), 'importacao-base-draw2data.json');
  const allEntries = Object.values(checkpoint.files || {});
  const groups = new Map();
  for (const entry of allEntries) {
    if (!isEligible(entry, options.minDimensions)) continue;
    const key = keyOf(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const selected = [...groups.values()].map(chooseCandidate).slice(0, options.limit);
  const duplicateCandidates = [...groups.values()].reduce((count, entries) => count + Math.max(0, entries.length - 1), 0);
  const manifest = {
    format: 'draw2data-profile-import-v1',
    generatedAt: new Date().toISOString(),
    checkpoint: checkpointPath,
    mode: options.commit ? 'COMMIT' : 'SIMULACAO',
    criteria: { minDimensions: options.minDimensions, requiresKnownTool: true, requiresSourcePdf: true, maxPdfBytes: 25 * 1024 * 1024 },
    summary: { checkpointRecords: allEntries.length, candidates: selected.length, duplicateCandidates, imported: 0, existing: 0, failed: 0 },
    items: []
  };
  const endpoint = credentials.endpoint;
  async function call(action, { method = 'GET', body, type = 'application/json', object } = {}) {
    const url = new URL(endpoint);
    url.searchParams.set('action', action);
    if (object) url.searchParams.set('path', object);
    const response = await fetch(url, { method, headers: { 'x-collector-token': credentials.token, 'Content-Type': type }, body });
    if (!response.ok) throw Error(`${action}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response;
  }
  const existing = await (await call('control-profiles')).json();
  const existingKeys = new Set(existing.map(keyOf));
  for (const entry of selected) {
    const tool = String(entry.tool).trim().toUpperCase();
    const revision = String(entry.revision || '00').trim() || '00';
    const key = keyOf({ tool, sequence: entry.sequence, revision });
    const item = { file: entry.relativePath, tool, revision, dimensions: dimensionRows(entry).length, status: '' };
    if (existingKeys.has(key)) {
      item.status = 'JA_EXISTE';
      manifest.summary.existing += 1;
      manifest.items.push(item);
      continue;
    }
    if (!options.commit) {
      item.status = 'PRONTO_PARA_IMPORTAR';
      manifest.items.push(item);
      continue;
    }
    const id = crypto.randomUUID();
    const drawingPath = `control-drawings/${id}.pdf`;
    try {
      await call('file', { method: 'PUT', object: drawingPath, type: 'application/pdf', body: fs.readFileSync(entry.sourcePath) });
      await call('control-profiles', {
        method: 'POST',
        body: JSON.stringify({
          id, tool, sequence: entry.sequence == null ? null : entry.sequence, revision,
          name: `${tool} - Perfil dimensional (importado)`, dimensions: dimensionRows(entry), drawingPath
        })
      });
      existingKeys.add(key);
      item.status = 'IMPORTADO';
      item.id = id;
      manifest.summary.imported += 1;
    } catch (error) {
      item.status = 'FALHOU';
      item.error = error.message;
      manifest.summary.failed += 1;
    }
    manifest.items.push(item);
    saveManifest(manifestPath, manifest);
  }
  saveManifest(manifestPath, manifest);
  console.log(JSON.stringify({ ...manifest.summary, manifest: manifestPath }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
