// agent.service.web-modality.spec.ts: with WEB_APP_URL configured, the agent asks "¿hablar o
// escribir?" before the F01 buttons and sends a signed AseguraWeb link. Unset, behavior must stay
// byte-for-byte identical to before the feature.

import { buildService } from './agent.service.test-helpers';
import { ConversationState } from './types';

function withWebAppUrl(config: { get: jest.Mock }) {
  config.get.mockImplementation((key: string) =>
    key === 'WEB_APP_URL' ? 'https://asegura-app.vercel.app' : undefined,
  );
}

describe('AUTHORIZATION → DISCOVERY entry — WEB_APP_URL unset (default)', () => {
  // F01 is only sent on the SAME turn as "sí" for a returning affiliate whose serieId is
  // already known (the "Ya te habías afiliado..." shortcut) — a fresh user is asked for
  // their affiliate ID first (existing, unrelated behavior, unchanged by this feature).
  it('sends F01 category choices immediately for a known returning affiliate — no modality question', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { serieId: '12345' },
      intent: { productCategory: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: true, isNegative: false, wantsAlternative: false, petResolution: null },
    });
    await service.handleMessage({});
    expect(telegram.sendChoices).toHaveBeenCalled();
    const [, , choices] = telegram.sendChoices.mock.calls[0];
    expect(choices).toContain('❤️ Mi familia');
  });
});

describe('AUTHORIZATION → DISCOVERY entry — WEB_APP_URL configured', () => {
  it('asks hablar/escribir instead of showing F01 immediately, for the same known-affiliate shortcut', async () => {
    const { service, telegram, config } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { serieId: '12345' },
      intent: { productCategory: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: true, isNegative: false, wantsAlternative: false, petResolution: null },
    });
    withWebAppUrl(config);
    await service.handleMessage({});
    expect(telegram.sendChoices).toHaveBeenCalled();
    const [, , choices] = telegram.sendChoices.mock.calls[0];
    expect(choices.join(' ')).toMatch(/hablar/i);
    expect(choices.join(' ')).toMatch(/escribir/i);
    expect(choices).not.toContain('❤️ Mi familia');
  });

  it('"hablar" sends the voz.html link with a real token and falls back to no-op state (no crash) when the reply is a plain text', async () => {
    const { service, telegram, conversations, config } = buildService({
      state: ConversationState.DISCOVERY,
      context: { awaitingWebModalityChoice: true },
      intent: { productCategory: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({ id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DISCOVERY, context: { awaitingWebModalityChoice: true } });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'quiero hablar', timestamp: new Date() });
    await service.handleMessage({});
    expect(telegram.sendText).toHaveBeenCalled();
    const [, sentText] = telegram.sendText.mock.calls[0];
    expect(sentText).toContain('voz.html');
  });

  // El aviso de "¿sigues ahí?" salía 60 s después de mandar el link, o sea mientras la persona
  // estaba hablando en AseguraWeb: el traspaso es una ausencia buscada, igual que el checkout.
  it('no programa el aviso cuando acaba de pasar a AseguraWeb', async () => {
    const { service, telegram, conversations, config, reminders } = buildService({
      state: ConversationState.DISCOVERY,
      context: { awaitingWebModalityChoice: true },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({ id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DISCOVERY, context: { awaitingWebModalityChoice: true } });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'quiero hablar', timestamp: new Date() });

    await service.handleMessage({});

    expect(reminders.schedule).toHaveBeenCalledWith('conv-1', 'u1', 'telegram', true);
  });

  it('"escribir" sends the texto.html link', async () => {
    const { service, telegram, conversations, config } = buildService({
      state: ConversationState.DISCOVERY,
      context: { awaitingWebModalityChoice: true },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({ id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DISCOVERY, context: { awaitingWebModalityChoice: true } });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'prefiero escribir', timestamp: new Date() });
    await service.handleMessage({});
    const [, sentText] = telegram.sendText.mock.calls[0];
    expect(sentText).toContain('texto.html');
  });

  // The chat message used to carry the signed session token in full view, so a
  // screenshot or a forwarded message handed over a working session. The chat now gets a
  // short single-use code on the backend's own host; PUBLIC_URL is what makes that host
  // knowable, so without it the long link stays (degrade, never send a link that 404s).
  it('sends a short single-use link instead of the raw session token when PUBLIC_URL is set', async () => {
    const { service, telegram, conversations, config } = buildService({
      state: ConversationState.DISCOVERY,
      context: { awaitingWebModalityChoice: true },
    });
    withWebAppUrl(config);
    config.get.mockImplementation((key: string) => {
      if (key === 'WEB_APP_URL') return 'https://asegura-app.vercel.app';
      if (key === 'PUBLIC_URL') return 'https://asegura-production.up.railway.app';
      return undefined;
    });
    conversations.getOrCreate.mockResolvedValue({ id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DISCOVERY, context: { awaitingWebModalityChoice: true } });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'escribir', timestamp: new Date() });
    await service.handleMessage({});
    const [, sentText] = telegram.sendText.mock.calls[0];
    expect(sentText).toMatch(/https:\/\/asegura-production\.up\.railway\.app\/s\/[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}/);
    expect(sentText).not.toContain('token=');
    expect(sentText).not.toContain('texto.html');
  });

  // The question names both options, so people answer naming both. Voice won on a bare mention, so
  // the choice was recorded inverted — and webModality builds Wompi's redirect_url, so the damage
  // surfaced on the last screen of the flow, right after paying.
  it.each([
    ['quiero escribir, no hablar'],
    ['prefiero escribir que hablar'],
    ['no quiero hablar, prefiero escribir'],
  ])('resolves %s to the WRITING page even though it also mentions hablar', async (reply) => {
    const { service, telegram, conversations, config } = buildService({
      state: ConversationState.DISCOVERY,
      context: { awaitingWebModalityChoice: true },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({ id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DISCOVERY, context: { awaitingWebModalityChoice: true } });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: reply, timestamp: new Date() });
    await service.handleMessage({});
    const [, sentText] = telegram.sendText.mock.calls[0];
    expect(sentText).toContain('texto.html');
    expect(sentText).not.toContain('voz.html');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as { webModality?: string };
    expect(savedContext.webModality).toBe('texto');
  });

  it('still resolves a genuine voice choice that mentions writing ("hablar, no escribir") to the voice page', async () => {
    const { service, telegram, conversations, config } = buildService({
      state: ConversationState.DISCOVERY,
      context: { awaitingWebModalityChoice: true },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({ id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DISCOVERY, context: { awaitingWebModalityChoice: true } });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'hablar, no escribir', timestamp: new Date() });
    await service.handleMessage({});
    const [, sentText] = telegram.sendText.mock.calls[0];
    expect(sentText).toContain('voz.html');
  });

  it('"seguir aquí" (or anything unrecognized) clears the flag and falls through to normal DISCOVERY handling of that SAME message — never re-sends the hablar/escribir link', async () => {
    const { service, telegram, conversations, config } = buildService({
      state: ConversationState.DISCOVERY,
      context: { awaitingWebModalityChoice: true },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({ id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DISCOVERY, context: { awaitingWebModalityChoice: true } });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'seguir aquí', timestamp: new Date() });
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2];
    expect(savedContext?.awaitingWebModalityChoice).toBeUndefined();
    // Never sends the AseguraWeb link for a message that didn't ask for it.
    const anyTextSent = [
      ...telegram.sendText.mock.calls.map((c: any[]) => c[1]),
      ...telegram.sendChoices.mock.calls.map((c: any[]) => c[1]),
    ].join(' ');
    expect(anyTextSent).not.toMatch(/voz\.html|texto\.html/);
  });

  it('a real discovery answer typed instead of tapping hablar/escribir is NOT discarded — it drives DISCOVERY normally', async () => {
    const { service, telegram, conversations, config } = buildService({
      state: ConversationState.DISCOVERY,
      context: { awaitingWebModalityChoice: true },
      intent: { productCategory: 'mascotas', coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: 'perro' },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({ id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DISCOVERY, context: { awaitingWebModalityChoice: true } });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'necesito un seguro para mi perro', timestamp: new Date() });
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2];
    // awaitingWebModalityChoice must be cleared, and productCategory must have been set
    // from THIS message — never silently dropped waiting for a hablar/escribir tap that
    // never came.
    expect(savedContext?.awaitingWebModalityChoice).toBeUndefined();
    expect(savedContext?.productCategory).toBe('mascotas');
  });
});

