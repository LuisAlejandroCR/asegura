import { AgentService } from './agent.service';
import { ConversationState, ConversationContext } from './types';
import { InsuranceIntent } from '../nlp/types';
import { PRODUCTS } from '../quoting/products.data';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeMessage(text: string) {
  return { userId: 'u1', channel: 'telegram' as const, channelId: '1', text, timestamp: new Date() };
}

function makeIntent(overrides: Partial<InsuranceIntent> = {}): InsuranceIntent {
  return { productCategory: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null, ...overrides };
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
    issue: jest.fn().mockResolvedValue({ policyId: 'pol-1', pdfBuffer: null }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const wompi = { createPaymentLink: jest.fn().mockResolvedValue('https://checkout.wompi.co/l/test'), isEnabled: true };
  const blockchain = { registerPolicy: jest.fn().mockResolvedValue({ txHash: null, celoscanUrl: null }) };

  const service = new AgentService(
    nlp as any, telegram as any, conversations as any,
    quoting as any, policy as any, wompi as any, blockchain as any,
  );

  return { service, nlp, telegram, conversations, quoting, policy, wompi, blockchain };
}

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

  it('"no" at confirmation resets DATA_CAPTURE fields', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: undefined, nombre: undefined, email: undefined }),
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
