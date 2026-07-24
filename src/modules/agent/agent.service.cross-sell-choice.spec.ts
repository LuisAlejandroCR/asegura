// agent.service.cross-sell-choice.spec.ts: covers the explicit "uno por uno" vs "todas a
// la vez" choice offered after a pet quote, when the user asks about personal coverage
// without naming one specific category (see agent.service.ts handleQuotation cross-sell
// branch and handleDiscovery's crossSellOffered handling).
import { ConversationState } from './types';
import { PRODUCTS } from '../quoting/products.data';
import { makeMessage, makeIntent, buildService } from './agent.service.test-helpers';

describe('AgentService — cross-sell offer is explicit about the choice', () => {
  it('the cross-sell offer message asks whether the user wants one-by-one or all at once', async () => {
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 1 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('y para mí, qué hay de salud y accidentes'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/uno por uno/);
    expect(sentText.toLowerCase()).toMatch(/(todas|todos|los tres|a la vez)/);
  });
});

describe('AgentService — cross-sell choice: all at once', () => {
  it('shows all three personal-coverage quotes when the user asks for all at once', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const accidentesProduct = PRODUCTS.find(p => p.category === 'accidentes')!;
    const asistenciaProduct = PRODUCTS.find(p => p.category === 'asistencia')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { crossSellOffered: true },
      intent: makeIntent({ productCategory: null }),
    });
    quoting.bestQuote.mockImplementation((signals: any) => {
      const byCategory: Record<string, any> = {
        vida: { product: vidaProduct, score: { reasons: [], monthlyPremium: vidaProduct.basePremium } },
        accidentes: { product: accidentesProduct, score: { reasons: [], monthlyPremium: accidentesProduct.basePremium } },
        asistencia: { product: asistenciaProduct, score: { reasons: [], monthlyPremium: asistenciaProduct.basePremium } },
      };
      return byCategory[signals.productCategory] ?? null;
    });
    telegram.normalize.mockResolvedValue(makeMessage('muéstrame las tres de una vez'));
    await service.handleMessage({});

    const sentTexts = telegram.sendText.mock.calls.map((c: any[]) => c[1] as string);
    expect(sentTexts.join('\n')).toContain(vidaProduct.name);
    expect(sentTexts.join('\n')).toContain(accidentesProduct.name);
    expect(sentTexts.join('\n')).toContain(asistenciaProduct.name);

    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    const savedContext = saveCall?.[2];
    expect(savedContext.shownProductIds).toEqual(
      expect.arrayContaining([vidaProduct.id, accidentesProduct.id, asistenciaProduct.id]),
    );
    expect(savedContext.crossSellOffered).toBe(false);
  });

  it('does not trigger "all at once" outside a cross-sell context (crossSellOffered not set)', async () => {
    // Guard: "todos" is also the trigger for the unrelated mixed-pet "para todos" reply —
    // this must only fire when crossSellOffered is explicitly true.
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('todos'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
  });
});

describe('AgentService — cross-sell choice: one at a time', () => {
  it('asks which category first when the user explicitly chooses one-by-one', async () => {
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { crossSellOffered: true },
      intent: makeIntent({ productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('uno por uno'));
    await service.handleMessage({});

    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/vida|accidentes|asistencia/);
    // Stays in DISCOVERY, still waiting for a specific category next
    if (conversations.saveState.mock.calls.length > 0) {
      const saveCall = conversations.saveState.mock.calls[0];
      expect(saveCall?.[1]).not.toBe(ConversationState.QUOTE_PRESENTED);
    }
  });

  it('naming a specific category directly still works after "uno por uno" was chosen', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { crossSellOffered: true },
      intent: makeIntent({ productCategory: 'vida' }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], monthlyPremium: vidaProduct.basePremium },
    });
    telegram.normalize.mockResolvedValue(makeMessage('vida'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    expect(saveCall?.[2].crossSellOffered).toBe(false);
  });
});
