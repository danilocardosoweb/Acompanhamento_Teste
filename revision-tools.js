(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProfileRevisions = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const typeOf = item => {
    const text = String(item?.rawText || item?.recognizedText || '');
    if (item?.reference || /\bREF\b/i.test(text)) return 'REFERENCE';
    if (item?.symbol === 'R' || item?.dimensionType === 'RADIUS' || /^\s*R\s*\d/i.test(text)) return 'RADIUS';
    if (item?.symbol === 'Ø' || item?.symbol === '⌀' || /[Ø⌀]/.test(text)) return 'DIAMETER';
    return item?.tolerancePlus != null || item?.toleranceMinus != null ? 'TOLERANCED_LINEAR' : 'LINEAR';
  };

  function nextRevision(profiles) {
    const labels = (profiles || []).map(item => String(item.revision || '00'));
    if (!labels.length) return '00';
    const numeric = labels.filter(label => /^\d+$/.test(label));
    if (numeric.length !== labels.length) return '';
    const width = Math.max(2, ...numeric.map(label => label.length));
    return String(Math.max(...numeric.map(Number)) + 1).padStart(width, '0');
  }

  function center(item) {
    return { x: Number(item.x || 0) + Number(item.width || 0) / 2, y: Number(item.y || 0) + Number(item.height || 0) / 2 };
  }

  function sameMeasure(a, b) {
    return Number(a.nominal) === Number(b.nominal)
      && (a.tolerancePlus == null ? null : Number(a.tolerancePlus)) === (b.tolerancePlus == null ? null : Number(b.tolerancePlus))
      && (a.toleranceMinus == null ? null : Number(a.toleranceMinus)) === (b.toleranceMinus == null ? null : Number(b.toleranceMinus))
      && typeOf(a) === typeOf(b);
  }

  function compareProfiles(previous, current, { maxDistance = 70 } = {}) {
    const before = previous?.dimensions || [], after = current?.dimensions || [];
    const options = [];
    const byKey = new Map();
    after.forEach((item, index) => { if (item.dimensionKey) byKey.set(String(item.dimensionKey), index); });
    const usedOld = new Set(), usedNew = new Set(), pairs = [];
    before.forEach((oldItem, oldIndex) => {
      const newIndex = oldItem.dimensionKey ? byKey.get(String(oldItem.dimensionKey)) : undefined;
      if (newIndex === undefined || usedNew.has(newIndex)) return;
      usedOld.add(oldIndex); usedNew.add(newIndex);
      const newItem = after[newIndex], unchanged = sameMeasure(oldItem, newItem);
      pairs.push({ status: unchanged ? 'UNCHANGED' : 'CHANGED', certainty: 'HIGH', old: oldItem, current: newItem, distance: 0,
        changes: { nominal: Number(oldItem.nominal) !== Number(newItem.nominal), tolerancePlus: (oldItem.tolerancePlus == null ? null : Number(oldItem.tolerancePlus)) !== (newItem.tolerancePlus == null ? null : Number(newItem.tolerancePlus)), toleranceMinus: (oldItem.toleranceMinus == null ? null : Number(oldItem.toleranceMinus)) !== (newItem.toleranceMinus == null ? null : Number(newItem.toleranceMinus)), type: typeOf(oldItem) !== typeOf(newItem) } });
    });
    before.forEach((oldItem, oldIndex) => after.forEach((newItem, newIndex) => {
      if (usedOld.has(oldIndex) || usedNew.has(newIndex)) return;
      if (typeOf(oldItem) !== typeOf(newItem)) return;
      const oldPos = center(oldItem), newPos = center(newItem);
      const distance = Math.hypot(oldPos.x - newPos.x, oldPos.y - newPos.y) + (Number(oldItem.page || 1) === Number(newItem.page || 1) ? 0 : 90);
      const sameText = String(oldItem.rawText || '').trim().toLowerCase() === String(newItem.rawText || '').trim().toLowerCase();
      const sameValue = Number(oldItem.nominal) === Number(newItem.nominal);
      const hasPosition = [oldItem.x, oldItem.y, newItem.x, newItem.y].every(value => Number.isFinite(Number(value)));
      const score = hasPosition ? distance - (sameText ? 22 : sameValue ? 10 : 0) : sameText ? 0 : Infinity;
      if ((hasPosition && distance <= maxDistance) || (!hasPosition && sameText)) options.push({ oldIndex, newIndex, score, distance, sameText });
    }));
    options.sort((a, b) => a.score - b.score);
    for (const pair of options) {
      if (usedOld.has(pair.oldIndex) || usedNew.has(pair.newIndex)) continue;
      const oldAlternates = options.filter(item => item.oldIndex === pair.oldIndex && item.newIndex !== pair.newIndex && item.score - pair.score < 12);
      const newAlternates = options.filter(item => item.newIndex === pair.newIndex && item.oldIndex !== pair.oldIndex && item.score - pair.score < 12);
      if (oldAlternates.length || newAlternates.length) continue;
      usedOld.add(pair.oldIndex); usedNew.add(pair.newIndex);
      const oldItem = before[pair.oldIndex], newItem = after[pair.newIndex];
      const unchanged = sameMeasure(oldItem, newItem);
      pairs.push({
        status: unchanged ? 'UNCHANGED' : 'CHANGED',
        certainty: pair.sameText || pair.distance <= 20 ? 'HIGH' : 'REVIEW',
        old: oldItem,
        current: newItem,
        distance: Math.round(pair.distance),
        changes: {
          nominal: Number(oldItem.nominal) !== Number(newItem.nominal),
          tolerancePlus: (oldItem.tolerancePlus == null ? null : Number(oldItem.tolerancePlus)) !== (newItem.tolerancePlus == null ? null : Number(newItem.tolerancePlus)),
          toleranceMinus: (oldItem.toleranceMinus == null ? null : Number(oldItem.toleranceMinus)) !== (newItem.toleranceMinus == null ? null : Number(newItem.toleranceMinus)),
          type: typeOf(oldItem) !== typeOf(newItem),
        },
      });
      if (oldItem.dimensionKey) newItem.dimensionKey = oldItem.dimensionKey;
    }
    return [
      ...pairs,
      ...before.flatMap((item, index) => usedOld.has(index) ? [] : [{ status: 'REMOVED', certainty: 'REVIEW', old: item, current: null, changes: {} }]),
      ...after.flatMap((item, index) => usedNew.has(index) ? [] : [{ status: 'ADDED', certainty: 'REVIEW', old: null, current: item, changes: {} }]),
    ];
  }

  function displayValue(item) {
    if (!item) return '—';
    const nominal = String(item.rawText || item.nominal || '');
    return nominal.replace(/\s+/g, ' ').trim();
  }

  function describeChanges(pair) {
    if (!pair?.old || !pair?.current) return pair?.status === 'ADDED' ? 'Nova cota' : pair?.status === 'REMOVED' ? 'Cota removida' : '';
    const value = item => item == null ? '—' : String(item).replace('.', ',');
    const changes = pair.changes || {};
    return [
      changes.nominal && `Nominal ${value(pair.old.nominal)} → ${value(pair.current.nominal)}`,
      changes.tolerancePlus && `Tol. + ${value(pair.old.tolerancePlus)} → ${value(pair.current.tolerancePlus)}`,
      changes.toleranceMinus && `Tol. − ${value(pair.old.toleranceMinus)} → ${value(pair.current.toleranceMinus)}`,
      changes.type && `Tipo ${typeOf(pair.old)} → ${typeOf(pair.current)}`,
    ].filter(Boolean).join('; ') || 'Sem mudança dimensional';
  }

  function mountManagerComparison() {
    if (typeof document === 'undefined' || document.getElementById('controle-revision-compare')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'controle-revision-compare';
    dialog.className = 'controle-revision-dialog';
    dialog.innerHTML = '<section><button type="button" class="controle-report-close secondary" aria-label="Fechar">×</button><div class="eyebrow">HISTÓRICO DE DESENHOS</div><h3>Comparar revisões</h3><div class="controle-revision-selects"><label>Revisão anterior<select data-old></select></label><label>Revisão nova<select data-new></select></label></div><div data-result class="controle-revision-result"></div></section>';
    document.body.append(dialog);
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    const render = group => {
      const oldSelect = dialog.querySelector('[data-old]'), newSelect = dialog.querySelector('[data-new]');
      const options = group.map(profile => `<option value="${escapeHtml(profile.id)}">Rev. ${escapeHtml(profile.revision)} · ${escapeHtml(profile.name)}</option>`).join('');
      oldSelect.innerHTML = options; newSelect.innerHTML = options;
      oldSelect.value = group[0].id; newSelect.value = group[group.length - 1].id;
      const update = () => {
        const oldProfile = group.find(item => item.id === oldSelect.value), newProfile = group.find(item => item.id === newSelect.value), result = dialog.querySelector('[data-result]');
        if (!oldProfile || !newProfile || oldProfile.id === newProfile.id) { result.textContent = 'Escolha duas revisões diferentes.'; return; }
        const differences = compareProfiles(oldProfile, newProfile), counts = differences.reduce((all, item) => (all[item.status] = (all[item.status] || 0) + 1, all), {});
        const rows = differences.map(item => `<tr><td>${item.status === 'CHANGED' ? 'Alterada' : item.status === 'UNCHANGED' ? 'Sem alteração' : item.status === 'ADDED' ? 'Nova' : 'Removida'}${item.certainty === 'REVIEW' ? '<small>Confira a associação no desenho</small>' : ''}</td><td>${escapeHtml(displayValue(item.old))}</td><td>${escapeHtml(displayValue(item.current))}</td><td>${escapeHtml(describeChanges(item))}</td></tr>`).join('');
        result.innerHTML = `<p>Rev. ${escapeHtml(oldProfile.revision)} → Rev. ${escapeHtml(newProfile.revision)}: ${counts.CHANGED || 0} alterada(s), ${counts.ADDED || 0} nova(s), ${counts.REMOVED || 0} removida(s), ${counts.UNCHANGED || 0} sem alteração.</p><div class="draw2data-revision-table-wrap"><table><thead><tr><th>Situação</th><th>Anterior</th><th>Atual</th><th>Diferença</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      };
      oldSelect.onchange = update; newSelect.onchange = update; update(); dialog.showModal();
    };
    const attach = () => {
      const list = document.getElementById('controle-profile-list');
      if (!list || list.dataset.revisionCompareBound) return;
      list.dataset.revisionCompareBound = 'true';
      list.addEventListener('click', event => {
        const button = event.target.closest('.controle-compare-profile');
        if (!button) return;
        const profiles = Array.from(list.querySelectorAll('.controle-profile-item')).filter(row => row.querySelector('strong')?.textContent.trim().toUpperCase() === button.closest('.controle-profile-item')?.querySelector('strong')?.textContent.trim().toUpperCase());
        const ids = new Set(profiles.map(row => row.querySelector('.controle-compare-profile')?.dataset.id).filter(Boolean));
        const group = window.__qualityProfilesForRevisionComparison?.().filter(profile => ids.has(profile.id)) || [];
        if (group.length > 1) render(group.sort((a, b) => String(a.revision).localeCompare(String(b.revision), undefined, { numeric: true })));
      });
    };
    new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
    attach();
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  if (typeof document !== 'undefined') mountManagerComparison();

  return { typeOf, nextRevision, compareProfiles, displayValue, describeChanges };
});
