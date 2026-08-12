// wompi-webhook.controller.spec.ts: tests the payment webhook — signature rejection,
// resolving the policy by payment_link_id (not the transaction reference),
// idempotency on repeat deliveries, and graceful handling of malformed payloads.

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

function buildController(overrides: { policies?: Policy[] } = {}) {
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
    findAllByWompiLinkId: jest.fn().mockResolvedValue(overrides.policies ?? [makePolicy()]),
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
    sendAnimation: jest.fn().mockResolvedValue(undefined),
  };
  // The fixture conversation's channel is 'telegram' (see makeConversation above), so
  // resolving through the registry returns this same mock every existing assertion expects.
  const channels = {
    get: jest.fn().mockReturnValue(telegram),
  };
  const reminders = {
    schedule: jest.fn(),
    cancel: jest.fn(),
  };

  const controller = new WompiWebhookController(
    wompi as any, policyService as any, conversations as any, channels as any, reminders as any,
  );

  return { controller, wompi, policyService, conversations, telegram, channels, reminders };
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
    expect(policyService.findAllByWompiLinkId).not.toHaveBeenCalled();
  });

  it('looks up the policy by payment_link_id, not by the transaction reference', async () => {
    const { controller, policyService } = buildController();
    await controller.handleWebhook(makeEvent({ paymentLinkId: 'link-xyz' }));
    expect(policyService.findAllByWompiLinkId).toHaveBeenCalledWith('link-xyz');
  });

  it('ignores gracefully when no policy matches the payment_link_id', async () => {
    const { controller } = buildController({ policies: [] });
    const result = await controller.handleWebhook(makeEvent());
    expect(result.status).toBe('ignored');
  });
});

