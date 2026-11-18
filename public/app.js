// app.js — panel cards-admin (vanilla JS, español)
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('Error ' + r.status));
  return data;
}
let series = [], cards = [];

async function loadAll() {
  const st = await api('/api/admin/stats');
  $('stats').innerHTML = ['series', 'cards', 'copies', 'users', 'pending_drops'].map(k =>
    `<div><b>${st[k]}</b>${{ series: 'Series', cards: 'Cartas', copies: 'Copias', users: 'Usuarios', pending_drops: 'Drops pendientes' }[k]}</div>`).join('');
  series = await api('/api/admin/series');
  cards = await api('/api/admin/cards');
  renderSeries(); renderCards(); renderCopies(); renderUsers();
  const opts = series.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  $('cardSeries').innerHTML = opts; $('cardSeriesFilter').innerHTML = '<option value="">Todas</option>' + opts;
}
function renderSeries() {
  $('seriesList').innerHTML = series.map(s => `<div class="item"><div><b>${s.name}</b> <small>/${s.slug} · ${s.active ? 'activa' : 'inactiva'}</small><br><small>${s.description || ''}</small></div><div class="row"><button onclick="editSeries('${s.id}')">Editar</button><button onclick="delSeries('${s.id}')">Borrar</button></div></div>`).join('') || '<p class="muted">No hay series. Crea la primera abajo.</p>';
}
function renderCards() {
  const f = $('cardSeriesFilter').value;
  const list = f ? cards.filter(c => c.series_id === f) : cards;
  $('cardsList').innerHTML = list.map(c => {
    const s = series.find(x => x.id === c.series_id);
    return `<div class="item">${c.image_url ? `<img src="${c.image_url}" alt="">` : ''}<div><b>${c.name}</b> <small>${s ? s.name : ''} · ${c.team_or_group} · ${c.position_or_role}</small><br><small>Rareza: ${c.rarity} · Máx. copias: ${c.max_copies} · Valor: ${c.value} · ${c.active ? 'activa' : 'inactiva'}</small></div><div class="row"><button onclick="editCard('${c.id}')">Editar</button><button onclick="delCard('${c.id}')">Borrar</button></div></div>`;
  }).join('') || '<p class="muted">No hay cartas en esta vista.</p>';
}
async function renderCopies() {
  const q = $('copySearch').value || '';
  const list = await api('/api/admin/copies?search=' + encodeURIComponent(q) + '&limit=100');
  $('copiesList').innerHTML = list.length ? `<table><tr><th>Carta</th><th>Serie</th><th>Usuario</th><th>Fecha</th></tr>${list.map(c => `<tr><td>${c.card_name} <b>${c.serie}</b></td><td>${c.series_name}</td><td>${c.user_phone}</td><td>${new Date(c.claimed_at).toLocaleString()}</td></tr>`).join('')}</table>` : '<p class="muted">Aún no hay copias reclamadas.</p>';
}
async function renderUsers() {
  const users = await api('/api/admin/users');
  $('usersList').innerHTML = users.map(u => `<div class="item"><div><b>${u.display_name || u.phone}</b><br><small>${u.phone} · ${u.copies} carta(s)</small></div><button onclick="showInv('${u.phone}')">Ver inventario</button></div>`).join('') || '<p class="muted">Aún no hay usuarios.</p>';
}
window.showInv = async (phone) => {
  const inv = await api('/api/admin/users/' + encodeURIComponent(phone) + '/inventory');
  $('userInv').innerHTML = `<div class="card"><h3>Inventario de ${phone}</h3>${inv.copies.map(c => `<div>${c.card_name} <b>${c.serie}</b> · ${c.rarity}</div>`).join('') || '<p class="muted">Sin cartas.</p>'}</div>`;
};
window.editSeries = (id) => { const s = series.find(x => x.id === id); $('seriesId').value = s.id; $('seriesName').value = s.name; $('seriesSlug').value = s.slug; $('seriesDesc').value = s.description; $('seriesActive').checked = s.active; $('seriesFormTitle').textContent = 'Editar serie'; window.scrollTo(0, document.getElementById('seriesForm').offsetTop); };
window.delSeries = async (id) => { if (!confirm('¿Borrar esta serie y todas sus cartas y copias?')) return; await api('/api/admin/series/' + id, { method: 'DELETE' }); await loadAll(); };
window.editCard = (id) => { const c = cards.find(x => x.id === id); $('cardId').value = c.id; $('cardSeries').value = c.series_id; $('cardName').value = c.name; $('cardTeam').value = c.team_or_group; $('cardPos').value = c.position_or_role; $('cardRarity').value = c.rarity; $('cardMax').value = c.max_copies; $('cardValue').value = c.value; $('cardImage').value = c.image_url; $('cardActive').checked = c.active; $('cardPreview').innerHTML = c.image_url ? `<img src="${c.image_url}" style="max-width:160px">` : ''; $('cardFormTitle').textContent = 'Editar carta'; window.scrollTo(0, document.getElementById('cardForm').offsetTop); };
window.delCard = async (id) => { if (!confirm('¿Borrar esta carta y sus copias?')) return; await api('/api/admin/cards/' + id, { method: 'DELETE' }); await loadAll(); };

