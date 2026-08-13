// agent.service.web-quote.spec.ts: WebReply.quote is singular, so a mixed-species
// household (cat + dogs = two products) rendered a card showing only the FIRST product's
// price — $81.800 next to the label "Tu prima mensual" when the real total was $275.000,
// a 3.4x understatement. Found by driving texto.html end-to-end (2026-08-13).
// `quotes` carries every line with its own count and subtotal, plus the real total.

import { buildService } from './agent.service.test-helpers';
import { ConversationState } from './types';

const GATO = 81800; // VetPlus medicina prepagada gatos
const PERRO = 96600; // VetPlus medicina prepagada perros

// Neither affirmative nor an alternative request, so the turn re-shows the quote and
// stays in QUOTE_PRESENTED — which is exactly the state the card renders from.
const NEUTRAL_INTENT = {
  productCategory: 'mascotas' as const,
  coverage: [],
  beneficiaries: 1,
  urgency: 'exploring' as const,
  isAffirmative: false,
  isNegative: false,
  wantsAlternative: false,
  petResolution: null,
};

function mixedHouseholdService() {
  return buildService({
    state: ConversationState.QUOTE_PRESENTED,
    context: {
      productCategory: 'mascotas',
      quoteProductId: 'medicina-prepagada-gatos',
      selectedProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
      petSpeciesCounts: { gato: 1, perro: 2 },
      petCount: 3,
    },
    intent: NEUTRAL_INTENT,
  });
}

describe('WebReply.quotes — mixed-species household (1 cat + 2 dogs)', () => {
  it('returns one line per product, each with its OWN species count and subtotal', async () => {
    const { service } = mixedHouseholdService();
    const reply = await service.handleWebMessage('conv-1', { text: 'cuéntame más' });

    expect(reply.quotes).toHaveLength(2);
    const [gato, perro] = reply.quotes!;

    expect(gato.producto).toMatch(/gato/i);
    expect(gato.precioUnitario).toBe(GATO);
    expect(gato.cantidad).toBe(1);
    expect(gato.subtotal).toBe(GATO);

    expect(perro.producto).toMatch(/perro/i);
    expect(perro.precioUnitario).toBe(PERRO);
    // The original live bug: the dog line must use the DOG count (2), never the combined 3.
    expect(perro.cantidad).toBe(2);
    expect(perro.subtotal).toBe(PERRO * 2);
  });

  it('totalMensual is the sum of every subtotal, not the first product alone', async () => {
    const { service } = mixedHouseholdService();
    const reply = await service.handleWebMessage('conv-1', { text: 'cuéntame más' });

    expect(reply.totalMensual).toBe(GATO + PERRO * 2); // 275.000
    expect(reply.totalMensual).not.toBe(GATO);
  });

  it('keeps the legacy singular `quote` pointing at the first product (voice-tool parity)', async () => {
    const { service } = mixedHouseholdService();
    const reply = await service.handleWebMessage('conv-1', { text: 'cuéntame más' });

    expect(reply.quote).toBeDefined();
    expect(reply.quote!.producto).toMatch(/gato/i);
  });
});

describe('WebReply.quotes — single product', () => {
  it('still returns exactly one line whose subtotal equals the total', async () => {
    const { service } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { productCategory: 'vida', quoteProductId: 'vida' },
      intent: { ...NEUTRAL_INTENT, productCategory: 'vida' as const },
    });

    const reply = await service.handleWebMessage('conv-1', { text: 'cuéntame más' });

    expect(reply.quotes).toHaveLength(1);
    expect(reply.totalMensual).toBe(reply.quotes![0].subtotal);
    expect(reply.quotes![0].cantidad).toBe(1);
  });
});

describe('WebReply.quotes — absent when there is no quote', () => {
  it('omits quotes and totalMensual outside QUOTE_PRESENTED', async () => {
    const { service } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: NEUTRAL_INTENT,
    });

    const reply = await service.handleWebMessage('conv-1', { text: 'hola' });

    expect(reply.quotes).toBeUndefined();
    expect(reply.totalMensual).toBeUndefined();
  });
});
