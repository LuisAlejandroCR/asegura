import { ConversationState, ConversationContext } from './types';
import { PRODUCTS } from '../quoting/products.data';
import { makeMessage, makeIntent, makeConversation, buildService } from './agent.service.test-helpers';

// ── Unsupported input (images, long audio) ────────────────────────────────────

describe('AgentService — unsupported input', () => {
  it('regression — an image gets an informative message instead of being silently ignored', async () => {
    const { service, telegram, nlp } = buildService({ state: ConversationState.DISCOVERY });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), unsupportedInput: 'image' });
    await service.handleMessage({});
    expect(telegram.sendText).toHaveBeenCalledWith('u1', expect.stringContaining('imágenes'));
    expect(nlp.extractIntent).not.toHaveBeenCalled();
  });

  it('regression — a too-long voice note gets an informative message instead of being silently ignored', async () => {
    const { service, telegram, nlp } = buildService({ state: ConversationState.DISCOVERY });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), unsupportedInput: 'audio_too_long' });
    await service.handleMessage({});
    expect(telegram.sendText).toHaveBeenCalledWith('u1', expect.stringContaining('cortos'));
    expect(nlp.extractIntent).not.toHaveBeenCalled();
  });

  it('does not persist any state change for unsupported input', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.DISCOVERY });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), unsupportedInput: 'image' });
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalled();
  });
});

// ── GREETING state ───────────────────────────────────────────────────────────

describe('AgentService — GREETING', () => {
  // 2026-07-24 feedback: greeting + a full separate authorization paragraph read as a
  // wall of text before the user could say anything — combined into ONE short message;
  // the Ley 1581 disclosure is kept (legally required) but folded in, not its own message.
  it('sends one combined greeting + authorization message, not two separate ones', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.GREETING });
    telegram.normalize.mockResolvedValue(makeMessage('hola'));
    await service.handleMessage({});
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    const message = telegram.sendText.mock.calls[0][1] as string;
    expect(message).toContain('Asegura');
    expect(message).toContain('Ley 1581');
    // State must advance to AUTHORIZATION
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.AUTHORIZATION, expect.anything(),
    );
  });

  it('regression — GREETING never skips the greeting message (¡Hola!)', async () => {
    const { service, telegram } = buildService({ state: ConversationState.GREETING });
    telegram.normalize.mockResolvedValue(makeMessage('/start'));
    await service.handleMessage({});
    const calls = telegram.sendText.mock.calls.map((c: any[]) => c[1] as string);
    const hasGreeting = calls.some((t) => t.includes('Asegura') && (t.includes('Hola') || t.includes('hola') || t.includes('asesor')));
    expect(hasGreeting).toBe(true);
  });

  it('authorization message contains a clickable in-chat link (Telegram WebView, not external browser)', async () => {
    const { service, telegram } = buildService({ state: ConversationState.GREETING });
    telegram.normalize.mockResolvedValue(makeMessage('/start'));
    await service.handleMessage({});
    const calls = telegram.sendText.mock.calls.map((c: any[]) => c[1] as string);
    const authMsg = calls.find((t) => t.includes('Ley 1581'));
    expect(authMsg).toBeDefined();
    // Link must be Telegram Markdown format [text](url) — opens in WebView, user never leaves the chat
    expect(authMsg).toMatch(/\[.*?\]\(https?:\/\/.*?\)/);
    expect(authMsg).toContain('colsubsidio.com');
  });
});

// ── AUTHORIZATION state ───────────────────────────────────────────────────────

describe('AgentService — AUTHORIZATION', () => {
  it('"sí" transitions to DISCOVERY with autorizado:true', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.objectContaining({ autorizado: true }),
    );
  });

  it('"si" (without accent) also authorizes', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('si'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.objectContaining({ autorizado: true }),
    );
  });

  it('regression — voice "Sí." (with punctuation) authorizes correctly', async () => {
    // Bug: Whisper transcribes " Sí." → after normalize: "sí." → failed === 'sí'
    // Fix: punctuation stripped before comparison
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage(' Sí.'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.objectContaining({ autorizado: true }),
    );
  });

  it('regression — voice "Sí!" (exclamation) authorizes correctly', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('Sí!'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.objectContaining({ autorizado: true }),
    );
  });

  it('"no" transitions to REJECTED', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.REJECTED, expect.objectContaining({ autorizado: false }),
    );
  });

  it('random non-sí text re-prompts instead of rejecting', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('quizás'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalled(); // stays in AUTHORIZATION
  });
});

// ── KYC — phone verification via Telegram's native contact-share button ───────
// 2026-07-24 feedback: "simple KYC to know the user is real... Telegram autocomplete as
// autoconfirmation and avoid user leave the chat" — confirmed approach is Telegram's
// native request_contact button (no SMS/Twilio provider), fired once at the very start
// of DATA_CAPTURE, before any other question.

describe('AgentService — KYC phone verification gate', () => {
  it('"sí" in QUOTE_PRESENTED requests phone verification instead of the first data-capture question when not yet verified', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(telegram.sendContactRequest).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ awaitingPhoneVerification: true }),
    );
  });

  it('skips phone verification when already verified from an earlier purchase in the same conversation', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, phoneVerified: true, verifiedPhone: '+573001234567' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(telegram.sendContactRequest).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/documento de identidad|cédula/);
  });

  it('sharing contact while awaiting verification marks phoneVerified and asks for a selfie next (not the real question yet)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { awaitingPhoneVerification: true },
    });
    telegram.normalize.mockResolvedValue({
      ...makeMessage(''),
      contact: { phoneNumber: '+573001234567', firstName: 'Juan' },
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        phoneVerified: true,
        verifiedPhone: '+573001234567',
        awaitingPhoneVerification: undefined,
        awaitingSelfie: true,
      }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/selfie|foto/);
    expect(sentText.toLowerCase()).not.toMatch(/documento de identidad|cédula/);
  });

  // 2026-07-24 feedback: the contact-share confirmation gets a "big" Telegram reaction
  // (a much larger animated burst) on the shared-contact message itself.
  it('reacts to the shared-contact message with a big reaction', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { awaitingPhoneVerification: true },
    });
    telegram.normalize.mockResolvedValue({
      ...makeMessage(''),
      contact: { phoneNumber: '+573001234567', firstName: 'Juan' },
      messageId: 321,
    });
    await service.handleMessage({});
    expect(telegram.reactToMessage).toHaveBeenCalledWith('u1', 321, expect.any(String), true);
  });

  // Real bug found 2026-07-24 (confirmed independently by a live test session and a
  // teammate's findings report): this used to re-show the exact same "toca el botón"
  // prompt forever for ANY typed reply that wasn't the contact-share — a genuine
  // demo-killing infinite loop ("no me interesa" / "cobertura familiar" / random text
  // all got the identical response, permanently). The button is shown once, at the
  // QUOTE_PRESENTED -> DATA_CAPTURE transition; if the very next message still isn't a
  // contact-share, this cosmetic KYC step must be skipped rather than asked again — it
  // must never be allowed to block a real sale.
  it('regression — typing instead of sharing contact skips phone verification and moves on (never loops)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { awaitingPhoneVerification: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no me interesa'));
    await service.handleMessage({});
    expect(telegram.sendContactRequest).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ awaitingPhoneVerification: undefined, phoneVerified: false }),
    );
  });
});

// ── KYC — cosmetic selfie step (2026-07-24, simulated identity confirmation) ──
// User feedback: "let user know that the camera will open, take the selfie immediately,
// simulate a KYC as cosmetic and let the user know it was successfully approved... this
// is possible with a third-party service integrated into the chat to avoid false
// identity" (a future, real integration). This step does NOT perform any real face
// matching or liveness check — any photo received counts as "confirmed".

