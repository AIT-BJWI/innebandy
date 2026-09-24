-- Schemalagda mejl före varje pass: inbjudan (3 dagar före kl. 12) och
-- sammanställning (samma dag kl. 13). Påminnelsen (kl. 9) använder reminded_at.
ALTER TABLE events ADD COLUMN invited_at TEXT;
ALTER TABLE events ADD COLUMN summary_at TEXT;
