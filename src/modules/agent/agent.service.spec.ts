import { AgentService } from './agent.service';
import { ConversationState, ConversationContext } from './types';
import { InsuranceIntent } from '../nlp/types';
import { PRODUCTS } from '../quoting/products.data';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeMessage(text: string) {
  return { userId: 'u1', channel: 'telegram' as const, channelId: '1', text, timestamp: new Date() };
}

function makeIntent(overrides: Partial<InsuranceIntent> = {}): InsuranceIntent {
  return { productCategory: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null, petCount: null, ...overrides };
}

function extractPetResolutionMock(lower: string): 'gato' | 'perro' | 'all' | null {
  const hasCat = lower.includes('gato') || lower.includes('michi') || lower.includes('felino');
  const hasDog = lower.includes('perro') || lower.includes('canino');
  const hasAll = lower.includes('todos') || lower.includes('ambos') || lower.includes('los dos');
  if (hasCat && !hasDog) return 'gato';
  if (hasDog && !hasCat) return 'perro';
  if (hasAll) return 'all';
  return null;
}

function makeConversation(state: ConversationState, context: ConversationContext = {}) {
  return { id: 'conv-1', user_id: 'u1', channel: 'telegram', state, context };
}

function buildService(overrides: {
  state?: ConversationState;
  context?: ConversationContext;
  intent?: InsuranceIntent;
} = {}) {
  const state = overrides.state ?? ConversationState.GREETING;
  const context = overrides.context ?? {};
  const staticIntent = overrides.intent;

  const nlp = {
    extractIntent: jest.fn().mockImplementation(async (text: string) => {
      if (staticIntent) return staticIntent;
      const lower = text.toLowerCase();
      return makeIntent({
        isAffirmative: ['sí', 'si', 'claro', 'me interesa', 'quiero', 'perfecto', 'adelante', 'todos', 'todas', 'ambos', 'hagámoslo', 'confirmo', 'listo', 'dale'].some((a) => lower.includes(a)),
        isNegative: ['no', 'paso', 'otro', 'otra', 'diferente', 'ninguno', 'ninguna', 'después', 'luego'].some((n) => lower.includes(n)),
        wantsAlternative: ['otro', 'otra', 'diferente', 'muéstrame más', 'más opciones', 'cambia', 'cambiar', 'siguiente'].some((a) => lower.includes(a)),
        petResolution: extractPetResolutionMock(lower),
      });
    }),
  };
  const telegram = {
    normalize: jest.fn().mockResolvedValue(makeMessage('test')),
    sendText: jest.fn().mockResolvedValue(undefined),
    sendDocument: jest.fn().mockResolvedValue(undefined),
  };
  const conversations = {
    getOrCreate: jest.fn().mockResolvedValue(makeConversation(state, context)),
    saveState: jest.fn().mockResolvedValue(undefined),
  };
  const quoting = {
    score: jest.fn().mockReturnValue([]),
    bestQuote: jest.fn().mockReturnValue(null),
  };
  const policy = {
    issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const wompi = {
    createPaymentLink: jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/test', paymentLinkId: 'link-test' }),
    isEnabled: true,
  };
  const service = new AgentService(
    nlp as any, telegram as any, conversations as any,
    quoting as any, policy as any, wompi as any,
  );

  return { service, nlp, telegram, conversations, quoting, policy, wompi };
}

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
  it('sends greeting message followed by authorization request as two separate messages', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.GREETING });
    telegram.normalize.mockResolvedValue(makeMessage('hola'));
    await service.handleMessage({});
    // Must send exactly 2 messages: greeting then authorization
    expect(telegram.sendText).toHaveBeenCalledTimes(2);
    const firstCall = telegram.sendText.mock.calls[0][1] as string;
    const secondCall = telegram.sendText.mock.calls[1][1] as string;
    expect(firstCall).toContain('Asegura');
    expect(secondCall).toContain('Ley 1581');
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

  it('regression — "sí" at confirmation generates the payment link immediately, no extra "listo?" question', async () => {
    // User feedback: "¿Listo para generar tu link de pago?" was an unnecessary second
    // confirmation — the user already said "sí" to the purchase summary. Generate and
    // send the real Wompi link right away; this should just be informative, not another ask.
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('checkout.wompi.co');
    expect(sentText).not.toContain('¿Listo para generar');
  });

  it('persists checkoutUrl and wompi_link_id in the same turn as the DATA_CAPTURE confirmation', async () => {
    const { service, telegram, conversations, policy } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', policyId: 'pol-1', quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.PAYMENT, expect.objectContaining({ checkoutUrl: 'https://checkout.wompi.co/l/test' }),
    );
    expect(policy.updateStatus).toHaveBeenCalledWith('pol-1', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }));
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

// ── QUOTE_PRESENTED — cross-sell for the human owner ──────────────────────────

describe('AgentService — QUOTE_PRESENTED cross-sell for personal coverage', () => {
  it('regression — asking about coverage "para mí" during a pet quote offers to shop for the human, not a repeat of the pet quote', async () => {
    // Real live-test bug: "Me interesan mascotas y para mí ¿qué hay?" and "¿Me interesa
    // ese de mascotas? ¿Para mí qué hay?" both got no real answer — the pet quote's own
    // text promises "Para ti también tenemos seguros... cuéntame si los quieres ver" but
    // no code path ever followed up on that promise.
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petType: 'gato', petCount: 1 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Me interesan mascotas y para mí ¿qué hay?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain(petProduct.name);
    expect(sentText.toLowerCase()).toMatch(/vida|accidentes|asistencia/);
    // Redirects to DISCOVERY to shop for the human's own product, keeping the pet quote intact
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.objectContaining({ quoteProductId: petProduct.id }),
    );
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
  it('petCount from intent is saved to context', async () => {
    const { service, conversations, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: null, coverage: ['medicina veterinaria'], productCategory: 'mascotas' },
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
      context: { petType: null, coverage: ['medicina veterinaria'], productCategory: 'mascotas', petCount: 3 },
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
      context: { petType: null, coverage: ['medicina veterinaria'], productCategory: 'mascotas', petCount: 3 },
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
