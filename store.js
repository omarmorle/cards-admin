// store.js — abstracción de almacenamiento para cards-admin.
// Misma API en los dos modos:
//   - DATABASE_URL definido  -> Postgres (pg)
//   - DATABASE_URL vacío     -> JSON en <DATA_DIR>/cards-data.json
// Regla Serie n/m: al sortear se reserva un serial_n AL AZAR entre los
// libres de esa carta (de 1 a max_copies, sin repetir copias existentes
// ni drops pendientes no vencidos). Si no quedan libres, la carta ya no
// se puede sortear. El !claim solo asigna la copia reservada.
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
// ---- códigos cortos (serie/carta/copia) ----
// El código de una copia es la concatenación, sin separadores ni ceros:
//   {series_code:3 letras}{card_code:3 letras}{global_n}{serial_n}
//   ej. LMXVEG423, PRUMUS11, LMXCAN711
// El global_n es un consecutivo de TODAS las series: cada copia emitida
// en todo el juego lleva el siguiente número global (1, 2, 3...), nunca
// se reutiliza, ni aunque la copia se deseche o el drop venza.
// El código SE GUARDA en la BD (copies.code y drops.code) al crear el
// registro. No lleva UNIQUE: sin separadores ni ceros dos copias
// distintas podrían en teoría producir el mismo string corto (ej. global
// 42/n 3 vs global 4/n 23); la identidad verdadera sigue siendo
// global_n (único) + el índice único (card_id, serial_n). El código es
// la forma corta de mostrarla y buscarla; al buscar por código, si hay
// más de una coincidencia se queda la de mayor serial_n.
function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeCode(s) {
  return stripAccents(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// Valida que un código tenga EXACTAMENTE 3 letras A-Z. Vacío → null
// (el llamador genera uno automático). Cualquier otra cosa → error 400.
function resolveCode(given, generated, label) {
  if (given === undefined || String(given).trim() === '') return generated;
  const code = normalizeCode(given);
  if (!/^[A-Z]{3}$/.test(code)) {
    const e = new Error(`El código ${label} debe tener exactamente 3 letras (A-Z).`);
    e.status = 400; throw e;
  }
  return code;
}
// Serie: iniciales de las palabras; las siglas en mayúsculas aportan
// todas sus letras; si es una sola palabra, sus 3 primeras letras; si
// faltan letras se rellena con X; se trunca a 3.
// "Liga MX" → LMX, "Pruebas" → PRU, "Luchadores de México" → LDM.
function genSeriesCode(name) {
  const words = stripAccents(name).split(/[^A-Za-z0-9]+/).filter(w => w && !/^\d+$/.test(w));
  if (!words.length) return 'XXX';
  if (words.length === 1) return (words[0].toUpperCase() + 'XX').slice(0, 3);
  let code = '';
  for (const w of words) {
    if (/^[A-Z]+$/.test(w) && w.length <= 3) code += w.toUpperCase();
    else code += w[0].toUpperCase();
    if (code.length >= 3) break;
  }
  return (code + 'XXX').slice(0, 3);
}
// Carta: primeras 3 letras de la última palabra del nombre; si la
// palabra tiene menos de 3 letras, se rellena con X.
// "Alexis Vega" → VEG, "Omar Moreno" → MOR, "Muse" → MUS.
function genCardCode(name) {
  const words = stripAccents(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const last = words[words.length - 1] || 'CAR';
  return (last.toUpperCase() + 'XX').slice(0, 3);
}
function buildCopyCode(seriesCode, cardCode, globalN, serialN) {
  return `${seriesCode || ''}${cardCode || ''}${globalN}${serialN}`;
}
// Series/cartas viejas pueden tener code NULL: se deriva del nombre.
function fallbackSeriesCode(series) { return (series && series.code) || genSeriesCode((series && series.name) || ''); }
function fallbackCardCode(card) { return (card && card.code) || genCardCode((card && card.name) || ''); }
function rollText(card, n, m, code) {
  return `🎴 ¡Te salió! ${card.name} - ${card.team_or_group} | Rareza: ${card.rarity} | Serie: ${n}/${m} | Código: ${code} — escribe !claim para reclamarla`;
}
function pickWeighted(raritiesPresent) {
  // Renormaliza los pesos base sobre las rarezas que sí tienen cartas disponibles.
  const total = raritiesPresent.reduce((a, r) => a + (BASE_WEIGHTS[r] || 0), 0);
  let x = Math.random() * total;
  for (const r of raritiesPresent) { x -= BASE_WEIGHTS[r] || 0; if (x <= 0) return r; }
  return raritiesPresent[raritiesPresent.length - 1];
}

// ---- paginación ----
// Si la consulta trae page o limit, se devuelve { items, page, limit, total, pages }.
// Sin ellos se devuelve el arreglo completo (compatibilidad: el sorteo y la
// API pública siguen recibiendo arreglos).
function pageParams(q = {}) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}
function pageWanted(q = {}) { return q.page !== undefined || q.limit !== undefined; }
function pageResult(items, total, { page, limit }) {
  return { items, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}
function paginateArray(all, q) {
  if (!pageWanted(q)) return all;
  const p = pageParams(q);
  return pageResult(all.slice(p.offset, p.offset + p.limit), all.length, p);
}

class BaseStore {
  async expireDrops() { /* implementado en cada modo */ }
  async issuedCount(cardId) { throw new Error('not implemented'); }
  // Seriales ocupados de una carta: copias existentes + drops pendientes
  // no vencidos. Los drops vencidos ya liberaron su serial (expireDrops).
  async usedSerials(cardId) { throw new Error('not implemented'); }
  // Reserva el siguiente número del consecutivo global (1, 2, 3... en
  // todo el juego). Nunca se reutiliza: si el drop vence, ese número
  // queda quemado (con hueco).
  async _reserveGlobal() { throw new Error('not implemented'); }
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
    // Serial AL AZAR entre los libres (1..max_copies, sin los ocupados).
    // Si dos rolls simultáneos eligieran el mismo libre, el claim del
    // segundo fallaría con 409 por el índice único (card_id, serial_n).
    const used = await this.usedSerials(card.id);
    const free = [];
    for (let i = 1; i <= card.max_copies; i++) if (!used.has(i)) free.push(i);
    if (!free.length) {
      const e = new Error('Esa carta acaba de agotar sus copias.');
      e.status = 409; throw e;
    }
    const n = free[Math.floor(Math.random() * free.length)];
    // El global_n se reserva DESPUÉS de saber que hay serial libre,
    // para no quemar un número en un roll que va a fallar.
    const globalN = await this._reserveGlobal();
    const series = await this.getSeries(card.series_id);
    const code = buildCopyCode(fallbackSeriesCode(series), fallbackCardCode(card), globalN, n);
    const now = new Date();
    const drop = {
      id: uid(), card_id: card.id, serial_n: n, serial_m: card.max_copies, global_n: globalN, code,
      group_jid: group_jid || '', rolled_by_phone: rolled_by_phone || '',
      status: 'pending', created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + DROP_TTL_MS).toISOString(),
    };
    await this._saveDrop(drop);
    return { drop, card, text: rollText(card, n, card.max_copies, code), code, global_n: globalN };
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
      : { series: [], cards: [], users: [], copies: [], drops: [], transactions: [], next_global_n: 1 };
    if (this.data.next_global_n === undefined) this.data.next_global_n = 1;
  }
  _save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  async init() { /* nada que crear */ }
  async _reserveGlobal() {
    const n = this.data.next_global_n || 1;
    this.data.next_global_n = n + 1;
    return n;
  }
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
  async usedSerials(cardId) {
    const used = new Set();
    for (const c of this.data.copies) if (c.card_id === cardId) used.add(c.serial_n);
    for (const d of this.data.drops) if (d.card_id === cardId && d.status === 'pending') used.add(d.serial_n);
    return used;
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
    const code = resolveCode(d.code, genSeriesCode(d.name), 'de la serie');
    if (this.data.series.some(x => (x.code || '') === code)) { const e = new Error('Ya existe una serie con ese código.'); e.status = 400; throw e; }
    const s = { id: uid(), name: d.name, slug: d.slug || slugify(d.name), code, description: d.description || '', active: d.active !== false, created_at: new Date().toISOString() };
    if (this.data.series.some(x => x.slug === s.slug)) { const e = new Error('Ya existe una serie con ese slug.'); e.status = 400; throw e; }
    this.data.series.push(s); this._save(); return s;
  }
  async updateSeries(id, d) {
    const s = await this.getSeries(id); if (!s) return null;
    if (d.code !== undefined) {
      const code = resolveCode(d.code, genSeriesCode(d.name ?? s.name), 'de la serie');
      if (this.data.series.some(x => x.id !== id && (x.code || '') === code)) { const e = new Error('Ya existe una serie con ese código.'); e.status = 400; throw e; }
      s.code = code;
    }
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
  async listCards({ series_id, rarity, activeOnly, page, limit } = {}) {
    let out = [...this.data.cards];
    if (series_id) out = out.filter(c => c.series_id === series_id);
    if (rarity) out = out.filter(c => c.rarity === rarity);
    if (activeOnly) out = out.filter(c => c.active);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return paginateArray(out, { page, limit });
  }
  async getCard(id) { return this.data.cards.find(c => c.id === id) || null; }
  async createCard(d) {
    if (!this.data.series.some(s => s.id === d.series_id)) { const e = new Error('La serie no existe.'); e.status = 400; throw e; }
    if (!RARITIES.includes(d.rarity)) { const e = new Error('Rareza inválida. Usa Común, Raro, Épico o Legendario.'); e.status = 400; throw e; }
    const code = resolveCode(d.code, genCardCode(d.name), 'de la carta');
    if (this.data.cards.some(x => x.series_id === d.series_id && (x.code || '') === code)) { const e = new Error('Ya existe una carta con ese código en esta serie.'); e.status = 400; throw e; }
    const c = { id: uid(), series_id: d.series_id, name: d.name, code, team_or_group: d.team_or_group || '', position_or_role: d.position_or_role || '', rarity: d.rarity, max_copies: Math.max(1, parseInt(d.max_copies, 10) || 100), image_url: d.image_url || '', value: parseInt(d.value, 10) || 0, active: d.active !== false, created_at: new Date().toISOString() };
    this.data.cards.push(c); this._save(); return c;
  }
  async updateCard(id, d) {
    const c = await this.getCard(id); if (!c) return null;
    const targetSeries = d.series_id || c.series_id;
    if (d.code !== undefined) {
      const code = resolveCode(d.code, genCardCode(d.name ?? c.name), 'de la carta');
      if (this.data.cards.some(x => x.id !== id && x.series_id === targetSeries && (x.code || '') === code)) { const e = new Error('Ya existe una carta con ese código en esta serie.'); e.status = 400; throw e; }
      c.code = code;
    }
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
    // El código se guarda en la copia al reclamarla; si falta (copia
    // vieja), se calcula igual con fallback desde los nombres.
    const code = cp.code || (cp.global_n != null
      ? buildCopyCode(fallbackSeriesCode(series), fallbackCardCode(card), cp.global_n, cp.serial_n)
      : '');
    return { ...cp, card_name: card.name || '', series_name: series.name || '', series_id: card.series_id || '', team_or_group: card.team_or_group || '', rarity: card.rarity || '', image_url: card.image_url || '', serie: `${cp.serial_n}/${cp.serial_m}`, code };
  }
  async listCopies({ series_id, card_id, user_phone, search, limit = 200, page } = {}) {
    let out = this.data.copies.map(c => this._enrichCopy(c));
    if (card_id) out = out.filter(c => c.card_id === card_id);
    if (series_id) out = out.filter(c => c.series_id === series_id);
    if (user_phone) out = out.filter(c => c.user_phone === user_phone);
    if (search) { const q = search.toLowerCase(); out = out.filter(c => (c.card_name + ' ' + c.code + ' ' + c.user_phone + ' ' + c.series_name).toLowerCase().includes(q)); }
    out.sort((a, b) => new Date(b.claimed_at) - new Date(a.claimed_at));
    if (page !== undefined) return paginateArray(out, { page, limit });
    return out.slice(0, limit);
  }
  async listUsers({ page, limit } = {}) {
    const all = this.data.users
      .map(u => ({ ...u, copies: this.data.copies.filter(c => c.user_phone === u.phone).length }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return paginateArray(all, { page, limit });
  }
  async getUserInventory(phone) {
    const user = this.data.users.find(u => u.phone === phone) || null;
    // Las desechadas ya no son parte del inventario (el panel admin usa
    // listCopies() directo y ahí sí se siguen viendo).
    const copies = (await this.listCopies({ user_phone: phone, limit: 500 }))
      .filter(c => c.status !== 'scrapped');
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
    // El global_n se copia del drop que lo reservó. Un drop viejo sin
    // global_n (de antes de este cambio) reserva uno nuevo aquí.
    const globalN = drop.global_n ?? await this._reserveGlobal();
    // El código se copia del drop (ya venía calculado en el roll).
    const code = drop.code || buildCopyCode(fallbackSeriesCode(await this.getSeries(card.series_id)), fallbackCardCode(card), globalN, drop.serial_n);
    const copy = { id: uid(), card_id: card.id, user_phone: phone, serial_n: drop.serial_n, serial_m: drop.serial_m, global_n: globalN, code, status: 'owned', claimed_at: new Date().toISOString() };
    this.data.copies.push(copy);
    drop.status = 'claimed';
    this.data.transactions.push({ id: uid(), type: 'claim', copy_id: copy.id, from_phone: '', to_phone: phone, created_at: new Date().toISOString() });
    this._save();
    return { copy: this._enrichCopy(copy), card };
  }
  async gift({ copy_id, from_phone, to_phone, to_display_name }) {
    // Proceso único de Node: comprobar + actualizar es atómico en el mismo tick.
    const copy = this.data.copies.find(c => c.id === copy_id);
    if (!copy) { const e = new Error('Esa copia no existe.'); e.status = 404; throw e; }
    if (copy.user_phone !== from_phone) { const e = new Error('Esa carta no es tuya.'); e.status = 409; throw e; }
    if (copy.status === 'scrapped') { const e = new Error('Esa carta fue desechada.'); e.status = 409; throw e; }
    if (!this.data.users.some(u => u.phone === to_phone)) {
      this.data.users.push({ phone: to_phone, display_name: to_display_name || '', created_at: new Date().toISOString() });
    }
    // status = cómo llegó la copia a su dueño actual: 'owned' (claim directo),
    // 'gifted' (regalo), 'traded' (intercambio), 'scrapped' (desechada).
    copy.user_phone = to_phone;
    copy.status = 'gifted';
    this.data.transactions.push({ id: uid(), type: 'gift', copy_id: copy.id, from_phone, to_phone, created_at: new Date().toISOString() });
    this._save();
    const card = await this.getCard(copy.card_id);
    return { copy: this._enrichCopy(copy), card };
  }
  async scrap({ copy_id, phone }) {
    // Proceso único de Node: comprobar + actualizar es atómico en el mismo tick.
    const copy = this.data.copies.find(c => c.id === copy_id);
    if (!copy) { const e = new Error('Esa copia no existe.'); e.status = 404; throw e; }
    if (copy.user_phone !== phone) { const e = new Error('Esa carta no es tuya.'); e.status = 409; throw e; }
    if (copy.status === 'scrapped') { const e = new Error('Esa carta ya fue desechada.'); e.status = 409; throw e; }
    // La copia queda en la BD como historial; el inventario ya no la muestra.
    copy.status = 'scrapped';
    this.data.transactions.push({ id: uid(), type: 'scrap', copy_id: copy.id, from_phone: phone, to_phone: '', created_at: new Date().toISOString() });
    this._save();
    const card = await this.getCard(copy.card_id);
    return { copy: this._enrichCopy(copy), card };
  }
  async trade({ copy_id_a, phone_a, copy_id_b, phone_b, to_display_name_a, to_display_name_b }) {
    const a = this.data.copies.find(c => c.id === copy_id_a);
    const b = this.data.copies.find(c => c.id === copy_id_b);
    if (!a || !b) { const e = new Error('Una de las copias no existe.'); e.status = 404; throw e; }
    if (a.user_phone !== phone_a || b.user_phone !== phone_b) { const e = new Error('Una de las cartas no es de quien dice ser.'); e.status = 409; throw e; }
    if (a.status === 'scrapped' || b.status === 'scrapped') { const e = new Error('Una de las cartas fue desechada.'); e.status = 409; throw e; }
    for (const [phone, name] of [[phone_a, to_display_name_a], [phone_b, to_display_name_b]]) {
      if (!this.data.users.some(u => u.phone === phone)) {
        this.data.users.push({ phone, display_name: name || '', created_at: new Date().toISOString() });
      }
    }
    a.user_phone = phone_b; a.status = 'traded';
    b.user_phone = phone_a; b.status = 'traded';
    const now = new Date().toISOString();
    this.data.transactions.push(
      { id: uid(), type: 'trade', copy_id: a.id, from_phone: phone_a, to_phone: phone_b, created_at: now },
      { id: uid(), type: 'trade', copy_id: b.id, from_phone: phone_b, to_phone: phone_a, created_at: now });
    this._save();
    return { copy_a: this._enrichCopy(a), copy_b: this._enrichCopy(b), card_a: await this.getCard(a.card_id), card_b: await this.getCard(b.card_id) };
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
  async usedSerials(cardId) {
    const rows = await this.pool.query(
      `SELECT serial_n FROM copies WHERE card_id=$1
       UNION SELECT serial_n FROM drops WHERE card_id=$1 AND status='pending' AND expires_at > NOW()`,
      [cardId]);
    return new Set(rows.rows.map(r => r.serial_n));
  }
  async _reserveGlobal() {
    const r = await this.pool.query(`SELECT nextval('copies_global_seq') AS n`);
    return r.rows[0].n;
  }
  async _saveDrop(drop) {
    await this.pool.query(
      `INSERT INTO drops(id, card_id, serial_n, serial_m, global_n, code, group_jid, rolled_by_phone, status, created_at, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
      [drop.id, drop.card_id, drop.serial_n, drop.serial_m, drop.global_n, drop.code || null, drop.group_jid, drop.rolled_by_phone, drop.created_at, drop.expires_at]);
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
    const code = resolveCode(d.code, genSeriesCode(d.name), 'de la serie');
    const s = { id: uid(), name: d.name, slug: d.slug || slugify(d.name), code, description: d.description || '', active: d.active !== false };
    try {
      const r = await this.pool.query('INSERT INTO series(id,name,slug,code,description,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [s.id, s.name, s.slug, s.code, s.description, s.active]);
      return r.rows[0];
    } catch (e) { if (e.code === '23505') { const err = new Error('Ya existe una serie con ese slug o código.'); err.status = 400; throw err; } throw e; }
  }
  async updateSeries(id, d) {
    const cur = await this.getSeries(id); if (!cur) return null;
    const code = d.code !== undefined ? resolveCode(d.code, genSeriesCode(d.name ?? cur.name), 'de la serie') : cur.code;
    try {
      const r = await this.pool.query(
        'UPDATE series SET name=$2, slug=$3, code=$4, description=$5, active=$6 WHERE id=$1 RETURNING *',
        [id, d.name ?? cur.name, d.slug ?? cur.slug, code, d.description ?? cur.description, d.active ?? cur.active]);
      return r.rows[0];
    } catch (e) { if (e.code === '23505') { const err = new Error('Ya existe una serie con ese slug o código.'); err.status = 400; throw err; } throw e; }
  }
  async deleteSeries(id) { await this.pool.query('DELETE FROM series WHERE id=$1', [id]); return true; }
  async listCards({ series_id, rarity, activeOnly, page, limit } = {}) {
    const where = [], params = [];
    if (series_id) { params.push(series_id); where.push(`series_id=$${params.length}`); }
    if (rarity) { params.push(rarity); where.push(`rarity=$${params.length}`); }
    if (activeOnly) where.push('active=TRUE');
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    if (!pageWanted({ page, limit })) {
      return (await this.pool.query('SELECT * FROM cards' + clause + ' ORDER BY name', params)).rows;
    }
    const p = pageParams({ page, limit });
    const total = (await this.pool.query('SELECT COUNT(*)::int AS n FROM cards' + clause, params)).rows[0].n;
    const rows = (await this.pool.query(
      'SELECT * FROM cards' + clause + ` ORDER BY name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.limit, p.offset])).rows;
    return pageResult(rows, total, p);
  }
  async getCard(id) { return (await this.pool.query('SELECT * FROM cards WHERE id=$1', [id])).rows[0] || null; }
  async createCard(d) {
    if (!RARITIES.includes(d.rarity)) { const e = new Error('Rareza inválida. Usa Común, Raro, Épico o Legendario.'); e.status = 400; throw e; }
    const code = resolveCode(d.code, genCardCode(d.name), 'de la carta');
    const c = { id: uid(), series_id: d.series_id, name: d.name, code, team_or_group: d.team_or_group || '', position_or_role: d.position_or_role || '', rarity: d.rarity, max_copies: Math.max(1, parseInt(d.max_copies, 10) || 100), image_url: d.image_url || '', value: parseInt(d.value, 10) || 0, active: d.active !== false };
    try {
      const r = await this.pool.query(
        `INSERT INTO cards(id,series_id,name,code,team_or_group,position_or_role,rarity,max_copies,image_url,value,active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [c.id, c.series_id, c.name, c.code, c.team_or_group, c.position_or_role, c.rarity, c.max_copies, c.image_url, c.value, c.active]);
      return r.rows[0];
    } catch (e) {
      if (e.code === '23503') { const err = new Error('La serie no existe.'); err.status = 400; throw err; }
      if (e.code === '23505') { const err = new Error('Ya existe una carta con ese código en esta serie.'); err.status = 400; throw err; }
      throw e;
    }
  }
  async updateCard(id, d) {
    const cur = await this.getCard(id); if (!cur) return null;
    const code = d.code !== undefined ? resolveCode(d.code, genCardCode(d.name ?? cur.name), 'de la carta') : cur.code;
    try {
      const r = await this.pool.query(
        `UPDATE cards SET series_id=$2, name=$3, code=$4, team_or_group=$5, position_or_role=$6, rarity=$7,
         max_copies=$8, image_url=$9, value=$10, active=$11 WHERE id=$1 RETURNING *`,
        [id, d.series_id ?? cur.series_id, d.name ?? cur.name, code, d.team_or_group ?? cur.team_or_group,
         d.position_or_role ?? cur.position_or_role, d.rarity ?? cur.rarity,
         d.max_copies ? Math.max(1, parseInt(d.max_copies, 10)) : cur.max_copies,
         d.image_url ?? cur.image_url, d.value !== undefined ? parseInt(d.value, 10) || 0 : cur.value, d.active ?? cur.active]);
      return r.rows[0];
    } catch (e) {
      if (e.code === '23505') { const err = new Error('Ya existe una carta con ese código en esta serie.'); err.status = 400; throw err; }
      throw e;
    }
  }
  async deleteCard(id) { await this.pool.query('DELETE FROM cards WHERE id=$1', [id]); return true; }
  async listCopies({ series_id, card_id, user_phone, search, limit = 200, page } = {}) {
    const where = [], params = [];
    if (card_id) { params.push(card_id); where.push(`cp.card_id=$${params.length}`); }
    if (series_id) { params.push(series_id); where.push(`c.series_id=$${params.length}`); }
    if (user_phone) { params.push(user_phone); where.push(`cp.user_phone=$${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`(c.name ILIKE $${params.length} OR cp.code ILIKE $${params.length} OR cp.user_phone ILIKE $${params.length} OR s.name ILIKE $${params.length})`); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const base = `SELECT cp.*, c.name AS card_name, c.series_id, c.code AS card_code, c.team_or_group, c.rarity, c.image_url, s.name AS series_name, s.code AS series_code,
                 (cp.serial_n || '/' || cp.serial_m) AS serie
                 FROM copies cp JOIN cards c ON c.id=cp.card_id JOIN series s ON s.id=c.series_id`;
    const withCode = (rows) => rows.map(r => ({
      ...r,
      // El código se guarda en la copia al reclamarla; si falta (copia
      // vieja), se calcula igual con fallback desde los nombres.
      code: r.code || (r.global_n != null
        ? buildCopyCode(fallbackSeriesCode({ code: r.series_code, name: r.series_name }), fallbackCardCode({ code: r.card_code, name: r.card_name }), r.global_n, r.serial_n)
        : ''),
    }));
    if (page === undefined) {
      params.push(limit);
      return withCode((await this.pool.query(base + clause + ` ORDER BY cp.claimed_at DESC LIMIT $${params.length}`, params)).rows);
    }
    const p = pageParams({ page, limit });
    const total = (await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM copies cp JOIN cards c ON c.id=cp.card_id JOIN series s ON s.id=c.series_id` + clause, params)).rows[0].n;
    const rows = (await this.pool.query(
      base + clause + ` ORDER BY cp.claimed_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.limit, p.offset])).rows;
    return pageResult(withCode(rows), total, p);
  }
  async listUsers({ page, limit } = {}) {
    const sql = `SELECT u.*, (SELECT COUNT(*)::int FROM copies cp WHERE cp.user_phone=u.phone) AS copies FROM users u`;
    if (!pageWanted({ page, limit })) {
      return (await this.pool.query(sql + ' ORDER BY u.created_at DESC')).rows;
    }
    const p = pageParams({ page, limit });
    const total = (await this.pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
    const rows = (await this.pool.query(sql + ' ORDER BY u.created_at DESC LIMIT $1 OFFSET $2', [p.limit, p.offset])).rows;
    return pageResult(rows, total, p);
  }
  async getUserInventory(phone) {
    const user = (await this.pool.query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0] || null;
    // Las desechadas ya no son parte del inventario (el panel admin usa
    // listCopies() directo y ahí sí se siguen viendo).
    const copies = (await this.listCopies({ user_phone: phone, limit: 500 }))
      .filter(c => c.status !== 'scrapped');
    return { user, copies };
  }
  // Enriquecer una fila de copies con los datos de su carta y serie.
  async _enrichPgCopy(row) {
    const card = row ? (await this.pool.query('SELECT * FROM cards WHERE id=$1', [row.card_id])).rows[0] || null : null;
    const series = card ? (await this.pool.query('SELECT * FROM series WHERE id=$1', [card.series_id])).rows[0] || null : null;
    const code = row && (row.code || (row.global_n != null
      ? buildCopyCode(fallbackSeriesCode(series), fallbackCardCode(card), row.global_n, row.serial_n)
      : ''));
    return { ...row, card_name: card?.name || '', series_name: series?.name || '', team_or_group: card?.team_or_group || '', rarity: card?.rarity || '', image_url: card?.image_url || '', serie: `${row.serial_n}/${row.serial_m}`, code };
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
      // El global_n se copia del drop que lo reservó. Un drop viejo sin
      // global_n (de antes de este cambio) reserva uno nuevo aquí.
      const globalN = drop.global_n ?? (await client.query(`SELECT nextval('copies_global_seq') AS n`)).rows[0].n;
      // El código se copia del drop (ya venía calculado en el roll).
      const series0 = (await client.query('SELECT * FROM series WHERE id=$1', [card.series_id])).rows[0] || null;
      const code = drop.code || buildCopyCode(fallbackSeriesCode(series0), fallbackCardCode(card), globalN, drop.serial_n);
      const copyId = uid();
      const cr = await client.query(
        `INSERT INTO copies(id, card_id, user_phone, serial_n, serial_m, global_n, code, status)
         VALUES($1,$2,$3,$4,$5,$6,$7,'owned') RETURNING *`,
        [copyId, card.id, phone, drop.serial_n, drop.serial_m, globalN, code]);
      await client.query(`UPDATE drops SET status='claimed' WHERE id=$1`, [drop_id]);
      await client.query(`INSERT INTO transactions(id, type, copy_id, from_phone, to_phone) VALUES($1,'claim',$2,'',$3)`, [uid(), copyId, phone]);
      await client.query('COMMIT');
      const copy = cr.rows[0];
      const series = series0;
      return { copy: { ...copy, card_name: card.name, series_name: series?.name || '', team_or_group: card.team_or_group, rarity: card.rarity, image_url: card.image_url, serie: `${copy.serial_n}/${copy.serial_m}`, code: copy.code || code }, card };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (e.code === '23505') { const err = new Error('Ese número de serie ya fue asignado.'); err.status = 409; throw err; }
      if (e.status) throw e;
      throw e;
    } finally { client.release(); }
  }
  async gift({ copy_id, from_phone, to_phone, to_display_name }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cr = await client.query('SELECT * FROM copies WHERE id=$1 FOR UPDATE', [copy_id]);
      const copy = cr.rows[0];
      if (!copy) { const e = new Error('Esa copia no existe.'); e.status = 404; throw e; }
      if (copy.user_phone !== from_phone) { const e = new Error('Esa carta no es tuya.'); e.status = 409; throw e; }
      if (copy.status === 'scrapped') { const e = new Error('Esa carta fue desechada.'); e.status = 409; throw e; }
      await client.query('INSERT INTO users(phone, display_name) VALUES($1,$2) ON CONFLICT (phone) DO NOTHING', [to_phone, to_display_name || '']);
      const upd = await client.query(
        `UPDATE copies SET user_phone=$2, status='gifted' WHERE id=$1 RETURNING *`,
        [copy_id, to_phone]);
      await client.query(`INSERT INTO transactions(id, type, copy_id, from_phone, to_phone) VALUES($1,'gift',$2,$3,$4)`, [uid(), copy_id, from_phone, to_phone]);
      await client.query('COMMIT');
      const row = upd.rows[0];
      const card = (await this.pool.query('SELECT * FROM cards WHERE id=$1', [copy.card_id])).rows[0] || null;
      const series = card ? (await this.pool.query('SELECT * FROM series WHERE id=$1', [card.series_id])).rows[0] || null : null;
      const code = row.code || (row.global_n != null ? buildCopyCode(fallbackSeriesCode(series), fallbackCardCode(card), row.global_n, row.serial_n) : '');
      return { copy: { ...row, card_name: card?.name || '', series_name: series?.name || '', team_or_group: card?.team_or_group || '', rarity: card?.rarity || '', image_url: card?.image_url || '', serie: `${row.serial_n}/${row.serial_m}`, code }, card };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (e.status) throw e;
      throw e;
    } finally { client.release(); }
  }
  async scrap({ copy_id, phone }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cr = await client.query('SELECT * FROM copies WHERE id=$1 FOR UPDATE', [copy_id]);
      const copy = cr.rows[0];
      if (!copy) { const e = new Error('Esa copia no existe.'); e.status = 404; throw e; }
      if (copy.user_phone !== phone) { const e = new Error('Esa carta no es tuya.'); e.status = 409; throw e; }
      if (copy.status === 'scrapped') { const e = new Error('Esa carta ya fue desechada.'); e.status = 409; throw e; }
      const upd = await client.query(`UPDATE copies SET status='scrapped' WHERE id=$1 RETURNING *`, [copy_id]);
      await client.query(`INSERT INTO transactions(id, type, copy_id, from_phone, to_phone) VALUES($1,'scrap',$2,$3,'')`, [uid(), copy_id, phone]);
      await client.query('COMMIT');
      const card = (await this.pool.query('SELECT * FROM cards WHERE id=$1', [copy.card_id])).rows[0] || null;
      return { copy: await this._enrichPgCopy(upd.rows[0]), card };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (e.status) throw e;
      throw e;
    } finally { client.release(); }
  }
  async trade({ copy_id_a, phone_a, copy_id_b, phone_b, to_display_name_a, to_display_name_b }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Bloquear en orden fijo de id para que dos trades cruzados no se atoren.
      const [firstId, secondId] = [copy_id_a, copy_id_b].sort();
      const locked = new Map();
      for (const id of [firstId, secondId]) {
        const r = await client.query('SELECT * FROM copies WHERE id=$1 FOR UPDATE', [id]);
        if (r.rows[0]) locked.set(id, r.rows[0]);
      }
      const a = locked.get(copy_id_a), b = locked.get(copy_id_b);
      if (!a || !b) { const e = new Error('Una de las copias no existe.'); e.status = 404; throw e; }
      if (a.user_phone !== phone_a || b.user_phone !== phone_b) { const e = new Error('Una de las cartas no es de quien dice ser.'); e.status = 409; throw e; }
      if (a.status === 'scrapped' || b.status === 'scrapped') { const e = new Error('Una de las cartas fue desechada.'); e.status = 409; throw e; }
      await client.query('INSERT INTO users(phone, display_name) VALUES($1,$2) ON CONFLICT (phone) DO NOTHING', [phone_a, to_display_name_a || '']);
      await client.query('INSERT INTO users(phone, display_name) VALUES($1,$2) ON CONFLICT (phone) DO NOTHING', [phone_b, to_display_name_b || '']);
      const updA = await client.query(`UPDATE copies SET user_phone=$2, status='traded' WHERE id=$1 RETURNING *`, [copy_id_a, phone_b]);
      const updB = await client.query(`UPDATE copies SET user_phone=$2, status='traded' WHERE id=$1 RETURNING *`, [copy_id_b, phone_a]);
      await client.query(`INSERT INTO transactions(id, type, copy_id, from_phone, to_phone) VALUES($1,'trade',$2,$3,$4)`, [uid(), copy_id_a, phone_a, phone_b]);
      await client.query(`INSERT INTO transactions(id, type, copy_id, from_phone, to_phone) VALUES($1,'trade',$2,$3,$4)`, [uid(), copy_id_b, phone_b, phone_a]);
      await client.query('COMMIT');
      const cardA = (await this.pool.query('SELECT * FROM cards WHERE id=$1', [a.card_id])).rows[0] || null;
      const cardB = (await this.pool.query('SELECT * FROM cards WHERE id=$1', [b.card_id])).rows[0] || null;
      return { copy_a: await this._enrichPgCopy(updA.rows[0]), copy_b: await this._enrichPgCopy(updB.rows[0]), card_a: cardA, card_b: cardB };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
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

module.exports = { createStore, RARITIES, BASE_WEIGHTS, DROP_TTL_MS, rollText, buildCopyCode, genSeriesCode, genCardCode, normalizeCode };
