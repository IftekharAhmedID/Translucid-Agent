ALTER TABLE runs ALTER COLUMN capability_snapshot DROP NOT NULL;
ALTER TABLE runs ALTER COLUMN capability_snapshot DROP DEFAULT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS root_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS research_wave_count integer NOT NULL DEFAULT 0 CHECK (research_wave_count BETWEEN 0 AND 2);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS research_wave_state jsonb NOT NULL DEFAULT '{}'::jsonb;
-- statement-breakpoint
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_authority text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS independence_group text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS canonical_source_url text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_new_source_trust_check') THEN
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_new_source_trust_check CHECK (
      source_authority IN ('DIRECT_WORK','FIRST_PARTY_INSTITUTIONAL','INDEPENDENT_PROFESSIONAL','SELF_REPRESENTATION','CONTEXT','DISCOVERY_ONLY')
      AND independence_group IS NOT NULL
      AND canonical_source_url IS NOT NULL
    ) NOT VALID;
  END IF;
END $$;
-- statement-breakpoint
ALTER TABLE provider_calls ADD COLUMN IF NOT EXISTS semantic_tool text;
ALTER TABLE provider_calls ADD COLUMN IF NOT EXISTS provider_route text;
ALTER TABLE provider_calls ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE provider_calls ADD COLUMN IF NOT EXISTS cost_source text;
ALTER TABLE provider_calls ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1;
ALTER TABLE provider_calls ADD COLUMN IF NOT EXISTS reused_from_call_id uuid REFERENCES provider_calls(id);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS provider_calls_active_fingerprint_unique
  ON provider_calls(run_id, request_fingerprint)
  WHERE request_fingerprint IS NOT NULL AND result_status IN ('IN_FLIGHT', 'OK');
