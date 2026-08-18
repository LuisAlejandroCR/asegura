// payments/types.ts: Wompi request/response shapes — payment link params and result, plus
// the webhook event and transaction payloads.

interface CreatePaymentLinkParams {
  policyId: string;
  productName: string;
  amountCOP: number;
  expiresInMinutes?: number;
  // Wompi's real redirect_url. Only the AseguraWeb checkout path sets it — a chat checkout
  // has no page to return to.
  redirectUrl?: string;
}

// Wompi's Payment Links API has no "reference" create-parameter: the transaction's own
// `reference` is auto-generated and unrelated to our policyId. payment_link_id is the link.
interface CreatePaymentLinkResult {
  checkoutUrl: string;
  paymentLinkId: string;
}

interface WompiWebhookEvent {
  event: string;
  data: {
    transaction: {
      id: string;
      reference: string;
      payment_link_id?: string;
      status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';
      amount_in_cents: number;
      payment_method_type: string;
      created_at: string;
    };
  };
  timestamp: number;
  signature: {
    checksum: string;
    // Dotted paths whose VALUES build the checksum. The set can vary per event, so it is
    // always read from here, never hardcoded.
    properties: string[];
  };
}

interface WompiTransactionResult {
  transactionId: string;
  reference: string;
  paymentLinkId: string | null;
  status: string;
  amountInCents: number;
  paymentMethod: string;
  createdAt: string;
}

export { CreatePaymentLinkParams, CreatePaymentLinkResult, WompiWebhookEvent, WompiTransactionResult };