describe('AgentService — KYC cosmetic selfie step', () => {
  // Same "never loop forever" fix as phone verification above — this is a cosmetic,
  // simulated step and must never block a real sale.
  it('regression — typing instead of sending a photo skips the selfie step and moves on (never loops)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, awaitingSelfie: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no gracias'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ awaitingSelfie: undefined, selfieProvided: false }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/cédula|documento de identidad/);
  });

  it('a photo marks selfieProvided and proceeds to the real first question (cédula)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, awaitingSelfie: true },
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 1080, height: 1080 } });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ selfieProvided: true, awaitingSelfie: undefined }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/cédula|documento de identidad/);
  });

  it('mascotas purchase: a photo proceeds to the first pet question, not cédula', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, awaitingSelfie: true, productCategory: 'mascotas', petCount: 2 },
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 1080, height: 1080 } });
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('1 de 2');
    expect(sentText).not.toContain('dígitos');
  });

  // 2026-07-24 feedback: "is there a way to confirm that the image is a selfie, is ok if
  // is not high resolution" — no real face detection (stays a cosmetic simulation), but
  // a suspiciously tiny image (icon/sticker-shaped, not an actual camera photo) gets one
  // gentle retry ask instead of being silently accepted as "confirmed".
  describe('KYC selfie — tiny-image sanity guard (never blocks a sale)', () => {
    it('a suspiciously tiny image asks to retry once instead of accepting it as the selfie', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { phoneVerified: true, awaitingSelfie: true },
      });
      telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 40, height: 40 } });
      await service.handleMessage({});
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
      expect(savedContext.selfieProvided).toBeFalsy();
      expect(savedContext.awaitingSelfie).toBe(true);
      expect(savedContext.selfieRetryAsked).toBe(true);
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText.toLowerCase()).toMatch(/pequeñ/);
    });

    it('regression — a SECOND tiny image is accepted anyway (never loops forever, same as every other KYC gate)', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { phoneVerified: true, awaitingSelfie: true, selfieRetryAsked: true },
      });
      telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 40, height: 40 } });
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE,
        expect.objectContaining({ selfieProvided: true, awaitingSelfie: undefined }),
      );
    });

    it('a normal-sized photo is accepted immediately, no retry ask', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { phoneVerified: true, awaitingSelfie: true },
      });
      telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 1080, height: 1080 } });
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE,
        expect.objectContaining({ selfieProvided: true }),
      );
    });
  });

  // 2026-07-24 feedback: "is there a way to show an animated successfully check pass
  // inside the chat?" — sends the real branded success-checkmark video when the selfie
  // is confirmed, instead of just a text-only reaction.
  it('sends the branded success animation when the selfie is confirmed', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, awaitingSelfie: true },
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 1080, height: 1080 }, messageId: 555 });
    await service.handleMessage({});
    expect(telegram.sendAnimation).toHaveBeenCalledWith('u1', expect.stringContaining('identity-confirmed.mp4'));
  });

  it('does not re-trigger once selfieProvided is already true', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, selfieProvided: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('123456789'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).not.toMatch(/selfie/);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '123456789' }),
    );
  });
});

// ── DATA_CAPTURE flow ─────────────────────────────────────────────────────────

describe('AgentService — DATA_CAPTURE sequential flow', () => {
  it('invalid cédula (letters) shows error and stays in DATA_CAPTURE', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('abc'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.PAYMENT, expect.anything(),
    );
    const textArg = telegram.sendText.mock.calls[0][1] as string;
    expect(textArg).toContain('dígitos');
  });

  it('invalid cédula (too short) shows error', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('123'));
    await service.handleMessage({});
    const textArg = telegram.sendText.mock.calls[0][1] as string;
    expect(textArg).toContain('dígitos');
  });

  it('valid cédula (8 digits) saves cedula to context', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('12345678'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '12345678' }),
    );
  });

  it('regression — a bare number defaults documentType to CC (backward compatible)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('12345678'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '12345678', documentType: 'CC' }),
    );
  });

  it('detects "CE" (cédula de extranjería) from the message', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('CE 123456789'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '123456789', documentType: 'CE' }),
    );
  });

  it('detects "tarjeta de identidad" (TI) from the message', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('mi tarjeta de identidad es 1002345678'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '1002345678', documentType: 'TI' }),
    );
  });

  it('detects "cédula de extranjería" (spelled out) as CE', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('mi cédula de extranjería es 987654321'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '987654321', documentType: 'CE' }),
    );
  });

  it('detects "NUIP" from the message', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('NUIP 1122334455'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '1122334455', documentType: 'NUIP' }),
    );
  });

  it('regression — context.cedula persists when capturing nombre', async () => {
    // Bug: returning {text, context: newContext} without cedula dropped it
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Juan Pérez'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan Pérez' }),
    );
  });

  it('regression — context persists when capturing email', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com' }),
    );
  });

  it('regression — a filler/acknowledgment word is never captured as the nombre', async () => {
    // Real live-test bug: after providing cédula, the user's next voice message was an
    // acknowledgment ("Gracias.") to the bot's own prior response, transcribed and
    // captured verbatim as the customer's full name — corrupting the rest of the flow
    // (the actual name then got captured as the "email" in the following turn).
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Gracias.'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ nombre: expect.anything() }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/nombre/i);
  });

  // Real bug: a saved conversation context showed "nombre": "2+2" accepted as a valid
  // full name — no field ever rejected digits or symbols. A name must contain only
  // letters (incl. Spanish accents/ñ), spaces, apostrophes and hyphens.
  describe('regression — nombre rejects digits and special characters', () => {
    const invalidNames = ['2+2', '12345', 'Juan123', '!!!', 'Juan@Perez', '<script>', '****', '   ', '.', 'a'];

    it.each(invalidNames)('rejects %j as a nombre and re-asks without saving it', async (badName) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(badName));
      await service.handleMessage({});
      expect(conversations.saveState).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ nombre: expect.anything() }),
      );
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toMatch(/nombre/i);
    });

    const validNames = ['Juan Pérez', 'María José Gómez-Ruiz', "D'Angelo Niño", 'Ana', 'José Ñuñez'];

    it.each(validNames)('accepts %j as a valid nombre', async (goodName) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(goodName));
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE,
        expect.objectContaining({ nombre: goodName }),
      );
    });
  });

  it('regression — text without a valid email format is never captured as the email', async () => {
    // Real live-test bug: once nombre was wrongly set to "Gracias." (see above), the
    // NEXT message ("Juan Pérez.") got captured as the email with zero format
    // validation — no '@', no domain, nothing. The user's later attempts to fix "just
    // the email" then had no effect because the underlying corruption was in nombre.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Juan Pérez.'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ email: expect.anything() }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/correo|email/i);
  });

  it('accepts a well-formed email at step 3', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan.perez@email.com'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ email: 'juan.perez@email.com' }),
    );
  });

  // Real live-test bug: a voice message dictating an email says "arroba" for @ and
  // "punto" for . (standard Spanish spoken-email convention) — the literal transcription
  // has neither symbol, so it failed the /\S+@\S+\.\S+/ shape check entirely.
  describe('regression — spoken email dictation ("arroba"/"punto") is normalized before validating', () => {
    it.each([
      ['Juan arroba gmail punto com', 'Juan@gmail.com'],
      ['juan arroba gmail punto com.', 'juan@gmail.com'],
      ['juan punto perez arroba gmail punto com', 'juan.perez@gmail.com'],
      // Live-test report: Whisper sometimes transcribes a well-known domain's ".com"
      // literally instead of spelling out "punto com" — "arroba" alone must still be
      // enough to normalize into a valid, storable email.
      ['Juan arroba gmail.com', 'Juan@gmail.com'],
    ])('"%s" is normalized to a valid email and stored as "%s"', async (spoken, expected) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678', nombre: 'Juan Pérez' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(spoken));
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ email: expected }),
      );
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).not.toMatch(/correo electrónico\?/i);
    });
  });

  it('regression — "falta el correo" at confirmation is recognized as a correction request naming email', async () => {
    // Real live-test bug: "falta el correo" / "correo falta" did not match any keyword
    // in the correction-trigger list (corregir/cambiar/editar/está mal/equivocad) and
    // the message fell through to a generic "no logré entender" acknowledgment instead
    // of resetting the email field.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'wrong@test.com' },
      intent: makeIntent({ isNegative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('falta el correo'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan Pérez', email: undefined }),
    );
  });

  it('regression — bare "no" at confirmation asks WHICH field is wrong instead of resetting everything', async () => {
    // Real live-test bug: bare "no" immediately wiped cédula+nombre+email and forced a
    // full restart. The user's very next message (a filler word, not a cédula) then got
    // misread as a cédula attempt and failed validation. Ask first, reset only on answer.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan', email: 'j@test.com', awaitingCorrectionField: true }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/cédula|nombre|correo/i);
  });

  it('answering "nombre" after the which-field question resets only nombre', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com', awaitingCorrectionField: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('el nombre'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: undefined, email: 'j@test.com', awaitingCorrectionField: undefined }),
    );
  });

  it('answering "correo" after the which-field question resets only email', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com', awaitingCorrectionField: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('el correo'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan', email: undefined, awaitingCorrectionField: undefined }),
    );
  });

  it('re-asks when the which-field answer does not name a recognizable field', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com', awaitingCorrectionField: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ cedula: undefined }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/cédula|nombre|correo/i);
  });

  it('regression — correcting just the name only resets nombre, not cedula/email too', async () => {
    // Real live-test bug: "Corrigé mi nombre, es Juan Pérez" forced the user to redo
    // cédula AND correo just to fix a one-word name typo — a needlessly clunky UX.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pere', email: 'juan@test.com' },
      intent: makeIntent({ isNegative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Corrigé mi nombre, es Juan Pérez'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: undefined, email: 'juan@test.com' }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('nombre completo');
  });

  it('correcting just the email only resets email', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'wrong@test.com' },
      intent: makeIntent({ isNegative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('cambia mi correo, está mal'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan Pérez', email: undefined }),
    );
  });

  it('regression — a genuinely unclear message at confirmation gets an acknowledgment, not a silent repeat', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com' },
      intent: makeIntent({ isNegative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé qué decir'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/no logré entender|no entendí/i);
  });

  it('regression — "sí" at confirmation never attaches a PDF (only the post-payment webhook may)', async () => {
    // Real bug: the user received a "policy PDF" the moment they confirmed DATA_CAPTURE,
    // before ever paying. The only PDF now comes from wompi-webhook.controller.ts.
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com' },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(telegram.sendDocument).not.toHaveBeenCalled();
  });

  it('regression — "sí" at confirmation asks the payment method (no separate "listo?" confirmation) instead of generating the link right away', async () => {
    // User feedback: "¿Listo para generar tu link de pago?" was an unnecessary second
    // confirmation. The payment-method question below is a deliberate, newly-requested
    // addition (a genuine choice, not redundant friction) — it must not resurrect the
    // old "listo?" wording, and it must not call Wompi until the method is chosen.
    const { service, telegram, wompi, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/tarjeta colsubsidio/);
    expect(sentText).not.toContain('¿Listo para generar');
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ awaitingPaymentMethodChoice: true }),
    );
  });

  it('regression — aborts instead of charging a hardcoded fallback amount when no product resolves', async () => {
    // Real gap found in a hardcoded-values audit: createPaymentLinkFlow used to fall
    // back to a flat, arbitrary $20.000 COP charge via Wompi whenever no product could
    // be resolved (e.g. a stale/invalid quoteProductId survived into DATA_CAPTURE with
    // no matching catalog entry) — a customer could be charged an amount unrelated to
    // anything they were ever quoted. Must abort — no policy is issued in this state
    // either, so there is nothing legitimate to charge for.
    const { service, telegram, wompi, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com' }, // no quoteProductId at all
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.anything(),
    );
  });

  it('persists checkoutUrl and wompi_link_id in the same turn as answering the payment method question', async () => {
    const { service, telegram, conversations, policy } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', policyId: 'pol-1',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('el link de pago'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.PAYMENT, expect.objectContaining({ checkoutUrl: 'https://checkout.wompi.co/l/test' }),
    );
    expect(policy.updateStatus).toHaveBeenCalledWith('pol-1', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }));
  });
});

