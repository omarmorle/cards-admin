// scripts/migrate.js — migración one-time de JSON a Postgres real.
// Lee <DATA_DIR>/cards-data.json y lo inserta en Postgres con el estado
// EXACTO del JSON (mismos ids, mismas fechas, mismo orden de llaves).
//
// Uso:
//   DATABASE_URL=postgres://usuario:contrasena@host:5432/cards_admin \
//   DATA_DIR=/data node scripts/migrate.js [--reset-catalog]
//
//   --reset-catalog  Borra TODO el contenido de las 6 tablas antes de
//                    insertar (sirve si la BD ya se sembró sola al
//                    arrancar el servidor en modo Postgres). Sin este
//                    flag, si la BD ya tiene datos, el script se niega
//                    a migrar para no duplicar ni mezclar nada.
//   --init-empty     Solo crea la base de datos y las tablas, sin leer
//                    el JSON (instalación nueva, sin datos que migrar).
//                    Al arrancar después, el servidor siembra solo los
//                    datos de ejemplo.
//
// Qué hace, en orden:
//   1. Crea la base de datos de DATABASE_URL si no existe (se conecta a
//      la BD de mantenimiento "postgres" del mismo servidor).
//   2. Crea las tablas con schema.sql (si no existen).
//   3. Si la BD ya tiene datos: aborta, salvo --reset-catalog.
//   4. Inserta series → cards → users → copies → drops → transactions
//      en una sola transacción y verifica que los conteos coincidan.
//
// DATABASE_URL nunca va quemado aquí: viene de variable de entorno.
// El modo JSON sigue funcionando si no hay DATABASE_URL (fallback).
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const RESET = process.argv.includes('--reset-catalog');
const INIT_EMPTY = process.argv.includes('--init-empty');
const DATABASE_URL = process.env.DATABASE_URL;
const DATA_DIR = process.env.DATA_DIR || '/data';
const TABLES = ['series', 'cards', 'users', 'copies', 'drops', 'transactions'];

function fail(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}

function parseTargetUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { fail('DATABASE_URL no es una URL válida.'); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    fail('DATABASE_URL debe empezar con postgres://');
  }
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'cards_admin';
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(dbName)) {
    fail(`Nombre de base de datos inválido en DATABASE_URL: "${dbName}".`);
  }
  return { url: u, dbName };
}

async function main() {
  if (!DATABASE_URL) {
    fail('Falta DATABASE_URL. Ejemplo:\n  DATABASE_URL=postgres://usuario:contrasena@postgres_evo:5432/cards_admin node scripts/migrate.js');
  }
  const { url, dbName } = parseTargetUrl(DATABASE_URL);

  const jsonFile = path.join(DATA_DIR, 'cards-data.json');
  let data;
  if (INIT_EMPTY) {
    console.log('Flag --init-empty: no se lee el JSON, solo se crean BD y tablas.');
    data = { series: [], cards: [], users: [], copies: [], drops: [], transactions: [] };
  } else {
    if (!fs.existsSync(jsonFile)) fail(`No existe el archivo JSON: ${jsonFile} (revisa DATA_DIR).`);
    data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  }
  for (const t of TABLES) {
    if (!Array.isArray(data[t])) fail(`El JSON no trae el arreglo "${t}".`);
  }

  // 1) Crear la base de datos si no existe (vía la BD "postgres").
  const maintUrl = new URL(url.toString());
  maintUrl.pathname = '/postgres';
  const maint = new Client({ connectionString: maintUrl.toString() });
  await maint.connect();
  try {
    const found = await maint.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!found.rows.length) {
      console.log(`Creando base de datos "${dbName}"...`);
      await maint.query(`CREATE DATABASE "${dbName}"`);
    } else {
      console.log(`La base de datos "${dbName}" ya existe.`);
    }
  } finally { await maint.end(); }

  // 2) Conectar a la base destino y crear el esquema.
  const targetUrl = new URL(url.toString());
  targetUrl.pathname = '/' + dbName;
  const client = new Client({ connectionString: targetUrl.toString() });
  await client.connect();
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('Esquema aplicado (schema.sql).');

    // 3) ¿Ya hay datos?
    const counts = {};
    for (const t of TABLES) {
      counts[t] = (await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0 && !RESET) {
      fail(
        `La base "${dbName}" ya tiene datos (${Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(', ')}).\n` +
        'Para reemplazarlos con el contenido exacto del JSON, corre de nuevo con --reset-catalog.\n' +
        'O vacía la base y vuelve a correr sin el flag.'
      );
    }
    if (total > 0 && RESET) {
      console.log('Flag --reset-catalog: vaciando las 6 tablas...');
      await client.query('TRUNCATE series, cards, users, copies, drops, transactions CASCADE');
    }

    // 4) Insertar todo en una sola transacción, en orden de llaves foráneas.
    await client.query('BEGIN');
    try {
      for (const s of data.series) {
        await client.query(
          'INSERT INTO series(id, name, slug, description, active, created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [s.id, s.name, s.slug, s.description || '', s.active !== false, s.created_at || new Date().toISOString()]);
      }
      for (const c of data.cards) {
        await client.query(
          `INSERT INTO cards(id, series_id, name, team_or_group, position_or_role, rarity, max_copies, image_url, value, active, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [c.id, c.series_id, c.name, c.team_or_group || '', c.position_or_role || '', c.rarity,
           c.max_copies, c.image_url || '', c.value || 0, c.active !== false, c.created_at || new Date().toISOString()]);
      }
      for (const u of data.users) {
        await client.query(
          'INSERT INTO users(phone, display_name, created_at) VALUES($1,$2,$3)',
          [u.phone, u.display_name || '', u.created_at || new Date().toISOString()]);
      }
      for (const cp of data.copies) {
        await client.query(
          'INSERT INTO copies(id, card_id, user_phone, serial_n, serial_m, status, claimed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [cp.id, cp.card_id, cp.user_phone, cp.serial_n, cp.serial_m, cp.status || 'owned', cp.claimed_at || new Date().toISOString()]);
      }
      for (const d of data.drops) {
        await client.query(
          'INSERT INTO drops(id, card_id, serial_n, serial_m, group_jid, rolled_by_phone, status, created_at, expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [d.id, d.card_id, d.serial_n, d.serial_m, d.group_jid || '', d.rolled_by_phone || '',
           d.status || 'pending', d.created_at || new Date().toISOString(), d.expires_at]);
      }
      for (const t of data.transactions) {
        await client.query(
          'INSERT INTO transactions(id, type, copy_id, from_phone, to_phone, created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [t.id, t.type, t.copy_id || null, t.from_phone || '', t.to_phone || '', t.created_at || new Date().toISOString()]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }

    // 5) Verificar conteos.
    console.log('Migración completada. Verificación:');
    let ok = true;
    for (const t of TABLES) {
      const n = (await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
      const expected = data[t].length;
      console.log(`  ${t}: ${n} (esperado ${expected})${n === expected ? '' : '  <-- NO COINCIDE'}`);
      if (n !== expected) ok = false;
    }
    if (!ok) fail('Los conteos no coinciden con el JSON. Revisa la salida de arriba.');
    console.log('\nListo. Ahora arranca el servidor con el mismo DATABASE_URL y usará Postgres.');
    console.log('El archivo JSON queda intacto como respaldo; el modo JSON sigue disponible si quitas DATABASE_URL.');
  } finally { await client.end(); }
}

main().catch((e) => {
  console.error('ERROR: ' + (e.message || e));
  if (e.code) console.error('Código PG: ' + e.code);
  process.exit(1);
});