describe('WompiWebhookController — idempotency', () => {
  it.each(['paid', 'active'])('skips reprocessing when policy.status is already "%s"', async (status) => {
    const { controller, telegram } = buildController({ policies: [makePolicy({ status })] });
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
    expect(policyService.findAllByWompiLinkId).not.toHaveBeenCalled();
  });

  it('returns ignored/malformed_payload when transaction.status is missing', async () => {
    const { controller, policyService } = buildController();
    const malformed = {
      event: 'transaction.updated', timestamp: 123, signature: { checksum: 'x', properties: [] },
      data: { transaction: { id: 'txn-1', payment_link_id: 'link-abc' } },
    } as any;
    await expect(controller.handleWebhook(malformed)).resolves.toEqual({ status: 'ignored', reason: 'malformed_payload' });
    expect(policyService.findAllByWompiLinkId).not.toHaveBeenCalled();
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

  // 2026-07-24 feedback: the real Wompi payment approval — the actual "successfully
  // paid" moment — gets the same branded success-checkmark video as the selfie and
  // Tarjeta Colsubsidio moments.
  it('sends the branded success animation on approval', async () => {
    const { controller, telegram } = buildController();
    await controller.handleWebhook(makeEvent());
    expect(telegram.sendAnimation).toHaveBeenCalledWith('999888777', expect.stringContaining('payment-received.mp4'));
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
    const { controller } = buildController({ policies: [makePolicy({ conversation_id: null })] });
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

describe('WompiWebhookController — post-purchase cross-sell (2026-07-24 "restore the flow")', () => {
  // The mid-quote cross-sell interruption was removed from AgentService — a purchase now
  // always completes (payment + PDF) before anything else is offered. This is where that
  // "something else" gets offered: once the policy is issued, the agent follows up with
  // either the SPECIFIC category the user showed interest in earlier (context.pendingCrossSell,
  // set by deferCrossSell) or a generic "want something else?" prompt, then transitions to
  // DISCOVERY so the very next message starts a genuinely new, separate purchase.
  it('offers the specific deferred category and pre-seeds it in the new DISCOVERY context', async () => {
    const { controller, telegram, conversations } = buildController();
    conversations.findById.mockResolvedValue(makeConversation({ context: { pendingCrossSell: 'vida' } }));
    await controller.handleWebhook(makeEvent());

    expect(telegram.sendText).toHaveBeenCalledWith('999888777', expect.stringContaining('vida'));
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.objectContaining({ productCategory: 'vida' }),
    );
  });

  // Real live-test bug: conversations that had already completed a real, Wompi-approved
  // purchase ended up with conversations.state = 'abandoned' after the customer later
  // declined to buy anything more — neither policyId/policyIds (purchase-specific, reset
  // for the next one) nor awaitingCrossSellResponse (a one-shot flag) survive long enough
  // to tell a LATER abandonIntent check "this person already bought something". This durable
  // flag must be set once, permanently, on every real payment approval.
  it('sets hasCompletedPurchase: true in the new post-purchase DISCOVERY context', async () => {
    const { controller, conversations } = buildController();
    conversations.findById.mockResolvedValue(makeConversation({ context: {} }));
    await controller.handleWebhook(makeEvent());

    const discoveryCall = conversations.saveState.mock.calls.find((c: any[]) => c[1] === ConversationState.DISCOVERY);
    expect(discoveryCall?.[2]).toEqual(expect.objectContaining({ hasCompletedPurchase: true }));
  });

  // 2026-07-25 feature request: the post-purchase cross-sell offer ("¿Quieres proteger
  // algo más?") is sent from this webhook, not from a Telegram message — AgentService's
  // own reminder scheduling in handleMessage never runs for it, so this is the other
  // place that must arm the 30s "come back to chat" reminder.
  it('schedules a 30s reminder after sending the post-purchase cross-sell offer', async () => {
    const { controller, conversations, reminders } = buildController();
    conversations.findById.mockResolvedValue(makeConversation({ context: {} }));
    await controller.handleWebhook(makeEvent());
    expect(reminders.schedule).toHaveBeenCalledWith('conv-1', '999888777');
  });

  it('offers a generic follow-up and leaves productCategory unset when nothing was deferred', async () => {
    const { controller, telegram, conversations } = buildController();
    conversations.findById.mockResolvedValue(makeConversation({ context: {} }));
    await controller.handleWebhook(makeEvent());

    expect(telegram.sendText).toHaveBeenCalledWith('999888777', expect.stringContaining('algo más'));
    const discoveryCall = conversations.saveState.mock.calls.find((c: any[]) => c[1] === ConversationState.DISCOVERY);
    expect(discoveryCall?.[2].productCategory).toBeUndefined();
  });

  it('preserves identity (cédula, nombre, correo) but clears product-specific fields in the new DISCOVERY context', async () => {
    const { controller, conversations } = buildController();
    conversations.findById.mockResolvedValue(makeConversation({
      context: {
        cedula: '123456789', documentType: 'CC', nombre: 'Juan Pérez', email: 'juan@test.com',
        productCategory: 'mascotas', quoteProductId: 'asistencia-veterinaria', petCount: 2,
      },
    }));
    await controller.handleWebhook(makeEvent());

    const discoveryCall = conversations.saveState.mock.calls.find((c: any[]) => c[1] === ConversationState.DISCOVERY);
    expect(discoveryCall?.[2]).toEqual(expect.objectContaining({
      cedula: '123456789', documentType: 'CC', nombre: 'Juan Pérez', email: 'juan@test.com',
    }));
    expect(discoveryCall?.[2].quoteProductId).toBeUndefined();
    expect(discoveryCall?.[2].petCount).toBeUndefined();
  });

  // 2026-07-24 KYC feedback: phone verification (Telegram's native contact-share button)
  // is a one-time identity check, not a per-purchase one — a returning customer buying a
  // second product in the same conversation must not be asked to re-verify.
  it('preserves phoneVerified/verifiedPhone into the new DISCOVERY context, same as identity fields', async () => {
    const { controller, conversations } = buildController();
    conversations.findById.mockResolvedValue(makeConversation({
      context: {
        cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
        phoneVerified: true, verifiedPhone: '+573001234567',
      },
    }));
    await controller.handleWebhook(makeEvent());

    const discoveryCall = conversations.saveState.mock.calls.find((c: any[]) => c[1] === ConversationState.DISCOVERY);
    expect(discoveryCall?.[2]).toEqual(expect.objectContaining({
      phoneVerified: true, verifiedPhone: '+573001234567',
    }));
  });

  // Same reasoning as phoneVerified — the cosmetic selfie step is also a one-time
  // identity confirmation, not a per-purchase one.
  it('preserves selfieProvided into the new DISCOVERY context, same as phoneVerified', async () => {
    const { controller, conversations } = buildController();
    conversations.findById.mockResolvedValue(makeConversation({
      context: {
        cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
        phoneVerified: true, verifiedPhone: '+573001234567', selfieProvided: true,
      },
    }));
    await controller.handleWebhook(makeEvent());

    const discoveryCall = conversations.saveState.mock.calls.find((c: any[]) => c[1] === ConversationState.DISCOVERY);
    expect(discoveryCall?.[2]).toEqual(expect.objectContaining({ selfieProvided: true }));
  });
});

describe('WompiWebhookController — multi-product purchase (one payment, several policies)', () => {
  // Real feature: "quiero los dos" issues one policy per product, all sharing one
  // combined Wompi payment link — the webhook must settle every one of them, not just
  // the first match.
  it('updates every policy sharing the payment link to paid then active', async () => {
    const policies = [
      makePolicy({ id: 'pol-1', product_id: 'vida-pan-american' }),
      makePolicy({ id: 'pol-2', product_id: 'asistencia-veterinaria' }),
    ];
    const { controller, policyService } = buildController({ policies });
    await controller.handleWebhook(makeEvent());

    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', 'paid', expect.anything());
    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', 'active');
    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-2', 'paid', expect.anything());
    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-2', 'active');
  });

  it('sends one PDF per policy and a single combined confirmation message', async () => {
    const policies = [
      makePolicy({ id: 'pol-1', product_id: 'vida-pan-american' }),
      makePolicy({ id: 'pol-2', product_id: 'asistencia-veterinaria' }),
    ];
    const { controller, policyService, telegram } = buildController({ policies });
    await controller.handleWebhook(makeEvent());

    expect(policyService.generateFinalPdf).toHaveBeenCalledWith(expect.objectContaining({ id: 'pol-1' }));
    expect(policyService.generateFinalPdf).toHaveBeenCalledWith(expect.objectContaining({ id: 'pol-2' }));
    expect(telegram.sendDocument).toHaveBeenCalledTimes(2);
    // One combined confirmation message + one post-purchase cross-sell follow-up.
    expect(telegram.sendText).toHaveBeenCalledTimes(2);
    expect(telegram.sendText).toHaveBeenCalledWith('999888777', expect.stringContaining('2 pólizas'));
  });

  // 2026-07-24 gamification feedback: same celebratory personalization as the
  // single-policy STATE_RESPONSES[POLICY_ISSUED] message.
  it('regression — the multi-policy confirmation is also personalized with name and pet names', async () => {
    const policies = [
      makePolicy({ id: 'pol-1', product_id: 'vida-pan-american' }),
      makePolicy({ id: 'pol-2', product_id: 'asistencia-veterinaria' }),
    ];
    const { controller, telegram, conversations } = buildController({ policies });
    conversations.findById.mockResolvedValue(makeConversation({
      context: {
        nombre: 'Juan Pérez',
        pets: [{ name: 'Ramón', age: '3 años', breed: 'Doberman' }, { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' }],
      },
    }));
    await controller.handleWebhook(makeEvent());

    const confirmCall = telegram.sendText.mock.calls.find((c: any[]) => c[1].includes('2 pólizas'));
    expect(confirmCall?.[1]).toContain('Juan');
    expect(confirmCall?.[1]).toContain('Ramón y Pancha');
  });

  it('saves policyIds (plural) alongside the single policyId for backward compatibility', async () => {
    const policies = [
      makePolicy({ id: 'pol-1', product_id: 'vida-pan-american' }),
      makePolicy({ id: 'pol-2', product_id: 'asistencia-veterinaria' }),
    ];
    const { controller, conversations } = buildController({ policies });
    await controller.handleWebhook(makeEvent());

    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.POLICY_ISSUED,
      expect.objectContaining({ policyId: 'pol-1', policyIds: ['pol-1', 'pol-2'] }),
    );
  });

  it('idempotency — only settles the still-pending policy when one of the two was already processed', async () => {
    // Guards against a partial-retry scenario: Wompi redelivers the webhook, one policy
    // in the bundle already transitioned but the other didn't (e.g. a crash mid-loop).
    const policies = [
      makePolicy({ id: 'pol-1', product_id: 'vida-pan-american', status: 'active' }),
      makePolicy({ id: 'pol-2', product_id: 'asistencia-veterinaria', status: 'pending_payment' }),
    ];
    const { controller, policyService } = buildController({ policies });
    const result = await controller.handleWebhook(makeEvent());

    expect(result.status).toBe('processed');
    expect(policyService.updateStatus).not.toHaveBeenCalledWith('pol-1', 'paid', expect.anything());
    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-2', 'paid', expect.anything());
  });

  it('idempotency — skips entirely when every policy in the bundle is already processed', async () => {
    const policies = [
      makePolicy({ id: 'pol-1', product_id: 'vida-pan-american', status: 'active' }),
      makePolicy({ id: 'pol-2', product_id: 'asistencia-veterinaria', status: 'paid' }),
    ];
    const { controller, policyService, telegram } = buildController({ policies });
    const result = await controller.handleWebhook(makeEvent());

    expect(result.status).toBe('already_processed');
    expect(policyService.updateStatus).not.toHaveBeenCalled();
    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('a declined payment marks every policy in the bundle declined and sends one notification', async () => {
    const policies = [
      makePolicy({ id: 'pol-1', product_id: 'vida-pan-american' }),
      makePolicy({ id: 'pol-2', product_id: 'asistencia-veterinaria' }),
    ];
    const { controller, policyService, telegram } = buildController({ policies });
    await controller.handleWebhook(makeEvent({ status: 'DECLINED' }));

    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-1', 'declined');
    expect(policyService.updateStatus).toHaveBeenCalledWith('pol-2', 'declined');
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
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