// ── Conditional underwriting (2026-07-24 business feedback) ──────────────────
// "Seguro de vida" and both "Medicina prepagada" (gatos/perros) products need age,
// pre-existing illnesses, and clinical history before they can be sold — everything
// else in the catalog is direct-sell (cédula/nombre/correo only).

describe('AgentService — conditional underwriting gate', () => {
  it('regression — a product requiring underwriting asks for medical info instead of jumping to the final confirmation', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'vida' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/edad|enfermedad|historial/i);
    expect(sentText).not.toMatch(/¿todo listo|confirmar|sí.*continuar/i);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ email: 'juan@email.com', awaitingMedicalInfo: true }),
    );
  });

  // 2026-07-24 clarification: the generic "edad, enfermedad, historial clínico" question
  // is only fully correct for a HUMAN product (vida) — a human's age is never captured
  // anywhere else in the flow. For a PET product (medicina-prepagada-gatos/perros), the
  // pet's age is ALWAYS already captured by the Step-0 per-pet loop (name/edad/raza)
  // before this gate is ever reached, so re-asking it is redundant; there's also no
  // "historial clínico" question for a pet, only whether it has a preexisting illness —
  // and the question must name the actual pet(s) by name, not speak generically.
  it('regression — a pet product asks only about illness, names the pet, and never re-asks age', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'medicina-prepagada-gatos',
        productCategory: 'mascotas', petCount: 1,
        pets: [{ name: 'Michi', age: '3 años', breed: 'Criollo' }],
      },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/enfermedad/i);
    expect(sentText).not.toMatch(/\bedad\b/i);
    expect(sentText).not.toMatch(/historial/i);
    expect(sentText).toContain('Michi');
  });

  it('regression — a multi-pet purchase names every pet in the underwriting question', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'medicina-prepagada-gatos',
        productCategory: 'mascotas', petCount: 2,
        pets: [
          { name: 'Michi', age: '3 años', breed: 'Criollo' },
          { name: 'Luna', age: '2 años', breed: 'Siamés' },
        ],
      },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('Michi');
    expect(sentText).toContain('Luna');
  });

  it('a human product (vida) keeps the full edad/enfermedad/historial question', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'vida' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/edad/i);
    expect(sentText).toMatch(/enfermedad/i);
    expect(sentText).toMatch(/historial/i);
  });

  it('a product that does NOT require underwriting skips medical questions and goes straight to confirmation', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'exequial' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/edad|enfermedad|historial/i);
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.email).toBe('juan@email.com');
    expect(savedContext.awaitingMedicalInfo).toBeFalsy();
  });

  it('regression — after the medical-info question, any reply is accepted (never loops) and the flow proceeds to the final confirmation', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com',
        quoteProductId: 'vida', awaitingMedicalInfo: true,
      },
    });
    telegram.normalize.mockResolvedValue(makeMessage('35 años, sin enfermedades preexistentes'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        medicalInfo: '35 años, sin enfermedades preexistentes',
        medicalInfoProvided: true,
        awaitingMedicalInfo: undefined,
      }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/sí/i); // final confirmation summary, ready for payment
  });

  it('regression — a bare "no" while awaiting medical info is stored as the answer, not misread as abandon/correction', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com',
        quoteProductId: 'vida', awaitingMedicalInfo: true,
      },
      intent: makeIntent({ isNegative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ medicalInfo: 'no', medicalInfoProvided: true }),
    );
  });
});

// ── Payment method choice (2026-07-24 feedback) ───────────────────────────────
// "at the end let user choose if they want to pay with Tarjeta Colsubsidio or Link de
// pago" — both route to the exact same real Wompi checkout link (no new payment rail,
// nothing faked): Wompi already accepts card payments, so this is a wording/framing
// choice, not a second payment integration. Deliberately does NOT claim the payment
// already succeeded before it actually has — that would be dishonest to the user.

