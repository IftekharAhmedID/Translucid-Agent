ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS facets jsonb NOT NULL DEFAULT '[]'::jsonb;
-- statement-breakpoint
ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS facet_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
-- statement-breakpoint

-- Claims created before this migration remain valid verification units through
-- one deterministic synthetic facet; new claim creation still requires facets.
UPDATE claims
SET facets = jsonb_build_array(jsonb_build_object(
  'key', 'legacy_claim',
  'label', normalized_claim,
  'materiality', materiality
))
WHERE facets = '[]'::jsonb;
