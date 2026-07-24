import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { WompiWebhookController } from './wompi-webhook.controller';
import { WompiWebhookEvent } from './types';
import { ConversationState } from '../agent/types';
import { Policy } from '../policy/types';

const SECRET = 'secret123';

function makeEvent(overrides: {
  id?: string; status?: string; amount?: number; timestamp?: number; paymentLinkId?: string;
} = {}): WompiWebhookEvent {
  const id = overrides.id ?? 'txn-1';
  const status = overrides.status ?? 'APPROVED';
  const amount = overrides.amount ?? 1450000;
  const timestamp = overrides.timestamp ?? 1700000000;
  const paymentLinkId = overrides.paymentLinkId === undefined ? 'link-abc' : overrides.paymentLinkId;

  const properties = `${id}${status}${amount}`;
  const checksum = createHash('sha256').update(`${properties}${timestamp}${SECRET}`).digest('hex');

  return {
    event: 'transaction.updated',
    timestamp,
    signature: { checksum, properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'] },
    data: {
      transaction: {
        id, status, amount_in_cents: amount,
        reference: 'wompi-auto-ref',
        ...(paymentLinkId !== null ? { payment_link_id: paymentLinkId } : {}),
        payment_method_type: 'CARD',
        created_at: new Date().toISOString(),
      },
    },
  } as any;
}

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: 'pol-1', conversation_id: 'conv-1', product_id: 'asistencia-veterinaria',
    cedula: '123456789', document_type: null, nombre: 'Juan Pérez', email: 'juan@test.com',
    monthly_premium: 14500, pet_count: null, pets: null, status: 'pending_payment',
    wompi_link_id: 'link-abc',
    created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z',
    ...overrides,
  };
}

function makeConversation(overrides: Partial<{ id: string; user_id: string; channel: string; state: ConversationState; context: Record<string, unknown> }> = {}) {
  return {
    id: 'conv-1', user_id: '999888777', channel: 'telegram',
    state: ConversationState.PAYMENT, context: {},
    created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z',
    ...overrides,
  };
}

