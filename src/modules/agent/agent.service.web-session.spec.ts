// agent.service.web-session.spec.ts: AgentService.handleWebMessage — the AseguraWeb
// (texto.html/voz.html) entry point. Unlike handleMessage (Telegram/WhatsApp, dispatches
// through an IChannelAdapter), this returns the reply as a WebReply object the
// web-session.controller.ts sends back as JSON. Reuses the same computeReply core, so a
// web-originated message must land on the EXACT SAME conversation as the chat it was
// linked from — never a separate "web channel" row.

import { buildService, makeConversation } from './agent.service.test-helpers';
import { ConversationState } from './types';

describe('AgentService.handleWebMessage — conversation resolution', () => {
  it('throws when the conversationId does not resolve to a real conversation', async () => {
    const { service, conversations } = buildService();
    conversations.findById.mockResolvedValue(null);
    await expect(service.handleWebMessage('missing-conv', { text: 'hola' })).rejects.toThrow();
  });

  it('resolves via the conversation\'s OWN channel/userId — never a separate web channel', async () => {
    const { service, conversations } = buildService({ state: ConversationState.DISCOVERY });
    conversations.findById.mockResolvedValue(makeConversation(ConversationState.DISCOVERY, {}));
    await service.handleWebMessage('conv-1', { text: 'quiero un seguro' });
    // getOrCreate is computeReply's conversation-resolution call — must be called with the
    // ORIGINAL telegram userId/channel from findById's result, not 'web'/conversationId.
    expect(conversations.getOrCreate).toHaveBeenCalledWith('u1', 'telegram');
  });

  it('attaches a synthetic contact on every message — same pattern as WhatsApp\'s WaId (twilio-whatsapp-adapter.service.ts)', async () => {
    // No browser equivalent of Telegram's request_contact button exists, so a web session
    // proves phone possession the same way WhatsApp does: the channel adapter attaches
    // `contact` unconditionally, and AgentService's EXISTING phoneVerified gate (built for
    // Telegram, already reused as-is by WhatsApp) picks it up — no new special-casing.
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { awaitingPhoneVerification: true },
    });
    conversations.findById.mockResolvedValue(
      makeConversation(ConversationState.DATA_CAPTURE, { awaitingPhoneVerification: true }),
    );
    await service.handleWebMessage('conv-1', { text: 'hola' });
    const saveStateCalls = conversations.saveState.mock.calls;
    const verifiedWrite = saveStateCalls.some(([, , ctx]: any[]) => ctx?.phoneVerified === true && ctx?.awaitingSelfie === true);
    expect(verifiedWrite).toBe(true);
  });
});

describe('AgentService.handleWebMessage — WebReply shape', () => {
  it('returns texts, state and progress on every reply', async () => {
    const { service, conversations } = buildService({ state: ConversationState.DISCOVERY });
    conversations.findById.mockResolvedValue(makeConversation(ConversationState.DISCOVERY, {}));
    const reply = await service.handleWebMessage('conv-1', { text: 'hola' });
    expect(typeof reply.state).toBe('string');
    expect(reply.progress.totalSteps).toBeGreaterThan(0);
    expect(Array.isArray(reply.texts)).toBe(true);
  });

  it('sets expectedInput to selfie the turn phone verification completes (mirrors WhatsApp\'s own 2-turn flow)', async () => {
    // Same scenario as the "attaches a synthetic contact" test above — the CONSEQUENCE
    // this time is what texto.html actually reads to decide which input control to show.
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { awaitingPhoneVerification: true },
    });
    conversations.findById.mockResolvedValue(
      makeConversation(ConversationState.DATA_CAPTURE, { awaitingPhoneVerification: true }),
    );
    const reply = await service.handleWebMessage('conv-1', { text: 'hola' });
    expect(reply.expectedInput).toBe('selfie');
  });

  it('defaults expectedInput to text otherwise', async () => {
    const { service, conversations } = buildService({ state: ConversationState.DISCOVERY });
    conversations.findById.mockResolvedValue(makeConversation(ConversationState.DISCOVERY, {}));
    const reply = await service.handleWebMessage('conv-1', { text: 'hola' });
    expect(reply.expectedInput).toBe('text');
  });

  it('surfaces checkoutUrl when the conversation context carries one', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.PAYMENT,
      context: { checkoutUrl: 'https://checkout.wompi.co/l/abc', phoneVerified: true },
    });
    conversations.findById.mockResolvedValue(
      makeConversation(ConversationState.PAYMENT, { checkoutUrl: 'https://checkout.wompi.co/l/abc', phoneVerified: true }),
    );
    const reply = await service.handleWebMessage('conv-1', { text: 'listo' });
    expect(reply.checkoutUrl).toBe('https://checkout.wompi.co/l/abc');
  });

  it('attaches a structured quote when QUOTE_PRESENTED and a product is set', async () => {
    const { service, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: 'accidentes-personales', phoneVerified: true },
    });
    conversations.findById.mockResolvedValue(
      makeConversation(ConversationState.QUOTE_PRESENTED, { quoteProductId: 'accidentes-personales', phoneVerified: true }),
    );
    quoting.score.mockReturnValue([
      { productId: 'accidentes-personales', matchScore: 10, reasons: ['porque sí'], monthlyPremium: 18000, priority: 'high' },
    ]);
    // Neutral "tell me more" message — matches MORE_INFO_PATTERN, re-explains the current
    // product and stays in QUOTE_PRESENTED, unlike an affirmative/negative reply which
    // would transition state (and correctly stop attaching `quote`, since the page moves
    // on to the resumen/checkout sheet built from THAT next state's own data instead).
    const reply = await service.handleWebMessage('conv-1', { text: 'cuéntame más sobre esto' });
    expect(reply.quote).toBeDefined();
    expect(reply.quote?.precioMensual).toBe(18000);
    expect(reply.quote?.razon).toBe('porque sí');
  });
});
