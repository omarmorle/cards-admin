// server.js — cards-admin (EDOMEXBOT)
// Panel de administración + API pública para n8n.
// Modos: Postgres si DATABASE_URL está definido, si no JSON en DATA_DIR.
// Solo dependencias: express + pg.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const API_KEY = process.env.API_KEY || 'changeme-api-key';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const store = createStore();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---- sesiones admin en memoria (token aleatorio en cookie httpOnly) ----
const sessions = new Set();
function adminAuth(req, res, next) {
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/admin_session=([^;]+)/);
  if (m && sessions.has(m[1])) return next();
  return res.status(401).json({ error: 'No autenticado. Inicia sesión como admin.' });
}
function publicAuth(req, res, next) {
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'Falta o es inválida la cabecera x-api-key.' });
}
function handle(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
}

// ---- salud / info ----
app.get('/api/health', handle(async (req, res) => {
  const stats = await store.stats();
  res.json({ ok: true, mode: store.mode, stats, drop_ttl_minutes: 5 });
}));

// ---- login admin ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
});
app.post('/api/logout', (req, res) => {
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/admin_session=([^;]+)/);
  if (m) sessions.delete(m[1]);
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', adminAuth, (req, res) => res.json({ ok: true, user: ADMIN_USER, mode: store.mode }));

// ---- archivos subidos ----
app.use('/uploads', express.static(UPLOADS_DIR));

// Subida multipart manual (sin dependencias extra). Acepta jpg/png/webp, máx 5 MB.
const ALLOWED_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
app.post('/api/admin/upload', adminAuth, (req, res) => {
  const ct = String(req.headers['content-type'] || '');
  const m = ct.match(/boundary=(.+)$/);
  if (!m) return res.status(400).json({ error: 'Se esperaba multipart/form-data con un campo "image".' });
  const boundary = Buffer.from('--' + m[1].trim());
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 5 * 1024 * 1024 + 1024) { res.status(413).json({ error: 'La imagen supera 5 MB.' }); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    try {
      const buf = Buffer.concat(chunks);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return res.status(400).json({ error: 'No se pudo leer la imagen.' });
      const header = buf.slice(0, headerEnd).toString('utf8');
      const fn = header.match(/filename="([^"]+)"/);
      if (!fn) return res.status(400).json({ error: 'Falta el archivo (campo "image").' });
      const ext = path.extname(fn[1]).toLowerCase().replace('.', '');
      if (!ALLOWED_EXT[ext]) return res.status(400).json({ error: 'Solo jpg, png o webp.' });
      const bodyStart = headerEnd + 4;
      let bodyEnd = buf.indexOf(boundary, bodyStart);
      if (bodyEnd < 0) bodyEnd = buf.length;
      // quita el \r\n previo al boundary
      if (buf[bodyEnd - 2] === 13 && buf[bodyEnd - 1] === 10) bodyEnd -= 2;
      const fileBuf = buf.slice(bodyStart, bodyEnd);
      if (!fileBuf.length) return res.status(400).json({ error: 'El archivo llegó vacío.' });
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, name), fileBuf);
      return res.json({ ok: true, url: `/uploads/${name}` });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });
});

// ---- API admin ----
app.get('/api/admin/stats', adminAuth, handle(async (req, res) => res.json(await store.stats())));
app.get('/api/admin/series', adminAuth, handle(async (req, res) => res.json(await store.listSeries())));
app.post('/api/admin/series', adminAuth, handle(async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'Falta el nombre de la serie.' });
  res.status(201).json(await store.createSeries(req.body));
}));
app.put('/api/admin/series/:id', adminAuth, handle(async (req, res) => {
  const s = await store.updateSeries(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: 'Serie no encontrada.' });
  res.json(s);
}));
app.delete('/api/admin/series/:id', adminAuth, handle(async (req, res) => { await store.deleteSeries(req.params.id); res.json({ ok: true }); }));

app.get('/api/admin/cards', adminAuth, handle(async (req, res) => res.json(await store.listCards(req.query))));
app.post('/api/admin/cards', adminAuth, handle(async (req, res) => {
  if (!req.body?.name || !req.body?.series_id) return res.status(400).json({ error: 'Faltan nombre y serie.' });
  res.status(201).json(await store.createCard(req.body));
}));
app.put('/api/admin/cards/:id', adminAuth, handle(async (req, res) => {
  const c = await store.updateCard(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'Carta no encontrada.' });
  res.json(c);
}));
app.delete('/api/admin/cards/:id', adminAuth, handle(async (req, res) => { await store.deleteCard(req.params.id); res.json({ ok: true }); }));

app.get('/api/admin/copies', adminAuth, handle(async (req, res) => res.json(await store.listCopies(req.query))));
app.get('/api/admin/users', adminAuth, handle(async (req, res) => res.json(await store.listUsers())));
app.get('/api/admin/users/:phone/inventory', adminAuth, handle(async (req, res) => res.json(await store.getUserInventory(req.params.phone))));
app.post('/api/admin/seed', adminAuth, handle(async (req, res) => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
  res.json(await store.seedIfEmpty(seed));
}));
app.get('/api/admin/export', adminAuth, handle(async (req, res) => res.json(await store.exportCatalog())));

// ---- API pública (n8n, con x-api-key) ----
app.get('/api/public/series', publicAuth, handle(async (req, res) => {
  const all = await store.listSeries();
  res.json(all.filter(s => s.active));
}));
app.get('/api/public/cards', publicAuth, handle(async (req, res) => res.json(await store.listCards({ ...req.query, activeOnly: true }))));
app.post('/api/public/roll', publicAuth, handle(async (req, res) => {
  const { series_id, group_jid, rolled_by_phone } = req.body || {};
  const out = await store.roll({ series_id, group_jid, rolled_by_phone });
  res.json({ drop_id: out.drop.id, card: out.card, serie: `${out.drop.serial_n}/${out.drop.serial_m}`, text: out.text, expires_at: out.drop.expires_at });
}));
app.post('/api/public/claim', publicAuth, handle(async (req, res) => {
  const { drop_id, phone, display_name } = req.body || {};
  if (!drop_id || !phone) return res.status(400).json({ error: 'Faltan drop_id y phone.' });
  const out = await store.claim({ drop_id, phone, display_name });
  res.json({ copy: out.copy, card: out.card, serie: out.copy.serie || `${out.copy.serial_n}/${out.copy.serial_m}` });
}));
app.get('/api/public/inventory', publicAuth, handle(async (req, res) => {
  if (!req.query.phone) return res.status(400).json({ error: 'Falta ?phone=.' });
  res.json(await store.getUserInventory(String(req.query.phone)));
}));

// ---- frontend estático ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- errores ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
});

(async () => {
  try {
    await store.init();
    // Siembra automática solo si está vacío (primera vez).
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    const r = await store.seedIfEmpty(seed);
    if (r.seeded) console.log('Seed inicial cargado (Liga MX + Luchadores de México).');
  } catch (e) { console.error('No se pudo inicializar el almacenamiento:', e.message); }
  if (ADMIN_PASSWORD === 'changeme' || API_KEY === 'changeme-api-key') {
    console.warn('AVISO: cambia ADMIN_PASSWORD y API_KEY en producción (ver .env.example).');
  }
  app.listen(PORT, () => console.log(`cards-admin en puerto ${PORT} — modo ${store.mode} — DATA_DIR=${DATA_DIR}`));
})();
