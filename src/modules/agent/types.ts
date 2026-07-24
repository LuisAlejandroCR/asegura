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

interface PetDetail {
  name: string;
  age: string;
  breed: string;
}

// Colombian ID document types — not everyone has a CC (cédula de ciudadanía):
// CE = cédula de extranjería, TI = tarjeta de identidad (minors), NIP/NUIP = the
// numbering schemes used for newborns/special cases.
type DocumentType = 'CC' | 'CE' | 'TI' | 'NIP' | 'NUIP';

interface ConversationContext {
  autorizado?: boolean;
  productCategory?: string | null;
  petType?: 'gato' | 'perro' | 'mixto' | null;
  coverage?: string[];
  beneficiaries?: number;
  budget?: number | null;
  quoteProductId?: string;
  shownProductIds?: string[];
  petCount?: number | null;
  pets?: PetDetail[];
  // Set once all pets are collected and the summary is shown, awaiting "sí" or a
  // per-pet correction, before moving on to the human's own cédula/nombre/correo.
  petsAwaitingConfirmation?: boolean;
  cedula?: string;
  documentType?: DocumentType;
  nombre?: string;
  email?: string;
  // Set when the user rejected the DATA_CAPTURE summary without naming which field is
  // wrong — the next message is interpreted as naming it, so only that field resets
  // instead of forcing cédula+nombre+correo to be redone from scratch.
  awaitingCorrectionField?: boolean;
  // Set when the cross-sell offer (vida/accidentes/asistencia, after a pet purchase) was
  // just presented and is explicitly waiting for the user to pick a mode — "uno por uno"
  // or "todas a la vez" — before a specific category is named.
  crossSellOffered?: boolean;
  // Set when the user is buying 2+ products together in one purchase (e.g. "quiero los
  // dos") — each gets its own policy row and PDF, sharing one combined Wompi payment.
  // Falls back to quoteProductId (single) when unset/empty.
  selectedProductIds?: string[];
  policyId?: string;
  policyIds?: string[];
  checkoutUrl?: string;
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

export { ConversationState, ConversationContext, Conversation, PetDetail, DocumentType };