$('loginBtn').onclick = async () => {
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value }) }); $('loginBox').classList.add('hidden'); $('app').classList.remove('hidden'); $('logoutBtn').classList.remove('hidden'); await loadAll(); }
  catch (e) { $('loginMsg').textContent = e.message; }
};
$('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('seriesForm').onsubmit = async (e) => { e.preventDefault(); const id = $('seriesId').value; const body = { name: $('seriesName').value, slug: $('seriesSlug').value || undefined, description: $('seriesDesc').value, active: $('seriesActive').checked }; await api(id ? '/api/admin/series/' + id : '/api/admin/series', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('seriesForm').reset(); $('seriesId').value = ''; $('seriesActive').checked = true; await loadAll(); msg('Serie guardada.'); };
$('seriesCancel').onclick = () => { $('seriesForm').reset(); $('seriesId').value = ''; };
$('cardSeriesFilter').onchange = renderCards;
$('cardUpload').onchange = async () => {
  const f = $('cardUpload').files[0]; if (!f) return;
  const fd = new FormData(); fd.append('image', f);
  const r = await fetch('/api/admin/upload', { method: 'POST', body: fd });
  const data = await r.json(); if (!r.ok) return alert(data.error || 'No se pudo subir');
  $('cardImage').value = data.url; $('cardPreview').innerHTML = `<img src="${data.url}" style="max-width:160px">`;
};
$('cardForm').onsubmit = async (e) => { e.preventDefault(); const id = $('cardId').value; const body = { series_id: $('cardSeries').value, name: $('cardName').value, team_or_group: $('cardTeam').value, position_or_role: $('cardPos').value, rarity: $('cardRarity').value, max_copies: parseInt($('cardMax').value, 10), value: parseInt($('cardValue').value, 10), image_url: $('cardImage').value, active: $('cardActive').checked }; await api(id ? '/api/admin/cards/' + id : '/api/admin/cards', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('cardForm').reset(); $('cardId').value = ''; $('cardActive').checked = true; $('cardPreview').innerHTML = ''; await loadAll(); msg('Carta guardada.'); };
$('cardCancel').onclick = () => { $('cardForm').reset(); $('cardId').value = ''; $('cardPreview').innerHTML = ''; };
$('copySearchBtn').onclick = renderCopies;
$('seedBtn').onclick = async () => { const r = await api('/api/admin/seed', { method: 'POST' }); await loadAll(); msg(r.seeded ? 'Datos de ejemplo cargados.' : 'Ya había datos, no se sembró nada.'); };
$('exportBtn').onclick = async () => { $('exportOut').textContent = JSON.stringify(await api('/api/admin/export'), null, 2); };

// Si ya hay sesión, entrar directo.
fetch('/api/me').then(r => { if (r.ok) { $('loginBox').classList.add('hidden'); $('app').classList.remove('hidden'); $('logoutBtn').classList.remove('hidden'); loadAll(); } }).catch(() => {});
