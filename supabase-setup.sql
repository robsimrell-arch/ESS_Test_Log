-- ============================================================
-- Chamber Test Log – Supabase Table Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  uuid        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator    TEXT NOT NULL DEFAULT '',
  chamber     TEXT NOT NULL DEFAULT '',
  station     TEXT NOT NULL DEFAULT '',
  part_number TEXT NOT NULL DEFAULT '',
  test_type   TEXT NOT NULL DEFAULT '',
  start_time  TEXT,
  end_time    TEXT,
  created_at  TEXT NOT NULL DEFAULT '',
  closed_by   TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UUT entries table
CREATE TABLE IF NOT EXISTS uut_entries (
  uuid          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_uuid  UUID NOT NULL REFERENCES sessions(uuid) ON DELETE CASCADE,
  channel       INTEGER NOT NULL DEFAULT 0,
  uut_serial    TEXT NOT NULL DEFAULT '',
  cable_serial  TEXT NOT NULL DEFAULT '',
  backplane     TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  failure_notes TEXT NOT NULL DEFAULT '',
  result        TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Config table (settings sync)
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for faster session lookups
CREATE INDEX IF NOT EXISTS idx_uut_session ON uut_entries(session_uuid);

-- Enable Row Level Security (but allow all for anon since this is internal-use)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE uut_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;

-- Policies: allow full access for authenticated and anon users (internal tool)
CREATE POLICY "Allow all on sessions" ON sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on uut_entries" ON uut_entries FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on config" ON config FOR ALL USING (true) WITH CHECK (true);