describe('AgentService — payment method choice (Tarjeta Colsubsidio vs Link de pago)', () => {
  // Real bug found 2026-07-24, same root cause as the KYC infinite-loop fixes above:
  // this used to re-ask the same question forever for any unclear answer. Defaults to
  // the plain link de pago (the always-available, no-ambiguity option) instead of
  // looping — this must never be allowed to strand a purchase that's otherwise ready.
  it('regression — defaults to link de pago and proceeds when the answer names neither option (never loops)', async () => {
    const { service, telegram, wompi, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('checkout.wompi.co');
  });

  it('"link de pago" generates the same real Wompi link as always', async () => {
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('link de pago'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('checkout.wompi.co');
    expect(sentText.toLowerCase()).not.toMatch(/coincidencia|emparejamos/);
  });

  it('"Tarjeta Colsubsidio" generates the exact same real Wompi link, with themed copy, not a faked instant success', async () => {
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tarjeta colsubsidio'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    // Same real link as the other path — nothing about the payment is faked
    expect(sentText).toContain('checkout.wompi.co');
    // Themed copy acknowledges the card choice, but must not claim the payment is
    // already done before the user has actually paid via the link.
    expect(sentText.toLowerCase()).toMatch(/tarjeta colsubsidio/);
    expect(sentText.toLowerCase()).not.toMatch(/pago exitoso|pago realizado|ya pagaste|pago fue exitoso/);
  });

  // 2026-07-24 feedback: "Tarjeta Colsubsidio" has no real API/sandbox of its own (unlike
  // Wompi) — precisely BECAUSE there's nothing real to show for it, the "match found"
  // moment gets the real branded success-checkmark video. The real Wompi link is still
  // generated and sent exactly as before — this never skips or fakes the actual payment.
  it('sends the branded success animation when "Tarjeta Colsubsidio" is chosen, same real Wompi link underneath', async () => {
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage('tarjeta colsubsidio'), messageId: 777 });
    await service.handleMessage({});
    expect(telegram.sendAnimation).toHaveBeenCalledWith('u1', expect.stringContaining('payment-received.mp4'));
    expect(wompi.createPaymentLink).toHaveBeenCalled();
  });

  it('does NOT send the animation when "link de pago" is chosen instead', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage('link de pago'), messageId: 778 });
    await service.handleMessage({});
    expect(telegram.sendAnimation).not.toHaveBeenCalled();
  });
});

// ── DATA_CAPTURE — per-pet detail collection (name, age, breed) ──────────────

describe('AgentService — DATA_CAPTURE per-pet details for mascotas', () => {
  it('asks for the first pet\'s details before asking for cédula', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 2 },
      intent: makeIntent({ productCategory: 'mascotas' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('listo'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('1 de 2');
    expect(sentText).not.toContain('dígitos'); // must not ask for cédula yet
  });

  it('saves the first pet and asks for the second when petCount=2', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 2 },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Max', petAge: '3 años', petBreed: 'labrador' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('se llama Max, tiene 3 años, es un labrador'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ pets: [{ name: 'Max', age: '3 años', breed: 'Labrador' }] }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('2 de 2');
  });

  it('regression — accepts multiple pets described in a single message, per user request', async () => {
    // User feedback: "the pet data should be ask in one audio or text and split as needed
    // into the flow" — when Groq extracts several pets from one message, absorb all of
    // them at once instead of forcing one message per pet.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 2 },
      intent: makeIntent({
        productCategory: 'mascotas',
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Labrador' },
          { name: 'Luna', age: '3 años', breed: 'Siamés' },
        ],
      }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Rocky tiene 5 años y es labrador, y Luna tiene 3 años y es siamesa'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Labrador' },
          { name: 'Luna', age: '3 años', breed: 'Siamés' },
        ],
      }),
    );
    // All pets collected in one turn — shows the confirmation summary next
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('Rocky');
    expect(sentText).toContain('Luna');
  });

  it('absorbs as many pets as fit when the message describes more than petCount', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1 },
      intent: makeIntent({
        productCategory: 'mascotas',
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Labrador' },
          { name: 'Luna', age: '3 años', breed: 'Siamés' },
        ],
      }),
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ pets: [{ name: 'Rocky', age: '5 años', breed: 'Labrador' }] }),
    );
  });

  // Real gap: a pet name is a free-text field just like the human nombre — an NLP
  // mis-extraction of a digit/symbol "name" (e.g. "2") must not be pushed into pets[]
  // and end up on the final policy PDF.
  it('regression — a digit/symbol-only extracted petName is rejected, re-asks instead of saving it', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1, pets: [] },
      intent: makeIntent({ productCategory: 'mascotas', petName: '2', petAge: '5 años', petBreed: 'criollo' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('se llama 2, tiene 5 años, es criollo'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ pets: expect.arrayContaining([expect.objectContaining({ name: '2' })]) }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/mascota/i);
  });

  // Real live-test bug (2026-07-24): a 3-pet voice message ("Bruna...Ramón...Pancha...")
  // had Bruna silently dropped by the NLP extraction (fixed separately in
  // groq-nlp.service.ts). The user, believing all 3 pets were already given, was asked
  // for a "missing" 3rd pet and re-stated Pancha's details again — which got pushed as a
  // literal duplicate entry, corrupting the final paid, issued policy. This guard is the
  // second line of defense: even if the NLP still under-extracts for some other message,
  // re-stating an already-collected pet's exact name must never create a duplicate.
  it('regression — re-stating an already-collected pet name does not create a duplicate entry', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 3,
        pets: [
          { name: 'Ramón', age: '3 años', breed: 'Cocker Spaniel' },
          { name: 'Pancha', age: '10 años', breed: 'Doberman' },
        ],
      },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Pancha', petAge: '10 años', petBreed: 'doberman' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Pancha, 10 años, Doberman'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.pets).toHaveLength(2);
    expect(savedContext.pets).toEqual([
      { name: 'Ramón', age: '3 años', breed: 'Cocker Spaniel' },
      { name: 'Pancha', age: '10 años', breed: 'Doberman' },
    ]);
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/ya tengo a pancha|ya la tengo|diferente/i);
  });

  it('shows a confirmation summary (not cédula yet) once all pets are collected', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1, pets: [] },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Rocky', petAge: '5 años', petBreed: 'criollo' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('se llama Rocky, tiene 5 años, es criollo'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('Rocky');
    expect(sentText).toContain('5 años');
    expect(sentText).not.toContain('dígitos'); // does not ask for cédula yet
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        pets: [{ name: 'Rocky', age: '5 años', breed: 'Criollo' }],
        petsAwaitingConfirmation: true,
      }),
    );
  });

  it('regression — a mis-transcribed breed ("caken") is normalized to the closest known breed when captured', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1, pets: [] },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Maylo', petAge: '10 años', petBreed: 'caken' }),
    });
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.pets?.[0].breed.toLowerCase()).toContain('cocker');
  });

  it('"sí" at the pets confirmation proceeds to asking for cédula', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 1,
        pets: [{ name: 'Rocky', age: '5 años', breed: 'Criollo' }],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('dígitos');
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ petsAwaitingConfirmation: undefined }),
    );
  });

  it('regression — correcting one pet\'s field by name only updates that pet, not the whole list', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 2,
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Doberman' },
          { name: 'Bruna', age: '10 años', breed: 'Criollo' },
        ],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: false, petName: 'Bruna', petAge: '8 años' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Bruna tiene 8 años, no 10'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Doberman' },
          { name: 'Bruna', age: '8 años', breed: 'Criollo' },
        ],
        petsAwaitingConfirmation: true,
      }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('8 años');
  });

  it('regression — a garbage-shaped extracted petName never overwrites an already-valid pet name during correction', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 1,
        pets: [{ name: 'Rocky', age: '5 años', breed: 'Doberman' }],
        petsAwaitingConfirmation: true,
      },
      // Single-pet household — targetIndex falls back to 0, so a garbage petName must
      // not silently rename "Rocky" to "2".
      intent: makeIntent({ isAffirmative: false, petName: '2', petAge: '6 años' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tiene 6 años'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        pets: [{ name: 'Rocky', age: '6 años', breed: 'Doberman' }],
      }),
    );
  });

  // Real live-test bug (2026-07-24): a 3-pet message ("Bruna... Ramón... Pancha...")
  // came back with Pancha duplicated and Bruna missing. Every correction attempt by name
  // ("Pancha, 10 años, Cocker") always matched the FIRST "Pancha", never the duplicate;
  // ordinal attempts ("el tercero es Ramón...") were not understood at all. The corrupted
  // data made it all the way into the final, paid, issued policy PDF.
  it('regression — a name matching two pets asks which one instead of silently updating the first', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 3,
        pets: [
          { name: 'Ramón', age: '3 años', breed: 'Doberman' },
          { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' },
          { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' },
        ],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: false, petName: 'Pancha', petAge: '10 años' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Pancha, 10 años, Cocker'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/2 mascotas llamadas.*Pancha/i);
    // Nothing changed yet — must not silently guess which "Pancha" was meant
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    if (savedContext) expect(savedContext.pets).toHaveLength(3);
  });

  it('regression — an ordinal reference ("el tercero") targets that pet by position, not by name lookup', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 3,
        pets: [
          { name: 'Ramón', age: '3 años', breed: 'Doberman' },
          { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' },
          { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' },
        ],
        petsAwaitingConfirmation: true,
      },
      // "Ramón" here also matches pets[0] by name — the ordinal must win so the THIRD
      // slot (the actual duplicate) gets corrected, not the already-correct first one.
      intent: makeIntent({ isAffirmative: false, petName: 'Bruna', petAge: '10 años', petBreed: 'Criolla' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('el tercero es Bruna, 10 años, criolla'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.pets?.[0]).toEqual({ name: 'Ramón', age: '3 años', breed: 'Doberman' });
    expect(savedContext?.pets?.[2].name).toBe('Bruna');
  });

  it('supports "la segunda" (feminine ordinal) targeting the second pet', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 2,
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Doberman' },
          { name: 'Luna', age: '2 años', breed: 'Siamés' },
        ],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: false, petAge: '3 años' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('la segunda tiene 3 años'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.pets?.[1].age).toBe('3 años');
    expect(savedContext?.pets?.[0].age).toBe('5 años');
  });

  it('asks for clarification when a correction at pets confirmation does not name a known pet', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 1,
        pets: [{ name: 'Rocky', age: '5 años', breed: 'Doberman' }],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: false, petName: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no está bien'));
    await service.handleMessage({});
    // pets stays unchanged — nothing was actually corrected, just re-prompted
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    if (savedContext) {
      expect(savedContext.pets).toEqual([{ name: 'Rocky', age: '5 años', breed: 'Doberman' }]);
    }
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/cuál mascota|nombre de la mascota/);
  });

  it('defaults age/breed to "no especificada" when the user only gives a name', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1 },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Luna', petAge: null, petBreed: null }),
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ pets: [{ name: 'Luna', age: 'no especificada', breed: 'no especificada' }] }),
    );
  });

  it('re-asks without advancing when no pet name is extracted from the message', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1, pets: [] },
      intent: makeIntent({ productCategory: 'mascotas', petName: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    // pets stays empty — no pet was actually captured, just re-prompted
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ pets: expect.arrayContaining([expect.anything()]) }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('1 de 1');
  });

  it('does not trigger the pet-detail loop for non-mascotas products', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'vida' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('12345678'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('mascota');
  });
});

