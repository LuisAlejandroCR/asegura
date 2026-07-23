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
    cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
    monthly_premium: 14500, pet_count: null, status: 'pending_payment',
    wompi_link_id: 'link-abc', celo_tx_hash: null,
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

function buildController(overrides: { policy?: Policy | null; celoResult?: { txHash: string | null; celoscanUrl: string | null } } = {}) {
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
  const celo = {
    registerPolicy: jest.fn().mockResolvedValue(overrides.celoResult ?? { txHash: '0xabc', celoscanUrl: 'https://celoscan.io/tx/0xabc' }),
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
    wompi as any, policyService as any, celo as any, conversations as any, telegram as any,
  );

  return { controller, wompi, policyService, celo, conversations, telegram };
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
    const { controller, celo } = buildController({ policy: null });
    const result = await controller.handleWebhook(makeEvent());
    expect(result.status).toBe('ignored');
    expect(celo.registerPolicy).not.toHaveBeenCalled();
  });
});

describe('WompiWebhookController — idempotency', () => {
  it.each(['paid', 'active'])('skips reprocessing when policy.status is already "%s"', async (status) => {
    const { controller, celo, telegram } = buildController({ policy: makePolicy({ status }) });
    const result = await controller.handleWebhook(makeEvent());
    expect(result.status).toBe('already_processed');
    expect(celo.registerPolicy).not.toHaveBeenCalled();
    expect(telegram.sendText).not.toHaveBeenCalled();
  });
});

describe('WompiWebhookController — APPROVED payment', () => {
  it('updates status to paid then active, registers on Celo, and notifies the user', async () => {
    const { controller, policyService, celo, telegram, conversations } = buildController();
    await controller.handleWebhook(makeEvent());

    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', 'paid', expect.anything());
    expect(celo.registerPolicy).toHaveBeenCalledWith('pol-1', expect.stringContaining('pol-1'));
    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', 'active', expect.objectContaining({ celo_tx_hash: '0xabc' }));

    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.POLICY_ISSUED, expect.objectContaining({ celoscanUrl: 'https://celoscan.io/tx/0xabc' }),
    );
    expect(telegram.sendText).toHaveBeenCalledWith('999888777', expect.stringContaining('celoscan.io'));
  });

  it('sends the final PDF (with the real celoscanUrl) as a document', async () => {
    const { controller, policyService, telegram } = buildController();
    await controller.handleWebhook(makeEvent());
    expect(policyService.generateFinalPdf).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pol-1' }), 'https://celoscan.io/tx/0xabc',
    );
    expect(telegram.sendDocument).toHaveBeenCalledWith('999888777', expect.any(Buffer), expect.stringContaining('.pdf'));
  });

  it('still marks the policy active and notifies the user when Celo registration is unavailable', async () => {
    // Celo not configured (registerPolicy returns nulls) must not block payment confirmation
    const { controller, policyService, telegram } = buildController({ celoResult: { txHash: null, celoscanUrl: null } });
    await controller.handleWebhook(makeEvent());
    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', 'active', expect.anything());
    expect(telegram.sendText).toHaveBeenCalled();
  });

  it('does not attempt to send a final PDF when there is no real celoscanUrl', async () => {
    const { controller, policyService } = buildController({ celoResult: { txHash: null, celoscanUrl: null } });
    await controller.handleWebhook(makeEvent());
    expect(policyService.generateFinalPdf).not.toHaveBeenCalled();
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
});

describe('WompiWebhookController — declined/failed payment', () => {
  it.each(['DECLINED', 'VOIDED', 'ERROR'])('updates status and notifies the user on %s, without registering on Celo', async (status) => {
    const { controller, policyService, celo, telegram, conversations } = buildController();
    await controller.handleWebhook(makeEvent({ status }));

    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', status.toLowerCase());
    expect(celo.registerPolicy).not.toHaveBeenCalled();
    expect(telegram.sendText).toHaveBeenCalled();
    // Clears the dead checkoutUrl so the user's next "sí" creates a fresh payment link
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.PAYMENT, expect.objectContaining({ checkoutUrl: undefined }),
    );
  });
});
