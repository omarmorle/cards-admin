// store.js — abstracción de almacenamiento para cards-admin.
// Misma API en los dos modos:
//   - DATABASE_URL definido  -> Postgres (pg)
//   - DATABASE_URL vacío     -> JSON en <DATA_DIR>/cards-data.json
// Regla Serie n/m: al sortear se reserva serial_n = copias emitidas
// (copias + drops pendientes no vencidos) + 1. Si n > m, la carta
// ya no se puede sortear. El !claim solo asigna la copia reservada.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RARITIES = ['Común', 'Raro', 'Épico', 'Legendario'];
const BASE_WEIGHTS = { 'Común': 50, 'Raro': 33, 'Épico': 15, 'Legendario': 2 };
const DROP_TTL_MS = 5 * 60 * 1000; // un drop vive 5 minutos para reclamarlo

function uid() { return crypto.randomUUID(); }
function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || uid().slice(0, 8);
}
function rollText(card, n, m) {
  return `🎴 ¡Te salió! ${card.name} - ${card.team_or_group} | Rareza: ${card.rarity} | Serie: ${n}/${m} — escribe !claim para reclamarla`;
}
function pickWeighted(raritiesPresent) {
  // Renormaliza los pesos base sobre las rarezas que sí tienen cartas disponibles.
  const total = raritiesPresent.reduce((a, r) => a + (BASE_WEIGHTS[r] || 0), 0);
  let x = Math.random() * total;
  for (const r of raritiesPresent) { x -= BASE_WEIGHTS[r] || 0; if (x <= 0) return r; }
  return raritiesPresent[raritiesPresent.length - 1];
}

class BaseStore {
  async expireDrops() { /* implementado en cada modo */ }
  async issuedCount(cardId) { throw new Error('not implemented'); }
  async roll({ series_id, group_jid, rolled_by_phone }) {
    await this.expireDrops();
    const cards = await this.listCards({ series_id, activeOnly: true });
    const available = [];
    for (const c of cards) {
      const issued = await this.issuedCount(c.id);
      if (issued < c.max_copies) available.push(c);
    }
    if (!available.length) {
      const e = new Error('No hay cartas disponibles para sortear en esa serie (todas agotaron sus copias o no hay cartas activas).');
      e.status = 409; throw e;
    }
    const present = [...new Set(available.map(c => c.rarity))];
    const rarity = pickWeighted(present);
    const pool = available.filter(c => c.rarity === rarity);
    const card = pool[Math.floor(Math.random() * pool.length)];
    const n = (await this.issuedCount(card.id)) + 1;
    const now = new Date();
    const drop = {
      id: uid(), card_id: card.id, serial_n: n, serial_m: card.max_copies,
      group_jid: group_jid || '', rolled_by_phone: rolled_by_phone || '',
      status: 'pending', created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + DROP_TTL_MS).toISOString(),
    };
    await this._saveDrop(drop);
    return { drop, card, text: rollText(card, n, card.max_copies) };
  }
}