function buildController(overrides: { policy?: Policy | null } = {}) {
  const wompi = {
    validateWebhookSignature: jest.fn().mockReturnValue(true),
    extractTransactionData: jest.fn((event: WompiWebhookEvent) => ({
      transactionId: event.data.transaction.id,
      reference: event.data.transaction.reference,
      paymentLinkId: event.data.transaction.payment_link_id ?? null,
      status: event.data.transaction.status,
      amountInCents: event.data.transaction.amount_in_cents,
      paymentMethod: event.data.transaction.payment_method_type,
      createdAt: event.data.transaction.created_at,
    })),
  };
  const policyService = {
    findByWompiLinkId: jest.fn().mockResolvedValue(overrides.policy === undefined ? makePolicy() : overrides.policy),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    generateFinalPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')),
  };
  const conversations = {
    findById: jest.fn().mockResolvedValue(makeConversation()),
    saveState: jest.fn().mockResolvedValue(undefined),
  };
  const telegram = {
    sendText: jest.fn().mockResolvedValue(undefined),
    sendDocument: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new WompiWebhookController(
    wompi as any, policyService as any, conversations as any, telegram as any,
  );

  return { controller, wompi, policyService, conversations, telegram };
}

describe('WompiWebhookController — signature validation', () => {
  it('throws UnauthorizedException for an invalid signature', async () => {
    const { controller, wompi } = buildController();
    wompi.validateWebhookSignature.mockReturnValue(false);
    await expect(controller.handleWebhook(makeEvent())).rejects.toThrow(UnauthorizedException);
  });
});

describe('WompiWebhookController — policy resolution (payment_link_id, not reference)', () => {
  it('ignores gracefully when the webhook payload has no payment_link_id', async () => {
    const { controller, policyService } = buildController();
    const result = await controller.handleWebhook(makeEvent({ paymentLinkId: null as any }));
    expect(result.status).toBe('ignored');
    expect(policyService.findByWompiLinkId).not.toHaveBeenCalled();
  });

  it('looks up the policy by payment_link_id, not by the transaction reference', async () => {
    const { controller, policyService } = buildController();
    await controller.handleWebhook(makeEvent({ paymentLinkId: 'link-xyz' }));
    expect(policyService.findByWompiLinkId).toHaveBeenCalledWith('link-xyz');
  });

  it('ignores gracefully when no policy matches the payment_link_id', async () => {
    const { controller } = buildController({ policy: null });
    const result = await controller.handleWebhook(makeEvent());
    expect(result.status).toBe('ignored');
  });
});

describe('WompiWebhookController — idempotency', () => {
  it.each(['paid', 'active'])('skips reprocessing when policy.status is already "%s"', async (status) => {
    const { controller, telegram } = buildController({ policy: makePolicy({ status }) });
    const result = await controller.handleWebhook(makeEvent());
    expect(result.status).toBe('already_processed');
    expect(telegram.sendText).not.toHaveBeenCalled();
  });
});

describe('WompiWebhookController — malformed payload', () => {
  // Regression: extractTransactionData used to destructure event.data.transaction.* with
  // no existence check — an unexpected Wompi event shape (a ping/test event, or a bug on
  // Wompi's side) would throw a raw TypeError instead of a clean, loggable "ignored"
  // response. Signature validation alone can't catch this since it's mocked/independent
  // of payload shape (and even a genuinely-signed event could still be a shape we don't expect).
  it('returns ignored/malformed_payload when data.transaction is missing entirely', async () => {
    const { controller, policyService } = buildController();
    const malformed = {
      event: 'ping', timestamp: 123, signature: { checksum: 'x', properties: [] }, data: {},
    } as any;
    await expect(controller.handleWebhook(malformed)).resolves.toEqual({ status: 'ignored', reason: 'malformed_payload' });
    expect(policyService.findByWompiLinkId).not.toHaveBeenCalled();
  });

  it('returns ignored/malformed_payload when transaction.status is missing', async () => {
    const { controller, policyService } = buildController();
    const malformed = {
      event: 'transaction.updated', timestamp: 123, signature: { checksum: 'x', properties: [] },
      data: { transaction: { id: 'txn-1', payment_link_id: 'link-abc' } },
    } as any;
    await expect(controller.handleWebhook(malformed)).resolves.toEqual({ status: 'ignored', reason: 'malformed_payload' });
    expect(policyService.findByWompiLinkId).not.toHaveBeenCalled();
  });
});

describe('WompiWebhookController — APPROVED payment', () => {
  it('updates status to paid then active, and notifies the user', async () => {
    const { controller, policyService, telegram, conversations } = buildController();
    await controller.handleWebhook(makeEvent());

    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', 'paid', expect.anything());
    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', 'active');

    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.POLICY_ISSUED, expect.objectContaining({ policyId: 'pol-1' }),
    );
    expect(telegram.sendText).toHaveBeenCalledWith('999888777', expect.stringContaining('activo'));
  });

  // Regression: the PDF used to be gated on a real celoscanUrl being present — now that
  // Celo registration is gone, this is the ONLY PDF the user will ever receive (the draft
  // sent before payment was removed in an earlier fix), so it must send unconditionally.
  it('regression — always sends the final PDF on approval, with no blockchain step in between', async () => {
    const { controller, policyService, telegram } = buildController();
    await controller.handleWebhook(makeEvent());
    expect(policyService.generateFinalPdf).toHaveBeenCalledWith(expect.objectContaining({ id: 'pol-1' }));
    expect(telegram.sendDocument).toHaveBeenCalledWith('999888777', expect.any(Buffer), expect.stringContaining('.pdf'));
  });

  it('does not throw when the policy has no linked conversation', async () => {
    const { controller } = buildController({ policy: makePolicy({ conversation_id: null }) });
    await expect(controller.handleWebhook(makeEvent())).resolves.toBeDefined();
  });

  it('does not throw when the conversation lookup returns nothing', async () => {
    const { controller, conversations } = buildController();
    conversations.findById.mockResolvedValue(null);
    await expect(controller.handleWebhook(makeEvent())).resolves.toBeDefined();
  });

  it('does not throw and skips the PDF when generateFinalPdf returns null', async () => {
    const { controller, policyService, telegram } = buildController();
    policyService.generateFinalPdf.mockResolvedValue(null);
    await expect(controller.handleWebhook(makeEvent())).resolves.toBeDefined();
    expect(telegram.sendDocument).not.toHaveBeenCalled();
  });
});

describe('WompiWebhookController — declined/failed payment', () => {
  it.each(['DECLINED', 'VOIDED', 'ERROR'])('updates status and notifies the user on %s, without issuing a policy', async (status) => {
    const { controller, policyService, telegram, conversations } = buildController();
    await controller.handleWebhook(makeEvent({ status }));

    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', status.toLowerCase());
    expect(telegram.sendText).toHaveBeenCalled();
    // Clears the dead checkoutUrl so the user's next "sí" creates a fresh payment link
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.PAYMENT, expect.objectContaining({ checkoutUrl: undefined }),
    );
  });
});
