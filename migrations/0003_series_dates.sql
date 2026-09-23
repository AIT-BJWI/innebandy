-- Start- och slutdatum för återkommande pass ("YYYY-MM-DD" i svensk tid).
-- Tom sträng betyder ingen gräns.
ALTER TABLE series ADD COLUMN start_date TEXT NOT NULL DEFAULT '';
ALTER TABLE series ADD COLUMN end_date TEXT NOT NULL DEFAULT '';