describe('createPaymentLinkFlow — Wompi redirect_url (plan-17 §12)', () => {
  // handleDataCapture's real flow: an affirmative "sí" first asks WHICH payment method
  // (Tarjeta Colsubsidio vs. link de pago — same underlying Wompi link either way), and
  // only the FOLLOW-UP answer actually calls createPaymentLinkFlow. Tests below start
  // already at that follow-up turn (awaitingPaymentMethodChoice: true).
  it('sets redirect_url with a FRESH token when the session picked a web modality', async () => {
    const { service, conversations, wompi, config, webSessionTokens, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        quoteProductId: 'accidentes-personales', cedula: '123', nombre: 'Ana', email: 'a@b.com',
        phoneVerified: true, selfieProvided: true, webModality: 'texto', awaitingPaymentMethodChoice: true,
      },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({
      id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DATA_CAPTURE,
      context: {
        quoteProductId: 'accidentes-personales', cedula: '123', nombre: 'Ana', email: 'a@b.com',
        phoneVerified: true, selfieProvided: true, webModality: 'texto', awaitingPaymentMethodChoice: true,
      },
    });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'link de pago', timestamp: new Date() });
    webSessionTokens.sign.mockReturnValue('fresh-checkout-token');
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: 'https://asegura-app.vercel.app/texto.html?token=fresh-checkout-token' }),
    );
  });

  it('never sets redirect_url for a chat-only conversation (webModality unset)', async () => {
    const { service, conversations, wompi, config, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        quoteProductId: 'accidentes-personales', cedula: '123', nombre: 'Ana', email: 'a@b.com',
        phoneVerified: true, selfieProvided: true, awaitingPaymentMethodChoice: true,
      },
    });
    withWebAppUrl(config);
    conversations.getOrCreate.mockResolvedValue({
      id: 'conv-1', user_id: 'u1', channel: 'telegram', state: ConversationState.DATA_CAPTURE,
      context: {
        quoteProductId: 'accidentes-personales', cedula: '123', nombre: 'Ana', email: 'a@b.com',
        phoneVerified: true, selfieProvided: true, awaitingPaymentMethodChoice: true,
      },
    });
    telegram.normalize.mockResolvedValue({ userId: 'u1', channel: 'telegram', channelId: '1', text: 'link de pago', timestamp: new Date() });
    await service.handleMessage({});
    const call = wompi.createPaymentLink.mock.calls[0]?.[0];
    expect(call?.redirectUrl).toBeUndefined();
  });
});
