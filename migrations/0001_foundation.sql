CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','TIMED_OUT')),
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('LOCAL','E2B')),
  data_classification text NOT NULL DEFAULT 'SYNTHETIC' CHECK (data_classification IN ('SYNTHETIC','PUBLIC_PROFESSIONAL')),
  submission_kind text NOT NULL CHECK (submission_kind IN ('JSON','TEXT')),
  submission_raw text NOT NULL,
  submission_normalized text NOT NULL,
  submission_sha256 text NOT NULL CHECK (length(submission_sha256) = 64),
  resume_artifact_id uuid,
  latest_run_id uuid,
  final_summary jsonb,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS investigations_status_created_idx ON investigations(status, created_at);
-- statement-breakpoint
ALTER TABLE investigations DROP CONSTRAINT IF EXISTS investigations_data_classification_check;
ALTER TABLE investigations ADD CONSTRAINT investigations_data_classification_check
  CHECK (data_classification IN ('SYNTHETIC','PUBLIC_PROFESSIONAL'));
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','TIMED_OUT')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  deadline_at timestamptz,
  runtime_handle jsonb,
  opencode_primary_session_id text,
  opencode_adjudicator_session_id text,
  capability_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  runtime_manifest_hash text,
  error_code text,
  error_message text,
  cleanup_status text NOT NULL DEFAULT 'PENDING' CHECK (cleanup_status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_claim_idx ON runs(status, lease_expires_at, queued_at);
CREATE INDEX IF NOT EXISTS runs_investigation_idx ON runs(investigation_id, created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  category text NOT NULL,
  normalized_claim text NOT NULL,
  materiality text NOT NULL CHECK (materiality IN ('HIGH','MEDIUM','LOW')),
  source_span jsonb,
  valid_from timestamptz,
  valid_to timestamptz,
  entity_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS claims_case_idx ON claims(investigation_id, materiality);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('PERSON','ORGANIZATION','ACCOUNT','WEBSITE','PUBLICATION','PATENT','PACKAGE')),
  canonical_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entities_case_name_idx ON entities(investigation_id, canonical_name);
CREATE UNIQUE INDEX IF NOT EXISTS entities_case_type_name_unique
  ON entities(investigation_id, type, lower(canonical_name));
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS entity_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type text NOT NULL,
  value text NOT NULL,
  normalized_value text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_identifiers_lookup_idx ON entity_identifiers(investigation_id, type, normalized_value);
CREATE UNIQUE INDEX IF NOT EXISTS entity_identifiers_entity_value_unique
  ON entity_identifiers(entity_id, type, normalized_value);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS entity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  from_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_entity_id <> to_entity_id),
  CHECK (cardinality(evidence_ids) >= 2)
);
CREATE INDEX IF NOT EXISTS entity_links_case_idx ON entity_links(investigation_id, from_entity_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  kind text NOT NULL,
  provider text,
  source_url text,
  mime_type text NOT NULL,
  file_name text,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  http_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  sha256 text NOT NULL CHECK (length(sha256) = 64),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  content_bytes bytea NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_case_idx ON artifacts(investigation_id, created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  field text NOT NULL,
  value_json jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  source_event_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS observations_timeline_idx ON observations(investigation_id, entity_id, valid_from);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  exact_quote text NOT NULL,
  source_location jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_tier text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('SUPPORTS','CONTRADICTS','CONTEXT')),
  claim_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  entity_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(exact_quote)) > 0)
);
CREATE INDEX IF NOT EXISTS evidence_case_idx ON evidence(investigation_id, created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS research_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  claim_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  question text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('HIGH','MEDIUM','LOW')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','EXHAUSTED','SKIPPED')),
  possible_routes jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_route text,
  created_by_agent text NOT NULL,
  created_by_session text,
  resolution_summary text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_frontier_idx ON research_questions(investigation_id, status, priority);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('CORROBORATED','PARTIALLY_CORROBORATED','CONTRADICTED','UNRESOLVED')),
  strength text NOT NULL CHECK (strength IN ('STRONG','MODERATE','WEAK')),
  explanation text NOT NULL,
  supporting_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  contradicting_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  limitations text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS findings_case_idx ON findings(investigation_id, claim_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_events (
  id bigserial PRIMARY KEY,
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase text NOT NULL,
  agent text NOT NULL,
  session_id text,
  event_type text NOT NULL,
  tool text,
  source text,
  status text NOT NULL,
  budget_delta jsonb NOT NULL DEFAULT '{}'::jsonb,
  public_rationale text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_events_stream_idx ON agent_events(investigation_id, id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS provider_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  capability text NOT NULL,
  provider text NOT NULL,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  result_status text NOT NULL,
  cost_usd double precision NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  retry_after_ms integer CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  artifact_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_calls_budget_idx ON provider_calls(investigation_id, provider, created_at);
-- statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_artifact_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'artifacts are immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS artifacts_immutable_update ON artifacts;
CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION prevent_artifact_mutation();
DROP TRIGGER IF EXISTS artifacts_immutable_delete ON artifacts;
CREATE TRIGGER artifacts_immutable_delete BEFORE DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION prevent_artifact_mutation();
-- statement-breakpoint
CREATE OR REPLACE FUNCTION notify_investigation_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('investigation_events', NEW.investigation_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_events_notify ON agent_events;
CREATE TRIGGER agent_events_notify AFTER INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION notify_investigation_event();
-- statement-breakpoint
CREATE OR REPLACE FUNCTION notify_investigation_run() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('investigation_runs', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS runs_notify ON runs;
CREATE TRIGGER runs_notify AFTER INSERT ON runs FOR EACH ROW EXECUTE FUNCTION notify_investigation_run();
