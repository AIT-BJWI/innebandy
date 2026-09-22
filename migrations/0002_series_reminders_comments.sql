-- Återkommande pass: en serie per veckodag och tid (svensk tid).
CREATE TABLE series (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1 = måndag
  time        TEXT NOT NULL,                                    -- "HH:MM" i Europe/Stockholm
  location    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  min_players INTEGER NOT NULL DEFAULT 6,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Pass som skapats från en serie. Ett inställt seriepass ligger kvar (cancelled = 1)
-- så att det inte skapas på nytt nästa gång serien fylls på.
ALTER TABLE events ADD COLUMN series_id INTEGER REFERENCES series (id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN reminded_at TEXT;
CREATE UNIQUE INDEX events_series_start ON events (series_id, starts_at) WHERE series_id IS NOT NULL;

-- E-post för påminnelser (valfritt per spelare).
ALTER TABLE players ADD COLUMN email TEXT NOT NULL DEFAULT '';

-- Kommentarer på ett pass.
CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX comments_event ON comments (event_id, created_at);
