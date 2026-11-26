-- EDOMEXBOT / cards-admin — esquema Postgres
-- La app también ejecuta este archivo automáticamente al arrancar
-- en modo Postgres (si DATABASE_URL está definido).
-- No contiene credenciales: la conexión viene de DATABASE_URL.
--
-- ORDEN IMPORTANTE: el init corre este archivo como una sola consulta,
-- así que van PRIMERO todas las CREATE TABLE, LUEGO los ALTER y AL FINAL
-- todos los índices. Un índice que referencia una columna que el ALTER
-- aún no creó aborta toda la migración (eso pasó en el despliegue del
-- código único: faltaba global_n al crear idx_copies_global_n).

-- Consecutivo global de copias: cada copia emitida en TODO el juego
-- lleva el siguiente número (1, 2, 3...), sin importar la serie. Nunca
-- se reutiliza: si el drop vence o la copia se desecha, ese número queda
-- quemado (con hueco). Se reserva en el roll (nextval) y el claim lo
-- copia del drop a la copia.
CREATE SEQUENCE IF NOT EXISTS copies_global_seq;

CREATE TABLE IF NOT EXISTS series (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  code        TEXT,
  description TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cards (
  id              TEXT PRIMARY KEY,
  series_id       TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  code            TEXT,
  team_or_group   TEXT NOT NULL DEFAULT '',
  position_or_role TEXT NOT NULL DEFAULT '',
  rarity          TEXT NOT NULL DEFAULT 'Común'
                  CHECK (rarity IN ('Común','Raro','Épico','Legendario')),
  max_copies      INTEGER NOT NULL DEFAULT 100 CHECK (max_copies > 0),
  image_url       TEXT NOT NULL DEFAULT '',
  value           INTEGER NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  phone         TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL DEFAULT '',
  last_daily_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS copies (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_phone  TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  serial_n    INTEGER NOT NULL CHECK (serial_n > 0),
  serial_m    INTEGER NOT NULL CHECK (serial_m > 0),
  global_n    INTEGER,
  code        TEXT,
  status      TEXT NOT NULL DEFAULT 'owned'
              CHECK (status IN ('owned','gifted','traded','scrapped')),
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drops (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  serial_n        INTEGER NOT NULL,
  serial_m        INTEGER NOT NULL,
  global_n        INTEGER,
  code            TEXT,
  group_jid       TEXT NOT NULL DEFAULT '',
  rolled_by_phone TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','claimed','expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL
              CHECK (type IN ('claim','gift','trade','scrap')),
  copy_id     TEXT REFERENCES copies(id) ON DELETE SET NULL,
  from_phone  TEXT NOT NULL DEFAULT '',
  to_phone    TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migración para bases ya existentes (las CREATE TABLE de arriba solo
-- crean si no existen, así que los cambios van con ALTER):
ALTER TABLE series ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE copies ADD COLUMN IF NOT EXISTS global_n INTEGER;
ALTER TABLE copies ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE drops ADD COLUMN IF NOT EXISTS global_n INTEGER;
ALTER TABLE drops ADD COLUMN IF NOT EXISTS code TEXT;
-- Base para el daily (futuro !daily): cuándo reclamó el usuario su
-- última recompensa diaria. NULL = nunca. Todavía no hay endpoint ni
-- comando que lo use; el !daily futuro leería y actualizaría este campo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_at TIMESTAMPTZ;

-- Índices (después de los ALTER, ver el orden importante de arriba).
CREATE INDEX IF NOT EXISTS idx_cards_series ON cards(series_id);
CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);
-- Una misma carta no puede tener dos copias con el mismo número de serie.
CREATE UNIQUE INDEX IF NOT EXISTS idx_copies_card_serial
  ON copies(card_id, serial_n);
-- El consecutivo global tampoco se repite jamás en todo el juego.
CREATE UNIQUE INDEX IF NOT EXISTS idx_copies_global_n ON copies(global_n);
-- El código se guarda al reclamar (es la forma corta de mostrar y buscar
-- la copia). Sin UNIQUE: la unicidad real la dan global_n y
-- (card_id, serial_n); al buscar por código se desempata por mayor serial_n.
CREATE INDEX IF NOT EXISTS idx_copies_code ON copies(code);
CREATE INDEX IF NOT EXISTS idx_copies_user ON copies(user_phone);
CREATE INDEX IF NOT EXISTS idx_copies_card ON copies(card_id);
CREATE INDEX IF NOT EXISTS idx_drops_status ON drops(status);
CREATE INDEX IF NOT EXISTS idx_drops_group ON drops(group_jid);
CREATE INDEX IF NOT EXISTS idx_drops_code ON drops(code);
CREATE INDEX IF NOT EXISTS idx_tx_copy ON transactions(copy_id);
CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_phone);
-- Códigos únicos: el de serie en todo el juego, el de carta dentro de
-- su serie. (Postgres permite varios NULL, así que las filas viejas sin
-- código no chocan; el backfill de abajo los rellena.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_code ON series(code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_series_code ON cards(series_id, code);

-- Backfill de códigos para las series/cartas que ya existen sin código.
-- Ejecutar en producción después del despliegue (o desde el panel,
-- editando cada serie/carta y guardando):
--   UPDATE series SET code='LMX' WHERE slug='liga-mx-apertura-2026' AND code IS NULL;
--   UPDATE series SET code='PRU' WHERE name='Pruebas' AND code IS NULL;
--   UPDATE cards SET code='VEG' WHERE name='Alexis Vega' AND code IS NULL;
--   UPDATE cards SET code='CAN' WHERE name='Sergio Canales' AND code IS NULL;
--   UPDATE cards SET code='MOR' WHERE name='Omar Moreno' AND code IS NULL;
--   UPDATE cards SET code='MUS' WHERE name='Muse' AND code IS NULL;
-- Aunque queden en NULL, el código de la copia se calcula igual con
-- fallback (se deriva del nombre), así que nada se rompe.