// ── PAYMENT — webhook is the source of truth, chat "sí" no longer confirms ────

describe('AgentService — PAYMENT webhook-driven confirmation', () => {
  it('regression — charges the correct multiplied total for multi-pet households, not the flat single-pet price', async () => {
    // Real bug: the chat quote correctly showed "$14.500/mes por mascota, Total para 3
    // mascotas: $43.500/mes", but the actual Wompi charge used the flat basePremium —
    // under-charging by 2/3 for a 3-pet household.
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!; // basePremium 14500
    const { service, telegram, wompi } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amountCOP: 43500 }),
    );
  });

  it('creating a payment link persists wompi_link_id on the policy record', async () => {
    // The webhook can only find our policy via payment_link_id (Wompi has no
    // "reference" create-parameter) — it must be persisted the moment the link exists.
    const { service, telegram, policy, wompi } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    expect(policy.updateStatus).toHaveBeenCalledWith(
      'pol-1', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }),
    );
  });

  it('regression — "sí" after checkoutUrl exists does NOT issue the policy or advance state', async () => {
    // Trusting the user's word was the bug: anyone could type "sí" without paying and
    // get a policy issued + registered on-chain. Only the Wompi webhook may do that now.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', checkoutUrl: 'https://checkout.wompi.co/l/test' },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.POLICY_ISSUED, expect.anything(),
    );
  });

  it('"sí" after checkoutUrl exists gives a waiting acknowledgment, not a repeated payment prompt', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', checkoutUrl: 'https://checkout.wompi.co/l/test' },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    // Must not tell the user to say "sí" again — the webhook confirms automatically now
    expect(sentText).not.toMatch(/escríbeme.*sí/i);
  });

  it('"no" after checkoutUrl exists still abandons (unchanged behavior)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', checkoutUrl: 'https://checkout.wompi.co/l/test' },
      intent: makeIntent({ isNegative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.ABANDONED, expect.anything(),
    );
  });
});

// ── QUOTE_PRESENTED — no-repeat invariant ─────────────────────────────────────

describe('AgentService — QUOTE_PRESENTED no-repeat on "otro"', () => {
  it('regression — "otro" uses shownProductIds to skip already-shown products', async () => {
    const p1 = PRODUCTS[0];
    const p2 = PRODUCTS[1];
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: p1.id,
        shownProductIds: [p1.id],
        productCategory: 'accidentes',
      },
    });
    telegram.normalize.mockResolvedValue(makeMessage('otro'));
    quoting.score.mockReturnValue([
      { productId: p1.id, matchScore: 80, reasons: [], monthlyPremium: p1.basePremium, priority: 'high' },
      { productId: p2.id, matchScore: 60, reasons: [], monthlyPremium: p2.basePremium, priority: 'medium' },
    ]);
    await service.handleMessage({});
    // Should transition to p2, not p1 again
    const saveCall = conversations.saveState.mock.calls[0];
    if (saveCall) {
      const savedContext = saveCall[2] as ConversationContext;
      expect(savedContext.quoteProductId).toBe(p2.id);
      expect(savedContext.shownProductIds).toContain(p1.id);
      expect(savedContext.shownProductIds).toContain(p2.id);
    }
  });

  it('regression — shownProductIds grows monotonically across "otro" calls', async () => {
    const p1 = PRODUCTS[0];
    const p2 = PRODUCTS[1];
    const p3 = PRODUCTS[2];
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: p1.id, shownProductIds: [p1.id] },
    });
    telegram.normalize.mockResolvedValue(makeMessage('otra opción'));
    quoting.score.mockReturnValue([
      { productId: p1.id, matchScore: 90, reasons: [], monthlyPremium: 0, priority: 'high' },
      { productId: p2.id, matchScore: 70, reasons: [], monthlyPremium: 0, priority: 'high' },
      { productId: p3.id, matchScore: 50, reasons: [], monthlyPremium: 0, priority: 'medium' },
    ]);
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    if (savedContext?.shownProductIds) {
      // shownProductIds must contain previous + new product
      expect(savedContext.shownProductIds.length).toBeGreaterThan(1);
      expect(savedContext.shownProductIds).toContain(p1.id);
    }
  });

  it('"sí" in QUOTE_PRESENTED transitions to DATA_CAPTURE', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.anything(),
    );
  });

  it('regression — neutral question re-shows the real quoted product, not a generic placeholder', async () => {
    // Bug: a neutral/unclear message (not affirmative/negative/alternative) in QUOTE_PRESENTED
    // fell through to the generic STATE_RESPONSES[QUOTE_PRESENTED] placeholder
    // ("🛡️ Seguro de mascotas / 💰 Desde precio accesible/mes") instead of re-showing the
    // actual quoted product with its real name and price.
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿Ese es el único plan?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(petProduct.name);
    expect(sentText).not.toContain('precio accesible');
  });
});

// ── QUOTE_PRESENTED / DISCOVERY — out-of-catalog category mentions ────────────
// Real bug independently confirmed by both a live test session and a teammate's
// findings report: asking for a category we don't sell ("vehicular", "seguro vehicular")
// silently re-showed the unrelated, already-quoted product verbatim (Seguro de vida,
// twice, identically) instead of honestly saying we don't offer it. The agent must never
// silently pretend an unrelated stale quote answers a genuinely different question.

