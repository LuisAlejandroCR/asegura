-- Policies table + guardrails
-- Run this in Supabase SQL editor or via supabase db push
-- Formalizes the table policy.service.ts has been writing to ad-hoc since Sprint 4.

CREATE TABLE IF NOT EXISTS policies (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid        REFERENCES conversations(id),
  product_id       text        NOT NULL,
  cedula           text        NOT NULL,
  -- Colombian ID type: CC (default), CE, TI, NIP, NUIP — not everyone has a CC
  document_type    text,
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

-- Safe to re-run regardless of the table's actual current shape: CREATE TABLE IF NOT
-- EXISTS is a no-op when the table already exists (e.g. the ad-hoc Sprint 4 table), so
-- every column needs its own defensive ADD COLUMN IF NOT EXISTS — not just the ones
-- added after the fact. Real bug: 'cedula' was missing from the live table because only
-- pet_count/pets/document_type had this safety net, and PostgREST reported "Could not
-- find the 'cedula' column of 'policies' in the schema cache" on every policy insert.
ALTER TABLE policies ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id);
ALTER TABLE policies ADD COLUMN IF NOT EXISTS product_id text;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS cedula text;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS document_type text;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS nombre text;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS monthly_premium numeric NOT NULL DEFAULT 0;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS pet_count integer;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS pets jsonb;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending_payment';
ALTER TABLE policies ADD COLUMN IF NOT EXISTS wompi_link_id text;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS celo_tx_hash text;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE policies ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS policies_conversation_id_idx ON policies (conversation_id);

-- Reuses the update_updated_at() trigger function created in 001_conversations.sql
CREATE TRIGGER policies_updated_at
  BEFORE UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: enabled with no policies — service_role (NestJS backend) bypasses RLS
-- unconditionally; anon/authenticated keys get zero access by default.
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_all ON policies;
