// app.js — panel cards-admin (vanilla JS, español)
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
const PAGE_SIZE = 20;
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('Error ' + r.status));
  return data;
}
// Acepta tanto el arreglo viejo como el objeto paginado { items, page, total, pages }.
function asPage(data) {
  if (Array.isArray(data)) return { items: data, page: 1, total: data.length, pages: 1 };
  return data;
}
let series = [], cards = [];
let cardsPage = 1, copiesPage = 1, usersPage = 1;

const RARITY_CLASS = { 'Común': 'comun', 'Raro': 'raro', 'Épico': 'epico', 'Legendario': 'legendario' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderPager(elId, pageData, onPage) {
  const el = $(elId);
  if (!pageData || pageData.pages <= 1) { el.innerHTML = pageData && pageData.total > 0 ? `<span>Página ${pageData.page} de ${pageData.pages} · ${pageData.total} en total</span>` : ''; return; }
  el.innerHTML = '';
  const prev = document.createElement('button');
  prev.textContent = '‹ Anterior'; prev.className = 'secondary'; prev.disabled = pageData.page <= 1;
  prev.onclick = () => onPage(pageData.page - 1);
  const label = document.createElement('span');
  label.textContent = `Página ${pageData.page} de ${pageData.pages} · ${pageData.total} en total`;
  const next = document.createElement('button');
  next.textContent = 'Siguiente ›'; next.className = 'secondary'; next.disabled = pageData.page >= pageData.pages;
  next.onclick = () => onPage(pageData.page + 1);
  el.append(prev, label, next);
}

async function loadAll() {
  const st = await api('/api/admin/stats');
  $('stats').innerHTML = ['series', 'cards', 'copies', 'users', 'pending_drops'].map(k =>
    `<div><b>${st[k]}</b><span>${{ series: 'Series', cards: 'Cartas', copies: 'Copias', users: 'Usuarios', pending_drops: 'Drops pendientes' }[k]}</span></div>`).join('');
  series = await api('/api/admin/series');
  cardsPage = 1; copiesPage = 1; usersPage = 1;
  renderSeries();
  await renderCards(1); await renderCopies(1); await renderUsers(1);
  const opts = series.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('cardSeries').innerHTML = opts; $('csvSeries').innerHTML = opts;
  $('cardSeriesFilter').innerHTML = '<option value="">Todas</option>' + opts;
}
function renderSeries() {
  $('seriesList').innerHTML = series.map(s => `<div class="item"><div class="grow"><b>${esc(s.name)}</b> <small>/${esc(s.slug)}</small>${s.code ? ` <span class="pill">${esc(s.code)}</span>` : ''} <span class="pill ${s.active ? 'active' : 'inactive'}">${s.active ? 'activa' : 'inactiva'}</span><br><small>${esc(s.description || '')}</small></div><div class="row"><button onclick="editSeries('${s.id}')" class="secondary">Editar</button><button onclick="delSeries('${s.id}')" class="danger">Borrar</button></div></div>`).join('') || '<p class="muted">No hay series. Crea la primera abajo.</p>';
}
async function renderCards(page = 1) {
  cardsPage = page;
  const f = $('cardSeriesFilter').value;
  const data = asPage(await api(`/api/admin/cards?page=${page}&limit=${PAGE_SIZE}` + (f ? '&series_id=' + encodeURIComponent(f) : '')));
  cards = data.items;
  $('cardsList').innerHTML = cards.map(c => {
    const s = series.find(x => x.id === c.series_id);
    const pill = RARITY_CLASS[c.rarity] || 'comun';
    return `<div class="item">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : ''}<div class="grow"><b>${esc(c.name)}</b>${c.code ? ` <small>${esc(c.code)}</small>` : ''} <span class="pill ${pill}">${esc(c.rarity)}</span> <span class="pill ${c.active ? 'active' : 'inactive'}">${c.active ? 'activa' : 'inactiva'}</span><br><small>${esc(s ? s.name : '')} · ${esc(c.team_or_group)} · ${esc(c.position_or_role)}</small><br><small>Máx. copias: ${c.max_copies} · Valor: ${c.value}</small></div><div class="row"><button onclick="editCard('${c.id}')" class="secondary">Editar</button><button onclick="delCard('${c.id}')" class="danger">Borrar</button></div></div>`;
  }).join('') || '<p class="muted">No hay cartas en esta vista.</p>';
  renderPager('cardsPager', data, (p) => renderCards(p));
}
async function renderCopies(page = 1) {
  copiesPage = page;
  const q = $('copySearch').value || '';
  const data = asPage(await api('/api/admin/copies?search=' + encodeURIComponent(q) + `&page=${page}&limit=${PAGE_SIZE}`));
  $('copiesList').innerHTML = data.items.length ? `<div class="table-wrap"><table><tr><th>Carta</th><th>Código</th><th>Serie</th><th>Usuario</th><th>Fecha</th></tr>${data.items.map(c => `<tr><td>${esc(c.card_name)} <b>${esc(c.serie)}</b></td><td><code>${esc(c.code || '')}</code></td><td>${esc(c.series_name)}</td><td>${esc(c.user_phone)}</td><td>${new Date(c.claimed_at).toLocaleString()}</td></tr>`).join('')}</table></div>` : '<p class="muted">Aún no hay copias reclamadas.</p>';
  renderPager('copiesPager', data, (p) => renderCopies(p));
}
async function renderUsers(page = 1) {
  usersPage = page;
  const data = asPage(await api(`/api/admin/users?page=${page}&limit=${PAGE_SIZE}`));
  $('usersList').innerHTML = data.items.map(u => `<div class="item"><div class="grow"><b>${esc(u.display_name || u.phone)}</b><br><small>${esc(u.phone)} · ${u.copies} carta(s)</small></div><button onclick="showInv('${esc(u.phone)}')" class="secondary">Ver inventario</button></div>`).join('') || '<p class="muted">Aún no hay usuarios.</p>';
  renderPager('usersPager', data, (p) => renderUsers(p));
}
window.showInv = async (phone) => {
  const inv = await api('/api/admin/users/' + encodeURIComponent(phone) + '/inventory');
  $('userInv').innerHTML = `<div class="card"><h3>Inventario de ${esc(phone)}</h3>${inv.copies.map(c => `<div>${esc(c.card_name)} <b>${esc(c.serie)}</b> · ${esc(c.rarity)}${c.code ? ` · <code>${esc(c.code)}</code>` : ''}</div>`).join('') || '<p class="muted">Sin cartas.</p>'}</div>`;
};
window.editSeries = (id) => { const s = series.find(x => x.id === id); $('seriesId').value = s.id; $('seriesName').value = s.name; $('seriesSlug').value = s.slug; $('seriesCode').value = s.code || ''; $('seriesDesc').value = s.description; $('seriesActive').checked = s.active; $('seriesFormTitle').textContent = 'Editar serie'; window.scrollTo(0, document.getElementById('seriesForm').offsetTop); };
window.delSeries = async (id) => { if (!confirm('¿Borrar esta serie y todas sus cartas y copias?')) return; await api('/api/admin/series/' + id, { method: 'DELETE' }); await loadAll(); };
window.editCard = (id) => { const c = cards.find(x => x.id === id); if (!c) return; $('cardId').value = c.id; $('cardSeries').value = c.series_id; $('cardName').value = c.name; $('cardCode').value = c.code || ''; $('cardTeam').value = c.team_or_group; $('cardPos').value = c.position_or_role; $('cardRarity').value = c.rarity; $('cardMax').value = c.max_copies; $('cardValue').value = c.value; $('cardImage').value = c.image_url; $('cardActive').checked = c.active; $('cardPreview').innerHTML = c.image_url ? `<img src="${esc(c.image_url)}" class="preview-img">` : ''; $('cardFormTitle').textContent = 'Editar carta'; window.scrollTo(0, document.getElementById('cardForm').offsetTop); };
window.delCard = async (id) => { if (!confirm('¿Borrar esta carta y sus copias?')) return; await api('/api/admin/cards/' + id, { method: 'DELETE' }); await loadAll(); };

// ---- CSV: parseo en el cliente (sin dependencias) ----
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') pushRow();
    else if (ch === '\r') { /* se ignora, el \n cierra la fila */ }
    else field += ch;
  }
  if (field !== '' || row.length) pushRow();
  // Quita filas vacías (líneas en blanco al final).
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}
let csvRows = [];
function csvToCards(rows) {
  if (!rows.length) return { error: 'El CSV está vacío.' };
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const need = ['name'];
  for (const n of need) if (!header.includes(n)) return { error: 'El CSV debe tener al menos la columna "name". Columnas esperadas: name, team_or_group, position_or_role, rarity, max_copies, image_url, value.' };
  const idx = (name) => header.indexOf(name);
  const cards = rows.slice(1).map(r => ({
    name: (r[idx('name')] || '').trim(),
    code: idx('code') >= 0 ? (r[idx('code')] || '').trim() : '',
    team_or_group: idx('team_or_group') >= 0 ? (r[idx('team_or_group')] || '').trim() : '',
    position_or_role: idx('position_or_role') >= 0 ? (r[idx('position_or_role')] || '').trim() : '',
    rarity: idx('rarity') >= 0 ? (r[idx('rarity')] || '').trim() || 'Común' : 'Común',
    max_copies: idx('max_copies') >= 0 ? parseInt(r[idx('max_copies')], 10) || 100 : 100,
    image_url: idx('image_url') >= 0 ? (r[idx('image_url')] || '').trim() : '',
    value: idx('value') >= 0 ? parseInt(r[idx('value')], 10) || 0 : 0,
  }));
  return { cards };
}
$('csvFile').onchange = async () => {
  const f = $('csvFile').files[0];
  $('csvPreview').innerHTML = ''; $('csvResult').innerHTML = ''; csvRows = [];
  $('csvImportBtn').disabled = true;
  if (!f) return;
  const text = await f.text();
  const parsed = csvToCards(parseCSV(text));
  if (parsed.error) { $('csvPreview').innerHTML = `<p class="error">${esc(parsed.error)}</p>`; return; }
  csvRows = parsed.cards;
  const preview = csvRows.slice(0, 8);
  $('csvPreview').innerHTML = `<p><b>${csvRows.length} carta(s)</b> listas para importar a la serie seleccionada.</p>` +
    `<div class="table-wrap"><table><tr><th>Nombre</th><th>Equipo</th><th>Rareza</th><th>Máx.</th><th>Valor</th></tr>` +
    preview.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.team_or_group)}</td><td>${esc(c.rarity)}</td><td>${c.max_copies}</td><td>${c.value}</td></tr>`).join('') +
    `</table></div>` + (csvRows.length > 8 ? `<p class="muted">…y ${csvRows.length - 8} más.</p>` : '');
  $('csvImportBtn').disabled = false;
};
$('csvTemplateBtn').onclick = () => {
  const blob = new Blob(['name,code,team_or_group,position_or_role,rarity,max_copies,image_url,value\nHenry Martín,MAR,América,Delantero,Épico,25,,100\nLuis Malagón,MAL,América,Portero,Común,500,,10\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'plantilla-cartas.csv'; a.click();
  URL.revokeObjectURL(a.href);
};
$('csvImportBtn').onclick = async () => {
  const series_id = $('csvSeries').value;
  if (!series_id) return alert('Elige primero la serie destino.');
  if (!csvRows.length) return;
  $('csvImportBtn').disabled = true;
  try {
    const r = await api('/api/admin/import-cards', { method: 'POST', body: JSON.stringify({ series_id, cards: csvRows }) });
    let html = `<p class="success"><b>${r.imported} de ${r.total} cartas importadas.</b></p>`;
    if (r.failed.length) {
      html += `<p class="error">${r.failed.length} fallaron:</p><ul class="fail-list">` +
        r.failed.map(f => `<li>Fila ${f.row} (${esc(f.name || 'sin nombre')}): ${esc(f.error)}</li>`).join('') + '</ul>';
    }
    $('csvResult').innerHTML = html;
    $('csvFile').value = ''; $('csvPreview').innerHTML = ''; csvRows = [];
    await loadAll();
  } catch (e) { $('csvResult').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  $('csvImportBtn').disabled = false;
};

$('loginBtn').onclick = async () => {
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value }) }); $('loginBox').classList.add('hidden'); $('app').classList.remove('hidden'); $('logoutBtn').classList.remove('hidden'); await loadAll(); }
  catch (e) { $('loginMsg').textContent = e.message; }
};
$('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
// El código debe tener exactamente 3 letras (A-Z); vacío = se genera solo.
const normCode = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const checkCode = (v) => { const c = String(v || '').trim(); return c === '' || /^[A-Z]{3}$/.test(normCode(c)); };
$('seriesForm').onsubmit = async (e) => { e.preventDefault(); if (!checkCode($('seriesCode').value)) return alert('El código debe tener exactamente 3 letras (A-Z).'); const id = $('seriesId').value; const body = { name: $('seriesName').value, slug: $('seriesSlug').value || undefined, code: $('seriesCode').value || undefined, description: $('seriesDesc').value, active: $('seriesActive').checked }; await api(id ? '/api/admin/series/' + id : '/api/admin/series', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('seriesForm').reset(); $('seriesId').value = ''; $('seriesActive').checked = true; await loadAll(); msg('Serie guardada.'); };
$('seriesCancel').onclick = () => { $('seriesForm').reset(); $('seriesId').value = ''; };
$('cardSeriesFilter').onchange = () => renderCards(1);
$('cardUpload').onchange = async () => {
  const f = $('cardUpload').files[0]; if (!f) return;
  const fd = new FormData(); fd.append('image', f);
  const r = await fetch('/api/admin/upload', { method: 'POST', body: fd });
  const data = await r.json(); if (!r.ok) return alert(data.error || 'No se pudo subir');
  $('cardImage').value = data.url; $('cardPreview').innerHTML = `<img src="${esc(data.url)}" class="preview-img">`;
};
$('cardForm').onsubmit = async (e) => { e.preventDefault(); if (!checkCode($('cardCode').value)) return alert('El código debe tener exactamente 3 letras (A-Z).'); const id = $('cardId').value; const body = { series_id: $('cardSeries').value, name: $('cardName').value, code: $('cardCode').value || undefined, team_or_group: $('cardTeam').value, position_or_role: $('cardPos').value, rarity: $('cardRarity').value, max_copies: parseInt($('cardMax').value, 10), value: parseInt($('cardValue').value, 10), image_url: $('cardImage').value, active: $('cardActive').checked }; await api(id ? '/api/admin/cards/' + id : '/api/admin/cards', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('cardForm').reset(); $('cardId').value = ''; $('cardActive').checked = true; $('cardPreview').innerHTML = ''; await loadAll(); msg('Carta guardada.'); };
$('cardCancel').onclick = () => { $('cardForm').reset(); $('cardId').value = ''; $('cardPreview').innerHTML = ''; };
$('copySearchBtn').onclick = () => renderCopies(1);
$('copySearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderCopies(1); });
$('seedBtn').onclick = async () => { const r = await api('/api/admin/seed', { method: 'POST' }); await loadAll(); msg(r.seeded ? 'Datos de ejemplo cargados.' : 'Ya había datos, no se sembró nada.'); };
$('exportBtn').onclick = async () => { $('exportOut').textContent = JSON.stringify(await api('/api/admin/export'), null, 2); };

// Si ya hay sesión, entrar directo.
fetch('/api/me').then(r => { if (r.ok) { $('loginBox').classList.add('hidden'); $('app').classList.remove('hidden'); $('logoutBtn').classList.remove('hidden'); loadAll(); } }).catch(() => {});
