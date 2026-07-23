-- Sprint 4: policies table
-- Run this in Supabase SQL Editor before starting Sprint 4

CREATE TABLE IF NOT EXISTS policies (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid        REFERENCES conversations(id),
  serie            text,                          -- CSV SERIE only — never NOMBRE_COMPLETO (Ley 1581)
  product_id       text        NOT NULL,
  cedula           text        NOT NULL,
  nombre           text        NOT NULL,
  email            text,
  monthly_premium  integer     NOT NULL,
  status           text        NOT NULL DEFAULT 'pending_payment',
  pdf_url          text,
  wompi_link_id    text,
  celo_tx_hash     text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policies_conversation_id_idx ON policies(conversation_id);
CREATE INDEX IF NOT EXISTS policies_status_idx ON policies(status);
