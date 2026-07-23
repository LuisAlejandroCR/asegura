interface CreatePaymentLinkParams {
  policyId: string;
  productName: string;
  amountCOP: number;
  expiresInMinutes?: number;
}

interface WompiWebhookEvent {
  event: string;
  data: {
    transaction: {
      id: string;
      reference: string;
      status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';
      amount_in_cents: number;
      payment_method_type: string;
      created_at: string;
    };
  };
  timestamp: number;
  signature: {
    checksum: string;
    properties: string;
  };
}

interface WompiTransactionResult {
  transactionId: string;
  reference: string;
  status: string;
  amountInCents: number;
  paymentMethod: string;
  createdAt: string;
}

export { CreatePaymentLinkParams, WompiWebhookEvent, WompiTransactionResult };