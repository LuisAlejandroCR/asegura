// agent.service.completed.spec.ts: what a customer who already bought gets after the sale.
// Every path here used to answer with the purchase confirmation, so "salir" and a stray "1"
// were both told their policy is active.

import { ConversationState } from './types';
import { makeMessage, makeIntent, buildService } from './agent.service.test-helpers';

const ACTIVE_POLICY_TEXT = 'Tu seguro Colsubsidio está activo';

describe('AgentService — leaving after a purchase', () => {
  it('regression — "terminar" says goodbye instead of reporting the policy is active', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { autorizado: true, hasCompletedPurchase: true },
      intent: makeIntent({ abandonIntent: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('terminar'));
    await service.handleMessage({});

    const sent = telegram.sendText.mock.calls[0][1] as string;
    expect(sent).not.toContain(ACTIVE_POLICY_TEXT);
    expect(sent.toLowerCase()).toContain('cierro por aquí');
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.COMPLETED, expect.anything());
  });

  // Same root cause reached from a different place: the person is mid-discovery and only has
  // hasCompletedPurchase from an earlier session, so "salir" answered about that old policy.
  it('regression — "salir" mid-discovery does not report an old policy as the answer', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: { autorizado: true, hasCompletedPurchase: true, serieId: '42' },
      intent: makeIntent({ abandonIntent: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('salir'));
    await service.handleMessage({});

    expect(telegram.sendText.mock.calls[0][1]).not.toContain(ACTIVE_POLICY_TEXT);
  });

  it('someone who never bought still gets the plain abandoned text, not the farewell', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: { autorizado: true },
      intent: makeIntent({ abandonIntent: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('salir'));
    await service.handleMessage({});

    expect(telegram.sendText.mock.calls[0][1]).toContain('Cuando quieras retomar');
  });
});

describe('AgentService — COMPLETED does not answer everything with the receipt', () => {
  it('regression — a stray "1" asks what is needed instead of claiming the policy is active', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.COMPLETED,
      context: { autorizado: true, hasCompletedPurchase: true, purchasedProductIds: ['vida'] },
    });
    telegram.normalize.mockResolvedValue(makeMessage('1'));
    await service.handleMessage({});

    const sent = telegram.sendText.mock.calls[0][1] as string;
    expect(sent).not.toContain(ACTIVE_POLICY_TEXT);
    expect(sent).toContain('No estoy seguro de qué necesitas');
  });

  // The old branch never flagged the turn unclear, so the same text could repeat forever.
  it('three unrecognised messages escalate rather than repeating', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.COMPLETED,
      context: { autorizado: true, hasCompletedPurchase: true, consecutiveUnclearReplies: 2 },
    });
    telegram.normalize.mockResolvedValue(makeMessage('asdfgh'));
    await service.handleMessage({});

    expect(telegram.sendText.mock.calls[0][1]).toContain('líder de servicio');
  });

  it('a real question about the policy still gets a real answer', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.COMPLETED,
      context: { autorizado: true, hasCompletedPurchase: true, purchasedProductIds: ['vida'] },
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿qué cubre mi póliza?'));
    await service.handleMessage({});

    expect(telegram.sendText.mock.calls[0][1]).not.toContain('No estoy seguro de qué necesitas');
  });

  it('"hola" still restarts the conversation', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.COMPLETED,
      context: { autorizado: true, hasCompletedPurchase: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('hola'));
    await service.handleMessage({});

    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.AUTHORIZATION, expect.anything());
  });
});
