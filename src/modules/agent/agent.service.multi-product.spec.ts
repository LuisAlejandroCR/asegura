// agent.service.multi-product.spec.ts: buying 2+ different products in one purchase
// ("quiero los dos", "mascotas y vida") — one combined Wompi payment, one policy row +
// PDF per product. See agent.service.ts's resolveMultiProductSelection / buildMultiQuote /
// createPaymentLinkFlow, and PolicyService.findAllByWompiLinkId for the webhook side.
import { ConversationState } from './types';
import { PRODUCTS } from '../quoting/products.data';
import { makeMessage, makeIntent, buildService } from './agent.service.test-helpers';

function bestQuoteByCategory(productsByCategory: Record<string, any>) {
  return (signals: any) => productsByCategory[signals.productCategory] ?? null;
}

describe('AgentService — multi-product selection: naming two categories at once', () => {
  it('shows both quotes with a combined total when the user names two categories in one message', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', shownProductIds: [petProduct.id] },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    quoting.bestQuote.mockImplementation(bestQuoteByCategory({
      vida: { product: vidaProduct, score: { reasons: [], monthlyPremium: vidaProduct.basePremium } },
      mascotas: { product: petProduct, score: { reasons: [], monthlyPremium: petProduct.basePremium } },
    }));
    telegram.normalize.mockResolvedValue(makeMessage('Escojo mascotas y seguro de vida.'));
    await service.handleMessage({});

    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
    expect(sentText).toContain(petProduct.name);
    expect(sentText).toContain((vidaProduct.basePremium + petProduct.basePremium).toLocaleString('es-CO'));

    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    expect(saveCall?.[2].selectedProductIds).toEqual(
      expect.arrayContaining([vidaProduct.id, petProduct.id]),
    );
  });
});

describe('AgentService — multi-product selection: "los dos" / "ambos"', () => {
  it('selects every product already shown when the user says "los dos"', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida', shownProductIds: [petProduct.id, vidaProduct.id] },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero los dos'));
    await service.handleMessage({});

    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
    expect(sentText).toContain(petProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[2].selectedProductIds).toEqual(
      expect.arrayContaining([vidaProduct.id, petProduct.id]),
    );
  });

  it('does not trigger multi-select from "los dos" when only one product has been shown', async () => {
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', shownProductIds: [petProduct.id] },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero los dos'));
    await service.handleMessage({});
    // Falls through to the normal neutral re-display — no crash, no bogus multi-select
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(petProduct.name);
  });
});

describe('AgentService — multi-product selection: additive "incluye también X"', () => {
  it('adds the named category to the currently viewed product', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida', shownProductIds: [vidaProduct.id] },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    quoting.bestQuote.mockImplementation(bestQuoteByCategory({
      mascotas: { product: petProduct, score: { reasons: [], monthlyPremium: petProduct.basePremium } },
    }));
    telegram.normalize.mockResolvedValue(makeMessage('Incluye también el de mascotas.'));
    await service.handleMessage({});

    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
    expect(sentText).toContain(petProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[2].selectedProductIds).toEqual(
      expect.arrayContaining([vidaProduct.id, petProduct.id]),
    );
  });
});

describe('AgentService — multi-product purchase: pet details still collected when mascotas is not the primary category', () => {
  // Real gap: buildMultiQuote sets productCategory to the FIRST selected product's
  // category (e.g. "vida"), so a strict `productCategory === 'mascotas'` check would skip
  // collecting per-pet name/age/breed entirely whenever mascotas isn't first in the list.
  it('still collects the pet name/age/breed when mascotas is among selectedProductIds but not the primary category', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        selectedProductIds: [vidaProduct.id, petProduct.id],
        quoteProductId: vidaProduct.id,
        productCategory: 'vida',
        petCount: 1,
      },
      intent: makeIntent({ petName: 'Max', petAge: '3 años', petBreed: 'labrador' }),
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ pets: [{ name: 'Max', age: '3 años', breed: 'Labrador' }] }),
    );
  });
});

describe('AgentService — multi-product purchase: DATA_CAPTURE issues one policy per product', () => {
  it('confirming with 2 selected products issues 2 policies and creates one combined payment link', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, policy, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        selectedProductIds: [vidaProduct.id, petProduct.id],
        quoteProductId: vidaProduct.id,
        // Pet details already collected in an earlier turn — this test is about policy
        // issuance/payment, not the pet-collection step (covered separately above).
        petCount: 1, pets: [{ name: 'Max', age: '3 años', breed: 'Labrador' }],
        cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
      },
      intent: makeIntent({ isAffirmative: true }),
    });
    policy.issue
      .mockResolvedValueOnce({ policyId: 'pol-vida' })
      .mockResolvedValueOnce({ policyId: 'pol-mascotas' });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});

    expect(policy.issue).toHaveBeenCalledTimes(2);
    expect(wompi.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amountCOP: vidaProduct.basePremium + petProduct.basePremium }),
    );
  });

  it('updates every issued policy with the same combined payment link id', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, policy } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        selectedProductIds: [vidaProduct.id, petProduct.id],
        quoteProductId: vidaProduct.id,
        // Pet details already collected in an earlier turn — this test is about policy
        // issuance/payment, not the pet-collection step (covered separately above).
        petCount: 1, pets: [{ name: 'Max', age: '3 años', breed: 'Labrador' }],
        cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
      },
      intent: makeIntent({ isAffirmative: true }),
    });
    policy.issue
      .mockResolvedValueOnce({ policyId: 'pol-vida' })
      .mockResolvedValueOnce({ policyId: 'pol-mascotas' });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});

    expect(policy.updateStatus).toHaveBeenCalledWith('pol-vida', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }));
    expect(policy.updateStatus).toHaveBeenCalledWith('pol-mascotas', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }));
  });
});
