PRAGMA foreign_keys = ON;

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL
);

CREATE TABLE parents (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE children (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  age_band TEXT NOT NULL CHECK (age_band IN ('under_10','age_10_12','age_13_15','age_16_17')),
  timezone TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  safe_search INTEGER NOT NULL DEFAULT 1,
  youtube_restricted INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE policy_categories (
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  PRIMARY KEY (child_id, category)
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  days_json TEXT NOT NULL,
  start_minutes INTEGER NOT NULL,
  end_minutes INTEGER NOT NULL
);

CREATE TABLE domain_rules (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('allow','block')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(child_id, domain)
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'windows'),
  credential_hash TEXT NOT NULL UNIQUE,
  agent_version TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 0,
  list_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'healthy',
  last_seen_at TEXT NOT NULL,
  offline_alerted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE enrollment_codes (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  domain TEXT,
  category TEXT,
  browser TEXT,
  detail TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX events_household_time ON events(household_id, occurred_at DESC);
CREATE INDEX events_child_time ON events(child_id, occurred_at DESC);

CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  category TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  duration TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX requests_household_status ON access_requests(household_id, status, requested_at DESC);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_household_time ON audit_log(household_id, created_at DESC);

CREATE TABLE idempotency_keys (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(device_id, key)
);
