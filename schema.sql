-- EDOMEXBOT / cards-admin — esquema Postgres
-- La app también ejecuta este archivo automáticamente al arrancar
-- en modo Postgres (si DATABASE_URL está definido).
-- No contiene credenciales: la conexión viene de DATABASE_URL.

CREATE TABLE IF NOT EXISTS series (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cards (
  id              TEXT PRIMARY KEY,
  series_id       TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_cards_series ON cards(series_id);
CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);

CREATE TABLE IF NOT EXISTS users (
  phone         TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS copies (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_phone  TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  serial_n    INTEGER NOT NULL CHECK (serial_n > 0),
  serial_m    INTEGER NOT NULL CHECK (serial_m > 0),
  status      TEXT NOT NULL DEFAULT 'owned'
              CHECK (status IN ('owned','gifted','traded','scrapped')),
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Una misma carta no puede tener dos copias con el mismo número de serie.
CREATE UNIQUE INDEX IF NOT EXISTS idx_copies_card_serial
  ON copies(card_id, serial_n);
CREATE INDEX IF NOT EXISTS idx_copies_user ON copies(user_phone);
CREATE INDEX IF NOT EXISTS idx_copies_card ON copies(card_id);

CREATE TABLE IF NOT EXISTS drops (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  serial_n        INTEGER NOT NULL,
  serial_m        INTEGER NOT NULL,
  group_jid       TEXT NOT NULL DEFAULT '',
  rolled_by_phone TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','claimed','expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drops_status ON drops(status);
CREATE INDEX IF NOT EXISTS idx_drops_group ON drops(group_jid);

CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL
              CHECK (type IN ('claim','gift','trade','scrap')),
  copy_id     TEXT REFERENCES copies(id) ON DELETE SET NULL,
  from_phone  TEXT NOT NULL DEFAULT '',
  to_phone    TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_copy ON transactions(copy_id);
CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_phone);