describe('AgentService — QUOTE_PRESENTED honest response to an out-of-catalog category', () => {
  it('regression — "vehicular" does not silently re-show the unrelated current quote', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('vehicular'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain(vidaProduct.name);
    expect(sentText.toLowerCase()).toMatch(/no tengo|no ofrecemos|no cuento con/);
  });

  it('regression — "seguro vehicular" (fuller phrasing) is also recognized as out-of-catalog', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('seguro vehicular'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain(vidaProduct.name);
  });

  it('still re-shows the current quote for a genuinely neutral follow-up (no regression on the real product name test above)', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
  });
});

// ── QUOTE_PRESENTED — cross-sell for the human owner ──────────────────────────

describe('AgentService — QUOTE_PRESENTED cross-sell for personal coverage', () => {
  it('regression — asking about coverage "para mí" during a pet quote defers it instead of abandoning the pending purchase', async () => {
    // 2026-07-24 "restore the flow": a quote in progress must never be abandoned for a
    // cross-sell mention — real live-test bug, repeated across many live sessions: "para
    // mí, qué hay" during an UNCONFIRMED mascotas quote used to immediately replace it
    // with a different product, so the mascotas purchase was silently dropped before
    // ever reaching payment ("continue offering products when I already chose"). Now it
    // acknowledges, keeps the pet quote pending, and defers the follow-up until after
    // this purchase is paid (see wompi-webhook.controller.ts).
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petType: 'gato', petCount: 1 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Me interesan mascotas y para mí ¿qué hay?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(petProduct.name);
    expect(sentText.toLowerCase()).toMatch(/confirmamos|sí/);
    // Stays on the pet quote — the purchase in progress is never interrupted
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    expect(saveCall?.[2].quoteProductId).toBe(petProduct.id);
    expect(saveCall?.[2]).toHaveProperty('pendingCrossSell');
  });

  it('does not trigger cross-sell when the current quote is not a pet product', async () => {
    const humanProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: humanProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('y para mí ¿qué más hay?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(humanProduct.name);
  });

  it('regression — cross-sell takes priority even when isAffirmative is true (real live-test bug)', async () => {
    // Real bug: "Quiero ser mascotas, muéstrame ese de salud de accidentes para mí."
    // contains "quiero" (an isAffirmative trigger word) with no question mark, so
    // isAffirmative won a race against cross-sell detection and sent the user straight
    // to DATA_CAPTURE for the PET quote — completely ignoring the "para mí" request.
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: true, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Quiero, muéstrame ese de salud de accidentes para mí.'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.DATA_CAPTURE, expect.anything(),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/vida|accidentes|asistencia/);
  });

  it('regression — remembers the named category as the deferred follow-up instead of losing it', async () => {
    // The cross-sell message often already names a specific category (e.g. "muéstrame
    // ese de salud de accidentes para mí" → 'accidentes') — that information must not be
    // thrown away just because it's deferred; it becomes context.pendingCrossSell so the
    // post-purchase follow-up offers THAT category specifically, not a generic "algo más?".
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: true, isNegative: false, wantsAlternative: false, productCategory: 'accidentes' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Quiero ser mascotas, muéstrame ese de salud de accidentes para mí.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(petProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    expect(saveCall?.[2].quoteProductId).toBe(petProduct.id);
    expect(saveCall?.[2].pendingCrossSell).toBe('accidentes');
  });
});

describe('AgentService — QUOTE_PRESENTED explicit category mention defers, does not abandon the quote', () => {
  it('regression — naming a different category by name defers it instead of replacing the pending quote', async () => {
    // 2026-07-24 "restore the flow": while viewing an "asistencia" quote, "quiero ver
    // seguro de vida" used to immediately REPLACE it — the asistencia purchase was
    // abandoned mid-flow, before ever reaching payment. Now it's deferred: the current
    // quote stays pending, and the named category becomes the post-purchase follow-up.
    const asistenciaProduct = PRODUCTS.find(p => p.category === 'asistencia')!;
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: asistenciaProduct.id, productCategory: 'asistencia' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Quiero ver seguro de vida.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(asistenciaProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    expect(saveCall?.[2].quoteProductId).toBe(asistenciaProduct.id);
    expect(saveCall?.[2].pendingCrossSell).toBe('vida');
  });

  it('regression — defers even when isAffirmative is also true (a category name is not a confirmation)', async () => {
    const asistenciaProduct = PRODUCTS.find(p => p.category === 'asistencia')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: asistenciaProduct.id, productCategory: 'asistencia' },
      intent: makeIntent({ isAffirmative: true, isNegative: false, wantsAlternative: false, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Quiero ver seguro de vida.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(asistenciaProduct.name);
  });

  it('does not switch when the named category matches the currently quoted product', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿el de vida cubre incapacidad?'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
  });

  it('regression — a plain confirmation reaches DATA_CAPTURE even if the LLM spuriously sets productCategory with no category actually named in the text', async () => {
    // Real live-test bug: "Sí, quiero esa." confirmed a shown quote, but the LLM
    // sometimes returns a productCategory value anyway despite the message naming no
    // category at all — this used to hijack a clear purchase confirmation into an
    // unwanted category switch, and DATA_CAPTURE was never reached ("after confirm,
    // keeps offering more insurance").
    const asistenciaProduct = PRODUCTS.find(p => p.category === 'asistencia')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      // phoneVerified: true — this test is about the category-hijack bug, not KYC; the
      // phone-verification gate itself is covered by 'AgentService — KYC phone
      // verification gate' above.
      context: { quoteProductId: asistenciaProduct.id, productCategory: 'asistencia', phoneVerified: true },
      intent: makeIntent({ isAffirmative: true, isNegative: false, wantsAlternative: false, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Sí, quiero esa.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/documento de identidad|cédula/);
  });
});

// ── DISCOVERY — mixed pets clarification ──────────────────────────────────────

describe('AgentService — DISCOVERY mixed pets', () => {
  it('regression — mixto petType triggers clarification question', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tengo un gato y dos perros'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0][1] as string;
    expect(sentText).toContain('gato');
    expect(sentText).toContain('perros');
    // Must save mixto context (not transition to QUOTE_PRESENTED yet)
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.QUOTE_PRESENTED, expect.anything(),
    );
  });

  it('regression — "para todos" after mixto clarification resolves to petType:null and quotes', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas' },
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'all' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    // Should transition to QUOTE_PRESENTED (not stay in clarification loop)
    const saveCall = conversations.saveState.mock.calls[0];
    if (saveCall) {
      expect(saveCall[1]).toBe(ConversationState.QUOTE_PRESENTED);
    }
  });

  // Real live-test bug: a genuinely mixed household (2 dogs + 1 cat) got quoted a
  // SINGLE product (medicina-prepagada-gatos, cat-only) multiplied by the TOTAL pet
  // count (3) — charging the 2 dogs at the cat rate. The user explicitly rejected it:
  // "eso no es para gatos, para los perros que hay". A mixto household with an explicit
  // per-species count must be quoted as BOTH species-specific products, each priced
  // against its OWN count, not one product against the combined total.
  it('regression — a mixed household (2 dogs + 1 cat) is quoted BOTH species products at their own per-species price, not one product x total count', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto', petCount: 3 }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Tengo dos perros, una gata y yo.'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.petSpeciesCounts).toEqual({ gato: 1, perro: 2 });

    // Second turn: "para todos" should now build a combined multi-species quote instead
    // of picking a single product via bestQuote.
    const { service: service2, telegram: telegram2, conversations: conversations2 } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas', petCount: 3, petSpeciesCounts: { gato: 1, perro: 2 } },
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'all' }),
    });
    telegram2.normalize.mockResolvedValue(makeMessage('para todos'));
    await service2.handleMessage({});
    const sentText = telegram2.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('gatos');
    expect(sentText).toContain('perros');
    expect(sentText).toContain('81.800');
    expect(sentText).toContain('96.600');
    // 1 cat x 81.800 + 2 dogs x 96.600 = 275.000 — never the old wrong total (3 x 81.800 = 245.400)
    expect(sentText).toContain('275.000');
    expect(sentText).not.toContain('245.400');
    const savedContext2 = conversations2.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext2.selectedProductIds).toEqual(
      expect.arrayContaining(['medicina-prepagada-gatos', 'medicina-prepagada-perros']),
    );
  });

  it('"el gato" after mixto clarification sets petType gato', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas' },
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'gato' }),
    });
    const gatoProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    quoting.bestQuote.mockReturnValue({ product: gatoProduct, score: { reasons: ['Para gatos'], matchScore: 80, monthlyPremium: gatoProduct.basePremium, priority: 'high', productId: gatoProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('el gato'));
    await service.handleMessage({});
    const saveCall = conversations.saveState.mock.calls[0];
    if (saveCall) {
      const savedContext = saveCall[2] as ConversationContext;
      // petType should be resolved to gato (not remain mixto)
      expect(savedContext.petType).not.toBe('mixto');
    }
  });
});