// ------------------------- JSON (archivo) -------------------------
class JsonStore extends BaseStore {
  constructor(dataDir) {
    super();
    this.mode = 'json';
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'cards-data.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { series: [], cards: [], users: [], copies: [], drops: [], transactions: [] };
  }
  _save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  async init() { /* nada que crear */ }
  async expireDrops() {
    const now = new Date();
    let changed = false;
    for (const d of this.data.drops) {
      if (d.status === 'pending' && new Date(d.expires_at) <= now) { d.status = 'expired'; changed = true; }
    }
    if (changed) this._save();
  }
  async issuedCount(cardId) {
    const copies = this.data.copies.filter(c => c.card_id === cardId).length;
    const pending = this.data.drops.filter(d => d.card_id === cardId && d.status === 'pending').length;
    return copies + pending;
  }
  async _saveDrop(drop) { this.data.drops.push(drop); this._save(); }
  async stats() {
    return {
      series: this.data.series.length,
      cards: this.data.cards.length,
      copies: this.data.copies.length,
      users: this.data.users.length,
      pending_drops: this.data.drops.filter(d => d.status === 'pending').length,
    };
  }
  async listSeries() { return [...this.data.series].sort((a, b) => a.name.localeCompare(b.name)); }
  async getSeries(id) { return this.data.series.find(s => s.id === id) || null; }
  async createSeries(d) {
    const s = { id: uid(), name: d.name, slug: d.slug || slugify(d.name), description: d.description || '', active: d.active !== false, created_at: new Date().toISOString() };
    if (this.data.series.some(x => x.slug === s.slug)) { const e = new Error('Ya existe una serie con ese slug.'); e.status = 400; throw e; }
    this.data.series.push(s); this._save(); return s;
  }
  async updateSeries(id, d) {
    const s = await this.getSeries(id); if (!s) return null;
    Object.assign(s, { name: d.name ?? s.name, slug: d.slug ?? s.slug, description: d.description ?? s.description, active: d.active ?? s.active });
    this._save(); return s;
  }
  async deleteSeries(id) {
    this.data.series = this.data.series.filter(s => s.id !== id);
    const cardIds = this.data.cards.filter(c => c.series_id === id).map(c => c.id);
    this.data.cards = this.data.cards.filter(c => c.series_id !== id);
    this.data.copies = this.data.copies.filter(c => !cardIds.includes(c.card_id));
    this.data.drops = this.data.drops.filter(d => !cardIds.includes(d.card_id));
    this._save(); return true;
  }
  async listCards({ series_id, rarity, activeOnly } = {}) {
    let out = [...this.data.cards];
    if (series_id) out = out.filter(c => c.series_id === series_id);
    if (rarity) out = out.filter(c => c.rarity === rarity);
    if (activeOnly) out = out.filter(c => c.active);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async getCard(id) { return this.data.cards.find(c => c.id === id) || null; }
  async createCard(d) {
    if (!this.data.series.some(s => s.id === d.series_id)) { const e = new Error('La serie no existe.'); e.status = 400; throw e; }
    if (!RARITIES.includes(d.rarity)) { const e = new Error('Rareza inválida. Usa Común, Raro, Épico o Legendario.'); e.status = 400; throw e; }
    const c = { id: uid(), series_id: d.series_id, name: d.name, team_or_group: d.team_or_group || '', position_or_role: d.position_or_role || '', rarity: d.rarity, max_copies: Math.max(1, parseInt(d.max_copies, 10) || 100), image_url: d.image_url || '', value: parseInt(d.value, 10) || 0, active: d.active !== false, created_at: new Date().toISOString() };
    this.data.cards.push(c); this._save(); return c;
  }
  async updateCard(id, d) {
    const c = await this.getCard(id); if (!c) return null;
    Object.assign(c, { name: d.name ?? c.name, team_or_group: d.team_or_group ?? c.team_or_group, position_or_role: d.position_or_role ?? c.position_or_role, rarity: d.rarity ?? c.rarity, max_copies: d.max_copies ? Math.max(1, parseInt(d.max_copies, 10)) : c.max_copies, image_url: d.image_url ?? c.image_url, value: d.value !== undefined ? parseInt(d.value, 10) || 0 : c.value, active: d.active ?? c.active });
    if (d.series_id) c.series_id = d.series_id;
    this._save(); return c;
  }
  async deleteCard(id) {
    this.data.cards = this.data.cards.filter(c => c.id !== id);
    this.data.copies = this.data.copies.filter(c => c.card_id !== id);
    this.data.drops = this.data.drops.filter(d => d.card_id !== id);
    this._save(); return true;
  }
  _enrichCopy(cp) {
    const card = this.data.cards.find(c => c.id === cp.card_id) || {};
    const series = this.data.series.find(s => s.id === card.series_id) || {};
    return { ...cp, card_name: card.name || '', series_name: series.name || '', series_id: card.series_id || '', team_or_group: card.team_or_group || '', rarity: card.rarity || '', image_url: card.image_url || '', serie: `${cp.serial_n}/${cp.serial_m}` };
  }
  async listCopies({ series_id, card_id, user_phone, search, limit = 200 } = {}) {
    let out = this.data.copies.map(c => this._enrichCopy(c));
    if (card_id) out = out.filter(c => c.card_id === card_id);
    if (series_id) out = out.filter(c => c.series_id === series_id);
    if (user_phone) out = out.filter(c => c.user_phone === user_phone);
    if (search) { const q = search.toLowerCase(); out = out.filter(c => (c.card_name + ' ' + c.user_phone + ' ' + c.series_name).toLowerCase().includes(q)); }
    return out.slice(-limit).reverse();
  }
  async listUsers() {
    return this.data.users.map(u => ({ ...u, copies: this.data.copies.filter(c => c.user_phone === u.phone).length }));
  }
  async getUserInventory(phone) {
    const user = this.data.users.find(u => u.phone === phone) || null;
    const copies = await this.listCopies({ user_phone: phone, limit: 500 });
    return { user, copies };
  }
  async claim({ drop_id, phone, display_name }) {
    await this.expireDrops();
    // Proceso único de Node: esta comprobación + inserción es atómica
    // dentro del mismo tick; no hay dos claims a la vez en este modo.
    const drop = this.data.drops.find(d => d.id === drop_id);
    if (!drop) { const e = new Error('Ese drop no existe.'); e.status = 404; throw e; }
    if (drop.status !== 'pending') { const e = new Error('Esa carta ya fue reclamada o venció.'); e.status = 409; throw e; }
    const card = await this.getCard(drop.card_id);
    if (!card) { const e = new Error('La carta del drop ya no existe.'); e.status = 404; throw e; }
    if (drop.serial_n > card.max_copies) { const e = new Error('Esa carta ya agotó sus copias.'); e.status = 409; throw e; }
    if (this.data.copies.some(c => c.card_id === card.id && c.serial_n === drop.serial_n)) {
      const e = new Error('Ese número de serie ya fue asignado.'); e.status = 409; throw e;
    }
    if (!this.data.users.some(u => u.phone === phone)) {
      this.data.users.push({ phone, display_name: display_name || '', created_at: new Date().toISOString() });
    }
    const copy = { id: uid(), card_id: card.id, user_phone: phone, serial_n: drop.serial_n, serial_m: drop.serial_m, status: 'owned', claimed_at: new Date().toISOString() };
    this.data.copies.push(copy);
    drop.status = 'claimed';
    this.data.transactions.push({ id: uid(), type: 'claim', copy_id: copy.id, from_phone: '', to_phone: phone, created_at: new Date().toISOString() });
    this._save();
    return { copy: this._enrichCopy(copy), card };
  }
  async seedIfEmpty(seed) {
    if (this.data.series.length) return { seeded: false };
    for (const s of seed.series) await this.createSeries(s);
    const bySlug = Object.fromEntries(this.data.series.map(s => [s.slug, s.id]));
    for (const c of seed.cards) await this.createCard({ ...c, series_id: bySlug[c.series_slug] });
    return { seeded: true };
  }
  async exportCatalog() {
    return { series: await this.listSeries(), cards: await this.listCards({}) };
  }
}

// ------------------------- Postgres -------------------------
class PgStore extends BaseStore {
  constructor(databaseUrl) {
    super();
    this.mode = 'postgres';
    // pg se importa aquí para que el modo JSON no lo necesite.
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString: databaseUrl });
  }
  async init() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await this.pool.query(schema);
  }
  async expireDrops() {
    await this.pool.query(`UPDATE drops SET status='expired' WHERE status='pending' AND expires_at <= NOW()`);
  }
  async issuedCount(cardId) {
    const copies = await this.pool.query('SELECT COUNT(*)::int AS n FROM copies WHERE card_id=$1', [cardId]);
    const pending = await this.pool.query(`SELECT COUNT(*)::int AS n FROM drops WHERE card_id=$1 AND status='pending' AND expires_at > NOW()`, [cardId]);
    return copies.rows[0].n + pending.rows[0].n;
  }
  async _saveDrop(drop) {
    await this.pool.query(
      `INSERT INTO drops(id, card_id, serial_n, serial_m, group_jid, rolled_by_phone, status, created_at, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
      [drop.id, drop.card_id, drop.serial_n, drop.serial_m, drop.group_jid, drop.rolled_by_phone, drop.created_at, drop.expires_at]);
  }
  async stats() {
    const q = async (sql) => (await this.pool.query(sql)).rows[0].n;
    return {
      series: await q('SELECT COUNT(*)::int AS n FROM series'),
      cards: await q('SELECT COUNT(*)::int AS n FROM cards'),
      copies: await q('SELECT COUNT(*)::int AS n FROM copies'),
      users: await q('SELECT COUNT(*)::int AS n FROM users'),
      pending_drops: await q(`SELECT COUNT(*)::int AS n FROM drops WHERE status='pending' AND expires_at > NOW()`),
    };
  }
  async listSeries() { return (await this.pool.query('SELECT * FROM series ORDER BY name')).rows; }
  async getSeries(id) { return (await this.pool.query('SELECT * FROM series WHERE id=$1', [id])).rows[0] || null; }
  async createSeries(d) {
    const s = { id: uid(), name: d.name, slug: d.slug || slugify(d.name), description: d.description || '', active: d.active !== false };
    try {
      const r = await this.pool.query('INSERT INTO series(id,name,slug,description,active) VALUES($1,$2,$3,$4,$5) RETURNING *', [s.id, s.name, s.slug, s.description, s.active]);
      return r.rows[0];
    } catch (e) { if (e.code === '23505') { const err = new Error('Ya existe una serie con ese slug.'); err.status = 400; throw err; } throw e; }
  }
  async updateSeries(id, d) {
    const cur = await this.getSeries(id); if (!cur) return null;
    const r = await this.pool.query(
      'UPDATE series SET name=$2, slug=$3, description=$4, active=$5 WHERE id=$1 RETURNING *',
      [id, d.name ?? cur.name, d.slug ?? cur.slug, d.description ?? cur.description, d.active ?? cur.active]);
    return r.rows[0];
  }
  async deleteSeries(id) { await this.pool.query('DELETE FROM series WHERE id=$1', [id]); return true; }
  async listCards({ series_id, rarity, activeOnly } = {}) {
    const where = [], params = [];
    if (series_id) { params.push(series_id); where.push(`series_id=$${params.length}`); }
    if (rarity) { params.push(rarity); where.push(`rarity=$${params.length}`); }
    if (activeOnly) where.push('active=TRUE');
    const sql = 'SELECT * FROM cards' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY name';
    return (await this.pool.query(sql, params)).rows;
  }
  async getCard(id) { return (await this.pool.query('SELECT * FROM cards WHERE id=$1', [id])).rows[0] || null; }
  async createCard(d) {
    if (!RARITIES.includes(d.rarity)) { const e = new Error('Rareza inválida. Usa Común, Raro, Épico o Legendario.'); e.status = 400; throw e; }
    const c = { id: uid(), series_id: d.series_id, name: d.name, team_or_group: d.team_or_group || '', position_or_role: d.position_or_role || '', rarity: d.rarity, max_copies: Math.max(1, parseInt(d.max_copies, 10) || 100), image_url: d.image_url || '', value: parseInt(d.value, 10) || 0, active: d.active !== false };
    try {
      const r = await this.pool.query(
        `INSERT INTO cards(id,series_id,name,team_or_group,position_or_role,rarity,max_copies,image_url,value,active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [c.id, c.series_id, c.name, c.team_or_group, c.position_or_role, c.rarity, c.max_copies, c.image_url, c.value, c.active]);
      return r.rows[0];
    } catch (e) { if (e.code === '23503') { const err = new Error('La serie no existe.'); err.status = 400; throw err; } throw e; }
  }
  async updateCard(id, d) {
    const cur = await this.getCard(id); if (!cur) return null;
    const r = await this.pool.query(
      `UPDATE cards SET series_id=$2, name=$3, team_or_group=$4, position_or_role=$5, rarity=$6,
       max_copies=$7, image_url=$8, value=$9, active=$10 WHERE id=$1 RETURNING *`,
      [id, d.series_id ?? cur.series_id, d.name ?? cur.name, d.team_or_group ?? cur.team_or_group,
       d.position_or_role ?? cur.position_or_role, d.rarity ?? cur.rarity,
       d.max_copies ? Math.max(1, parseInt(d.max_copies, 10)) : cur.max_copies,
       d.image_url ?? cur.image_url, d.value !== undefined ? parseInt(d.value, 10) || 0 : cur.value, d.active ?? cur.active]);
    return r.rows[0];
  }
  async deleteCard(id) { await this.pool.query('DELETE FROM cards WHERE id=$1', [id]); return true; }
  async listCopies({ series_id, card_id, user_phone, search, limit = 200 } = {}) {
    const where = [], params = [];
    if (card_id) { params.push(card_id); where.push(`cp.card_id=$${params.length}`); }
    if (series_id) { params.push(series_id); where.push(`c.series_id=$${params.length}`); }
    if (user_phone) { params.push(user_phone); where.push(`cp.user_phone=$${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`(c.name ILIKE $${params.length} OR cp.user_phone ILIKE $${params.length} OR s.name ILIKE $${params.length})`); }
    params.push(limit);
    const sql = `SELECT cp.*, c.name AS card_name, c.series_id, c.team_or_group, c.rarity, c.image_url, s.name AS series_name,
                 (cp.serial_n || '/' || cp.serial_m) AS serie
                 FROM copies cp JOIN cards c ON c.id=cp.card_id JOIN series s ON s.id=c.series_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY cp.claimed_at DESC LIMIT $${params.length}`;
    return (await this.pool.query(sql, params)).rows;
  }
  async listUsers() {
    return (await this.pool.query(
      `SELECT u.*, (SELECT COUNT(*)::int FROM copies cp WHERE cp.user_phone=u.phone) AS copies FROM users u ORDER BY u.created_at DESC`)).rows;
  }
  async getUserInventory(phone) {
    const user = (await this.pool.query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0] || null;
    const copies = await this.listCopies({ user_phone: phone, limit: 500 });
    return { user, copies };
  }
  async claim({ drop_id, phone, display_name }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const dr = await client.query('SELECT * FROM drops WHERE id=$1 FOR UPDATE', [drop_id]);
      const drop = dr.rows[0];
      if (!drop) { const e = new Error('Ese drop no existe.'); e.status = 404; throw e; }
      if (drop.status !== 'pending' || new Date(drop.expires_at) <= new Date()) {
        await client.query(`UPDATE drops SET status='expired' WHERE id=$1 AND status='pending'`, [drop_id]);
        await client.query('COMMIT');
        const e = new Error('Esa carta ya fue reclamada o venció.'); e.status = 409; throw e;
      }
      const card = (await client.query('SELECT * FROM cards WHERE id=$1', [drop.card_id])).rows[0];
      if (!card) { const e = new Error('La carta del drop ya no existe.'); e.status = 404; throw e; }
      await client.query('INSERT INTO users(phone, display_name) VALUES($1,$2) ON CONFLICT (phone) DO NOTHING', [phone, display_name || '']);
      const copyId = uid();
      const cr = await client.query(
        `INSERT INTO copies(id, card_id, user_phone, serial_n, serial_m, status)
         VALUES($1,$2,$3,$4,$5,'owned') RETURNING *`,
        [copyId, card.id, phone, drop.serial_n, drop.serial_m]);
      await client.query(`UPDATE drops SET status='claimed' WHERE id=$1`, [drop_id]);
      await client.query(`INSERT INTO transactions(id, type, copy_id, from_phone, to_phone) VALUES($1,'claim',$2,'',$3)`, [uid(), copyId, phone]);
      await client.query('COMMIT');
      const copy = cr.rows[0];
      return { copy: { ...copy, card_name: card.name, series_name: '', team_or_group: card.team_or_group, rarity: card.rarity, image_url: card.image_url, serie: `${copy.serial_n}/${copy.serial_m}` }, card };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (e.code === '23505') { const err = new Error('Ese número de serie ya fue asignado.'); err.status = 409; throw err; }
      if (e.status) throw e;
      throw e;
    } finally { client.release(); }
  }
  async seedIfEmpty(seed) {
    const n = (await this.pool.query('SELECT COUNT(*)::int AS n FROM series')).rows[0].n;
    if (n) return { seeded: false };
    for (const s of seed.series) await this.createSeries(s);
    const all = await this.listSeries();
    const bySlug = Object.fromEntries(all.map(s => [s.slug, s.id]));
    for (const c of seed.cards) await this.createCard({ ...c, series_id: bySlug[c.series_slug] });
    return { seeded: true };
  }
  async exportCatalog() {
    return { series: await this.listSeries(), cards: await this.listCards({}) };
  }
}

function createStore() {
  const dataDir = process.env.DATA_DIR || '/data';
  if (process.env.DATABASE_URL) return new PgStore(process.env.DATABASE_URL);
  return new JsonStore(dataDir);
}

module.exports = { createStore, RARITIES, BASE_WEIGHTS, DROP_TTL_MS, rollText };
