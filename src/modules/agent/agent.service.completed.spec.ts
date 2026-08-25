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

// Reported from a live chat: the person typed "no recibe audio" — a complaint that the web
// page was broken — and got a full quote back. The message never reached a handler that
// could recognise it, so it fell through to the quote gate.
describe('AgentService — a broken channel is not a buying signal', () => {
  it.each([
    'no recibe audio',
    'no se escucha nada',
    'la página no carga',
    'el link no funciona',
    'no funciona',
    'se queda cargando',
    'no me deja entrar',
  ])('answers the complaint instead of quoting: %s', async (complaint) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { autorizado: true, productCategory: 'mascotas', petCount: 3 },
    });
    telegram.normalize.mockResolvedValue(makeMessage(complaint));
    await service.handleMessage({});

    const sent = telegram.sendText.mock.calls[0][1] as string;
    expect(sent).not.toContain('Tu cotización personalizada');
    expect(sent).toContain('Sigamos aquí en el chat');
    // A complaint must not advance the sale.
    expect(conversations.saveState).not.toHaveBeenCalledWith('conv-1', ConversationState.QUOTE_PRESENTED, expect.anything());
  });

  // Reported from a live chat: the complaint reply promises "dime y te mando otro enlace", and
  // nothing honored it. "genera otro enlace" fell through as an unclear reply, and the third
  // one tripped the circuit breaker and escalated the person to a human — which is exactly the
  // self-service flow failing on a request the agent had just invited.
  describe('and the link it promises actually arrives', () => {
    const withWebApp = (built: ReturnType<typeof buildService>) => {
      built.config.get.mockImplementation((key: string) =>
        key === 'WEB_APP_URL' ? 'https://asegura.example' : undefined,
      );
      return built;
    };

    it.each([
      'genera otro enlace',
      'dame otro link para hablar',
      'mándame la página otra vez',
      'reenvíame el enlace',
      'pásame el link',
    ])('sends a fresh link instead of failing to understand: %s', async (ask) => {
      const { service, telegram } = withWebApp(
        buildService({ state: ConversationState.DISCOVERY, context: { autorizado: true } }),
      );
      telegram.normalize.mockResolvedValue(makeMessage(ask));
      await service.handleMessage({});

      const sent = telegram.sendText.mock.calls.map((c: unknown[]) => String(c[1])).join(' | ');
      expect(sent).toContain('https://asegura.example');
    });

    it('honours the modality asked for, not the one stored', async () => {
      const { service, telegram } = withWebApp(
        buildService({
          state: ConversationState.DISCOVERY,
          context: { autorizado: true, webModality: 'texto' },
        }),
      );
      telegram.normalize.mockResolvedValue(makeMessage('dame otro link para hablar'));
      await service.handleMessage({});

      expect(String(telegram.sendText.mock.calls[0][1])).toContain('voz.html');
    });

    it('repeats the previous modality when the ask names neither', async () => {
      const { service, telegram } = withWebApp(
        buildService({
          state: ConversationState.DISCOVERY,
          context: { autorizado: true, webModality: 'voz' },
        }),
      );
      telegram.normalize.mockResolvedValue(makeMessage('genera otro enlace'));
      await service.handleMessage({});

      expect(String(telegram.sendText.mock.calls[0][1])).toContain('voz.html');
    });

    // Someone mid-sale asking for the link must not be rewound to the start.
    it('does not send the conversation back to DISCOVERY', async () => {
      const { service, telegram, conversations } = withWebApp(
        buildService({
          state: ConversationState.QUOTE_PRESENTED,
          context: { autorizado: true, productCategory: 'vida', quoteProductId: 'vida' },
        }),
      );
      telegram.normalize.mockResolvedValue(makeMessage('genera otro enlace'));
      await service.handleMessage({});

      expect(conversations.saveState).not.toHaveBeenCalledWith('conv-1', ConversationState.DISCOVERY, expect.anything());
    });

    // The payment link is a different object reached by a different flow, and the phrasing
    // overlaps word for word.
    it.each(['mándame el link de pago', 'reenvíame el enlace para pagar'])(
      'never hijacks a payment-link request: %s',
      async (ask) => {
        const { service, telegram } = withWebApp(
          buildService({ state: ConversationState.DISCOVERY, context: { autorizado: true } }),
        );
        telegram.normalize.mockResolvedValue(makeMessage(ask));
        await service.handleMessage({});

        const sent = telegram.sendText.mock.calls.map((c: unknown[]) => String(c[1])).join(' | ');
        expect(sent).not.toContain('aquí tienes uno nuevo');
      },
    );

    // A complaint is broader than an ask and must keep its own answer.
    it('"el enlace no funciona" is still a complaint, not a request', async () => {
      const { service, telegram } = withWebApp(
        buildService({ state: ConversationState.DISCOVERY, context: { autorizado: true } }),
      );
      telegram.normalize.mockResolvedValue(makeMessage('el enlace no funciona'));
      await service.handleMessage({});

      expect(String(telegram.sendText.mock.calls[0][1])).toContain('Sigamos aquí en el chat');
    });

    // Without WEB_APP_URL there is no page to send anyone to; promising one would be a 404.
    it('falls through instead of promising a link when WEB_APP_URL is unset', async () => {
      const { service, telegram } = buildService({
        state: ConversationState.DISCOVERY,
        context: { autorizado: true },
      });
      telegram.normalize.mockResolvedValue(makeMessage('genera otro enlace'));
      await service.handleMessage({});

      const sent = telegram.sendText.mock.calls.map((c: unknown[]) => String(c[1])).join(' | ');
      expect(sent).not.toContain('aquí tienes uno nuevo');
    });
  });

  // The reason the detector needs a technical subject: this phrase is a rejection of the
  // quote, not a bug report, and it must keep reaching the alternatives flow.
  it('"no me sirve" about a quote is NOT treated as a complaint', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { autorizado: true, productCategory: 'vida', quoteProductId: 'vida' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no me sirve, muéstrame otra'));
    await service.handleMessage({});

    // The alternatives path may reply through a different send method, so assert on
    // everything that went out: had the complaint branch fired, its text would be here.
    const sent = telegram.sendText.mock.calls.map((c: unknown[]) => String(c[1])).join(' | ');
    expect(sent).not.toContain('Sigamos aquí en el chat');
  });

  it('an ordinary discovery answer still quotes', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: { autorizado: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero un seguro de vida'));
    await service.handleMessage({});

    expect(telegram.sendText.mock.calls[0][1]).not.toContain('Sigamos aquí en el chat');
  });
});
