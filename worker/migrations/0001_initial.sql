-- Documentation Database Migration: 0001_initial.sql
-- First-party privacy-preserving storage for reader feedback and aggregated documentation intelligence.
-- Never stores raw PSBTs, credentials, private keys, wallet addresses, IP addresses, or user agent strings.

CREATE TABLE IF NOT EXISTS docs_feedback (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL, -- helpful, not_helpful, unclear, outdated, missing_example, broken_workflow, other
  route TEXT NOT NULL,
  heading TEXT,
  protocol_version TEXT NOT NULL,
  build_commit TEXT NOT NULL,
  comment_redacted TEXT,
  created_at INTEGER NOT NULL -- Unix timestamp in seconds
);

CREATE INDEX IF NOT EXISTS idx_docs_feedback_route ON docs_feedback(route);
CREATE INDEX IF NOT EXISTS idx_docs_feedback_created_at ON docs_feedback(created_at);

CREATE TABLE IF NOT EXISTS docs_events_raw (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  route TEXT NOT NULL,
  product TEXT,
  protocol_version TEXT,
  role TEXT,
  category_data TEXT, -- Sanitized JSON string of categorical event details
  build_commit TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_events_name ON docs_events_raw(event_name);
CREATE INDEX IF NOT EXISTS idx_docs_events_created ON docs_events_raw(created_at);

CREATE TABLE IF NOT EXISTS docs_events_hourly (
  hour_bucket TEXT NOT NULL, -- YYYY-MM-DD-HH
  event_name TEXT NOT NULL,
  route TEXT NOT NULL,
  product TEXT,
  role TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (hour_bucket, event_name, route, product, role)
);
