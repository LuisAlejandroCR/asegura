enum ConversationState {
  GREETING = 'greeting',
  AUTHORIZATION = 'authorization',
  DISCOVERY = 'discovery',
  QUOTING = 'quoting',
  QUOTE_PRESENTED = 'quote_presented',
  DATA_CAPTURE = 'data_capture',
  PAYMENT = 'payment',
  POLICY_ISSUED = 'policy_issued',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned',
  REJECTED = 'rejected',
}

interface ConversationContext {
  autorizado?: boolean;
  productCategory?: string | null;
  coverage?: string[];
  beneficiaries?: number;
  budget?: number | null;
  quoteProductId?: string;
  cedula?: string;
  nombre?: string;
  email?: string;
}

interface Conversation {
  id: string;
  user_id: string;
  channel: string;
  state: ConversationState;
  context: ConversationContext;
  created_at: string;
  updated_at: string;
}

export { ConversationState, ConversationContext, Conversation };