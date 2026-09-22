-- Spelare. Varje spelare har en hemlig token som ingår i hens personliga länk.
CREATE TABLE players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Pass. starts_at lagras som ISO 8601 i UTC, t.ex. 2026-09-29T17:00:00.000Z.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at   TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  min_players INTEGER NOT NULL DEFAULT 6,
  notified_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX events_starts_at ON events (starts_at);

-- Svar: en rad per spelare och pass. Primärnyckeln gör att samtidiga svar
-- aldrig kan skriva över varandra (till skillnad från den gamla KV-listan).
CREATE TABLE responses (
  event_id   INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('yes', 'maybe', 'no')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (event_id, player_id)
);
