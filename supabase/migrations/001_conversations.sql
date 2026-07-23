-- Conversations table + guardrails
-- Run this in Supabase SQL editor or via supabase db push

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  channel     text        NOT NULL,
  state       text        NOT NULL DEFAULT 'greeting',
  context     jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Prevents duplicate conversations per user+channel and makes .limit(1) deterministic
CREATE UNIQUE INDEX IF NOT EXISTS conversations_user_channel_idx
  ON conversations (user_id, channel);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: enabled with no policies.
-- service_role (used by the NestJS backend) ALWAYS bypasses RLS in Supabase —
-- no policy needed for it to work. With RLS on and no permissive policies,
-- anon/authenticated keys get zero access to this table by default.
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Remove the auto-created allow_all policy if it exists (it grants anon read/write — insecure)
DROP POLICY IF EXISTS allow_all ON conversations;
