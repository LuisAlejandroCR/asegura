-- Leads: quién se fue antes de quedar asegurado, para que una persona lo llame de vuelta.
-- Hasta ahora una salida por "Terminar" solo dejaba la conversación en ABANDONED, y nadie
-- consulta un estado: el seguimiento comercial no tenía de dónde salir.
--
-- Deliberadamente NO guarda las respuestas de aseguramiento. Son datos de salud —categoría
-- sensible bajo la Ley 1581, con un estándar más alto— y para devolver una llamada no hacen
-- falta. Aquí solo va lo que necesita quien marca el teléfono.

CREATE TABLE IF NOT EXISTS leads (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid        REFERENCES conversations(id),
  user_id          text        NOT NULL,
  channel          text        NOT NULL,
  -- Hasta dónde llegó antes de irse: un lead en QUOTE_PRESENTED vale más que uno en GREETING.
  last_state       text        NOT NULL,
  -- web_session_ended (pulsó "Terminar") | no_response | insufficient_info
  reason           text        NOT NULL,
  product_category text,
  quote_product_id text,
  nombre           text,
  cedula           text,
  document_type    text,
  email            text,
  phone            text,
  -- pending -> contacted -> closed
  status           text        NOT NULL DEFAULT 'pending',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Mismo patrón defensivo que 002_policies.sql: CREATE TABLE IF NOT EXISTS no toca una tabla
-- que ya exista, así que cada columna necesita su propio ADD COLUMN IF NOT EXISTS.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_state text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_category text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS quote_product_id text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS nombre text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS cedula text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS document_type text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- La consulta que hace quien llama: los pendientes, primero los más recientes.
CREATE INDEX IF NOT EXISTS leads_status_created_at_idx ON leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_conversation_id_idx ON leads (conversation_id);

-- Una salida por conversación: pulsar "Terminar" dos veces no son dos personas a quien llamar.
CREATE UNIQUE INDEX IF NOT EXISTS leads_conversation_id_uniq ON leads (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- Reusa update_updated_at() de 001_conversations.sql
DROP TRIGGER IF EXISTS leads_updated_at ON leads;
CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS activo sin políticas: service_role (el backend) la salta; anon/authenticated no ven nada.
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_all ON leads;
