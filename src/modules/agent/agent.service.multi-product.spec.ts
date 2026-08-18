// agent.service.multi-product.spec.ts: the backend half of buying 2+ different products
// in one purchase — one combined Wompi payment, one policy row + PDF per product (see
// createPaymentLinkFlow and PolicyService.findAllByWompiLinkId). As of 2026-07-24
// ("restore the flow"), nothing in the live agent conversation sets
// context.selectedProductIds automatically anymore — a quote in progress is never
// interrupted by a mention of a different category (see deferCrossSell in
// agent.service.ts). These tests cover the DATA_CAPTURE/payment machinery directly by
// constructing a context with selectedProductIds already set, so it keeps working
// correctly if that field is ever populated some other way.
import { ConversationState } from './types';
import { ProductCatalog } from '../quoting/product-catalog.service';
import { makeMessage, makeIntent, buildService } from './agent.service.test-helpers';

// Read from the runtime catalog, not a fixture copy: a price that drifts in the YAML
// has to break a test, not pass one.
const PRODUCTS = new ProductCatalog().getProducts();

describe('AgentService — multi-product purchase: pet details still collected when mascotas is not the primary category', () => {
  // Real gap: when mascotas isn't the first entry in selectedProductIds, a strict
  // `productCategory === 'mascotas'` check would skip collecting per-pet name/age/breed
  // entirely — isPetSelected checks the whole set, not just the primary category.
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
  // 2026-07-24: "sí" now issues the policies immediately (unchanged) but asks the
  // payment method (Tarjeta Colsubsidio vs. link de pago) before generating the Wompi
  // link — see the payment-method-choice describe block in agent.service.spec.ts. The
  // combined-amount payment link itself is created on the FOLLOW-UP turn once that
  // question is answered.
  it('confirming with 2 selected products issues 2 policies and asks how to pay (link not generated yet)', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, policy, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        selectedProductIds: [vidaProduct.id, petProduct.id],
        quoteProductId: vidaProduct.id,
        // Pet details already collected in an earlier turn — this test is about policy
        // issuance, not the pet-collection step (covered separately above).
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
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/tarjeta colsubsidio|link de pago/);
  });

  it('answering the payment method question creates one combined payment link for both products', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        selectedProductIds: [vidaProduct.id, petProduct.id],
        quoteProductId: vidaProduct.id,
        policyId: 'pol-vida', policyIds: ['pol-vida', 'pol-mascotas'],
        awaitingPaymentMethodChoice: true,
        petCount: 1, pets: [{ name: 'Max', age: '3 años', breed: 'Labrador' }],
        cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('link de pago'));
    await service.handleMessage({});

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
        policyId: 'pol-vida', policyIds: ['pol-vida', 'pol-mascotas'],
        awaitingPaymentMethodChoice: true,
        petCount: 1, pets: [{ name: 'Max', age: '3 años', breed: 'Labrador' }],
        cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('link de pago'));
    await service.handleMessage({});

    expect(policy.updateStatus).toHaveBeenCalledWith('pol-vida', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }));
    expect(policy.updateStatus).toHaveBeenCalledWith('pol-mascotas', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }));
  });
});