// ── DISCOVERY — productCategory inference + ages loop regression ──────────────

describe('AgentService — DISCOVERY productCategory inference', () => {
  it('infers productCategory mascotas from petType gato when NLP does not extract it', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      // petType already resolved to gato (post-mixto clarification), productCategory NOT set
      context: { petType: 'gato', coverage: ['medicina veterinaria'], beneficiaries: 1 },
      intent: makeIntent({ productCategory: null, petResolution: null }),
    });
    const gatoProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    quoting.bestQuote.mockReturnValue({
      product: gatoProduct,
      score: { reasons: ['Para gatos'], matchScore: 80, monthlyPremium: gatoProduct.basePremium, priority: 'high', productId: gatoProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('10 años mi gata'));
    await service.handleMessage({});
    // Should advance to QUOTE_PRESENTED, not loop on ages question
    expect(quoting.bestQuote).toHaveBeenCalled();
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });

  it('regression — ages answer does not loop back to ages question', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      // All three discovery answers given: coverage, beneficiaries, productCategory via petType
      context: { petType: 'gato', coverage: ['medicina veterinaria'], beneficiaries: 2 },
      intent: makeIntent({ productCategory: null }),
    });
    const gatoProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    quoting.bestQuote.mockReturnValue({
      product: gatoProduct,
      score: { reasons: ['Para gatos'], matchScore: 80, monthlyPremium: gatoProduct.basePremium, priority: 'high', productId: gatoProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('10 años mi gata, 7 años mi perro y 33 años'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    // Must NOT repeat the ages question
    expect(sentText).not.toContain('rango de edades');
    // Must present a quote
    expect(sentText).toContain(gatoProduct.name);
  });

  it('no match found — sends redirect message instead of repeating ages', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'gato', coverage: ['medicina veterinaria'], beneficiaries: 1 },
      intent: makeIntent({ productCategory: null }),
    });
    quoting.bestQuote.mockReturnValue(null);
    telegram.normalize.mockResolvedValue(makeMessage('10 años'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('rango de edades');
    expect(sentText).toContain('diferente');
  });
});

// ── DISCOVERY — pet count + quote clarity ────────────────────────────────────

describe('AgentService — DISCOVERY pet count and quote pricing', () => {
  // petType: 'perro' below — these 3 tests are about petCount/pricing propagation, not
  // species resolution, so species is already known going in. The "species unknown"
  // case (which used to quote blind) is its own describe block below.
  it('petCount from intent is saved to context', async () => {
    const { service, conversations, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'perro', coverage: ['medicina veterinaria'], productCategory: 'mascotas' },
      intent: makeIntent({ productCategory: 'mascotas', petCount: 3 }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.petCount).toBe(3);
  });

  it('quote for pet product always labels price as "por mascota"', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'perro', coverage: ['medicina veterinaria'], productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ productCategory: 'mascotas' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('por mascota');
  });

  it('quote for pet product with petCount=3 shows total monthly price', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'perro', coverage: ['medicina veterinaria'], productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ productCategory: 'mascotas' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!; // basePremium: 14500
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('43.500'); // 14500 × 3
    expect(sentText).toContain('3 mascotas');
  });

  it('quote for pet product includes note that coverage is for pets, not the owner', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'gato', coverage: ['medicina veterinaria'], productCategory: 'mascotas', petCount: 1 },
      intent: makeIntent({ productCategory: 'mascotas', petType: 'gato' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para gatos'], matchScore: 80, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('el gato'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/mascota|para ti|también/);
  });
});

// ── DISCOVERY — must know species before quoting mascotas ────────────────────
// Real live-test gap: "Tengo dos mascotas y yo." went straight to a quote without the
// agent ever learning cat/dog/mixed. The real catalog has species-restricted products
// (medicina-prepagada-gatos / medicina-prepagada-perros) alongside a generic one —
// quoting blind risks missing the more specific, better-matching product and skips the
// per-profile personalization judges look for ("¿por qué este seguro para esta persona?").

describe('AgentService — DISCOVERY asks species before quoting mascotas', () => {
  it('regression — "Tengo dos mascotas y yo" asks cat/dog/mixed instead of quoting blind', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: null, petCount: 2 }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tengo dos mascotas y yo'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/gatos.*perros|perros.*gatos/);
  });

  it('does not ask again once species is already known', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'perro', productCategory: 'mascotas' },
      intent: makeIntent({ productCategory: 'mascotas' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-perros')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: [], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('cuánto cuesta'));
    await service.handleMessage({});
    expect(quoting.bestQuote).toHaveBeenCalled();
  });

  it('does not block the existing mixto (which-pet) clarification, which already implies species is known', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tengo un gato y un perro'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('¿Para cuál');
  });
});

// ── DISCOVERY — unclear/unextractable message acknowledgment ────────────────

describe('AgentService — DISCOVERY unclear message handling', () => {
  it('regression — message with no extractable signal gets an acknowledgment, not a silent verbatim repeat', async () => {
    // Simulates a short/unclear voice transcription (e.g. "mmh", static, mumbling) —
    // NLP extracts nothing. Repeating the exact same question with no acknowledgment
    // reads as the agent ignoring the user, breaking the "transmite confianza" criterion.
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/no logré entender|no te entendí|no entendí bien/i);
  });

  it('does not show the "no entendí" acknowledgment when partial progress was made', async () => {
    // productCategory was extracted this turn (progress) even though coverage/beneficiaries
    // are still missing — this must NOT be treated as an unclear/no-signal message.
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero un seguro de vida'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender|no te entendí|no entendí bien/i);
  });

  it('regression — quotes a named category even when coverage is empty (fallback NLP never fills coverage)', async () => {
    // Real live-test bug: GroqNlpService.fallbackIntent() (used whenever Groq is
    // unreachable, e.g. LLM_API_KEY unset) always returns coverage: [] — it has no
    // keyword extraction for coverage at all. hasEnoughInfo required BOTH productCategory
    // AND coverage.length, so a clear category signal ("vida, accidentes y asistencia
    // médica") got stuck re-asking the same generic DISCOVERY question forever, even
    // though QuotingService.evaluateProduct only needs productCategory to score a
    // product > 0 — coverage is a scoring bonus there, never a hard requirement.
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'vida', coverage: [] }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('vida, accidentes y asistencia médica'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });

  it('regression — attempts a quote instead of looping forever on the unanswerable "ages" question', async () => {
    // Real live-test bug: once coverage and beneficiaries are both known (usually from a
    // spurious Groq default — its schema example shows "beneficiaries": 1) but
    // productCategory was never extracted, STATE_RESPONSES[DISCOVERY] asks "¿En qué rango
    // de edades están?" forever — no field in the intent schema captures a human
    // beneficiary's age (only petAge, for pets), and QuotingService never uses ages at
    // all, so this question can NEVER be answered. Live conversation looped 4+ turns on
    // exactly this ("todos", pet ages, "yo tengo 33", family ages) with productCategory
    // stuck at null the entire time.
    const anyProduct = PRODUCTS[0];
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { coverage: ['todos'], beneficiaries: 1 },
      intent: makeIntent({ productCategory: null, coverage: [], beneficiaries: 1 }),
    });
    quoting.bestQuote.mockReturnValue({
      product: anyProduct,
      score: { reasons: [], matchScore: 20, monthlyPremium: anyProduct.basePremium, priority: 'low', productId: anyProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Un perrito tiene 7 años, otro 3 y la gatita tiene 10, yo tengo 33.'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('rango de edades');
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });
});

