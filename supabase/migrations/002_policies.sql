-- Policies table + guardrails
-- Run this in Supabase SQL editor or via supabase db push
-- Formalizes the table policy.service.ts has been writing to ad-hoc since Sprint 4.

CREATE TABLE IF NOT EXISTS policies (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid        REFERENCES conversations(id),
  product_id       text        NOT NULL,
  cedula           text        NOT NULL,
  nombre           text        NOT NULL,
  email            text,
  monthly_premium  numeric     NOT NULL DEFAULT 0,
  -- Number of pets covered (mascotas products are priced per pet); null for non-pet products
  pet_count        integer,
  -- Per-pet identity: [{"name": "Max", "age": "3 años", "breed": "labrador"}, ...]
  pets             jsonb,
  -- pending_payment -> paid -> active (or: declined | voided | error | abandoned)
  status           text        NOT NULL DEFAULT 'pending_payment',
  wompi_link_id    text,
  celo_tx_hash     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Safe to re-run: adds these columns if this migration already ran before they existed.
ALTER TABLE policies ADD COLUMN IF NOT EXISTS pet_count integer;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS pets jsonb;

CREATE INDEX IF NOT EXISTS policies_conversation_id_idx ON policies (conversation_id);

-- Reuses the update_updated_at() trigger function created in 001_conversations.sql
CREATE TRIGGER policies_updated_at
  BEFORE UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: enabled with no policies — service_role (NestJS backend) bypasses RLS
-- unconditionally; anon/authenticated keys get zero access by default.
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_all ON policies;