// ── DISCOVERY — lost-context resilience ──────────────────────────────────────

describe('AgentService — DISCOVERY lost-context resilience', () => {
  it('regression — ages answer with lost petType (coverage set) does not re-trigger mixto loop', async () => {
    // Simulates context.petType being lost (e.g., server restart wiped cache) but
    // coverage survived in DB. Without the guard, intent.petType='mixto' would cause
    // the clarification question to fire again indefinitely.
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: null, coverage: ['medicina veterinaria'], productCategory: null },
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    quoting.bestQuote.mockReturnValue({
      product: petProduct,
      score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('10 años mi gata, 7 años mi perro y 33 yo'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('familia de mascotas');
    expect(sentText).not.toContain('Para cuál');
    const saveCall = conversations.saveState.mock.calls[0];
    if (saveCall) expect(saveCall[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });
});

// ── Post-purchase cross-sell decline (2026-07-24 live bug) ────────────────────
// After a purchase, wompi-webhook.controller.ts asks "¿Quieres proteger algo más?" and
// resets the conversation to DISCOVERY. A decline ("No, está bien así.") used to fall
// through DISCOVERY's generic "no entendí" acknowledgment — the agent literally
// ignoring a clear, polite "I'm done" right after a purchase.
describe('AgentService — DISCOVERY polite decline of the post-purchase cross-sell offer', () => {
  it('regression — declining ends the conversation politely instead of "no entendí"', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', awaitingCrossSellResponse: true },
      intent: makeIntent({ isNegative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('No, está bien así.'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender/i);
    expect(sentText.toLowerCase()).toMatch(/gracias|perfecto|hasta luego|aquí estoy|cuando quieras/);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.objectContaining({ awaitingCrossSellResponse: undefined }),
    );
  });

  it('does not end the conversation when the user names a new category instead of declining', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', awaitingCrossSellResponse: true },
      intent: makeIntent({ productCategory: 'vida' }),
    });
    const vidaProduct = PRODUCTS.find(p => p.id === 'vida')!;
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: ['Para vida'], matchScore: 60, monthlyPremium: vidaProduct.basePremium, priority: 'high', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí, quiero uno de vida'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.COMPLETED, expect.anything(),
    );
  });
});

// ── Fuzz tests ────────────────────────────────────────────────────────────────

describe('AgentService FUZZ — cédula validation', () => {
  const validCedulas = ['100000', '1234567', '12345678', '123456789', '1234567890'];
  const invalidCedulas = ['', '12345', '12345678901', 'abc', '1234 5678', '123-456', '12.345.678'];

  it.each(validCedulas)('valid cédula "%s" passes validation (6-10 digits)', async (cedula) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage(cedula));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.cedula).toBe(cedula);
  });

  it.each(invalidCedulas)('invalid cédula "%s" is rejected', async (cedula) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage(cedula));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    // Either saveState was not called (if no context change) or cedula is not set
    if (savedContext) {
      expect(savedContext.cedula).toBeUndefined();
    }
  });
});

// Real live-test bug: dictating a cédula digit-by-digit by voice ("uno, dos, tres...")
// gets transcribed with commas between each individual digit ("1, 2, 3, 4, 5, 6, 7, 8,
// 9") — the existing \b\d{6,10}\b regex needs a CONTIGUOUS digit run, so this never
// matched at all. Must NOT affect the existing, intentionally-rejected typed-formatted
// cases ("12.345.678", "1234 5678") — those use multi-digit groups, not lone digits.
describe('AgentService — cédula dictated digit-by-digit with commas (2026-07-24 live bug)', () => {
  it.each([
    ['1, 2, 3, 4, 5, 6, 7, 8, 9', '123456789'],
    ['1, 2, 3, 4, 5, 6', '123456'],
    ['1,2,3,4,5,6,7,8,9,0', '1234567890'],
  ])('joins spoken lone digits "%s" into "%s"', async (spoken, expected) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage(spoken));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.cedula).toBe(expected);
  });

  it('regression — still rejects a typed formatted cédula with period thousand-separators ("12.345.678")', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('12.345.678'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext | undefined;
    if (savedContext) expect(savedContext.cedula).toBeUndefined();
  });

  it('regression — still rejects a typed cédula with a single space-separated group ("1234 5678")', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('1234 5678'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext | undefined;
    if (savedContext) expect(savedContext.cedula).toBeUndefined();
  });
});

describe('AgentService FUZZ — confirmation variants', () => {
  const confirmVariants = ['sí', 'si', 'Sí', 'Si', 'SÍ', 'SI', 'Sí.', 'sí!', 'sí,', ' sí '];

  it.each(confirmVariants)('"%s" is treated as confirmation in AUTHORIZATION', async (text) => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage(text));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.objectContaining({ autorizado: true }),
    );
  });
});

// 2026-07-24: "not let user record integers or special characters in fields where it's
// not allowed" — random-input fuzzing for the nombre field, on top of the fixed-list
// regression tests above.
describe('AgentService FUZZ — nombre never accepts digits/symbols', () => {
  function randomGarbageName(): string {
    const pool = '0123456789!@#$%^&*()_+=<>{}[]';
    const len = 1 + Math.floor(Math.random() * 15);
    let out = '';
    for (let i = 0; i < len; i++) out += pool[Math.floor(Math.random() * pool.length)];
    return out;
  }

  function randomValidSpanishName(): string {
    // No single-character syllables here (e.g. a lone "a") — isValidHumanName correctly
    // requires length >= 2, and a random single-letter word would make this generator
    // occasionally produce a name the real validator (correctly) rejects, flaking the test.
    const syllables = ['ma', 'ra', 'lo', 'fer', 'nan', 'do', 'gar', 'cí', 'lu', 'pe', 'rez', 'sán', 'chez', 'ñu'];
    const wordCount = 1 + Math.floor(Math.random() * 3);
    const words: string[] = [];
    for (let w = 0; w < wordCount; w++) {
      const sylCount = 1 + Math.floor(Math.random() * 3);
      let word = '';
      for (let s = 0; s < sylCount; s++) word += syllables[Math.floor(Math.random() * syllables.length)];
      words.push(word.charAt(0).toUpperCase() + word.slice(1));
    }
    return words.join(' ');
  }

  it('never accepts a random digit/symbol string as nombre (50 random samples)', async () => {
    for (let i = 0; i < 50; i++) {
      const garbage = randomGarbageName();
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(garbage));
      await service.handleMessage({});
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext | undefined;
      expect(savedContext?.nombre).toBeUndefined();
    }
  });

  it('always accepts a random letters-only Spanish-shaped name (50 random samples)', async () => {
    for (let i = 0; i < 50; i++) {
      const name = randomValidSpanishName();
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(name));
      await service.handleMessage({});
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext | undefined;
      expect(savedContext?.nombre).toBe(name);
    }
  });
});

// INVARIANT: the conditional-underwriting question (age/illness/clinical history) must
// appear if and only if the quoted product's catalog entry has requiresUnderwriting —
// swept across the ENTIRE real catalog so a future product addition/removal can't
// silently drift from the business rule without a test noticing.
describe('AgentService INVARIANT — underwriting question matches catalog flag for every product', () => {
  it.each(PRODUCTS.map((p) => [p.id, !!p.requiresUnderwriting] as const))(
    'product "%s" (requiresUnderwriting=%s) asks for medical info iff the flag is set',
    async (productId, expectMedicalQuestion) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: productId },
      });
      telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
      if (expectMedicalQuestion) {
        expect(sentText).toMatch(/edad|enfermedad|historial/i);
        expect(savedContext.awaitingMedicalInfo).toBe(true);
      } else {
        expect(sentText).not.toMatch(/edad|enfermedad|historial/i);
        expect(savedContext.awaitingMedicalInfo).toBeFalsy();
      }
    },
  );
});
