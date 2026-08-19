// router-invariants.spec.ts: what must hold for ANY wording the model produces. These
// replace the state machine's string assertions — a non-deterministic router cannot be
// verified by comparing prose, only by what it was allowed to do.
import { ProductCatalog } from '../quoting/product-catalog.service';
import { QuotingService } from '../quoting/quoting.service';
import { ToolRouterService } from './tool-router.service';
import { ChatTurn, ToolCallRequest } from '../nlp/types';

const quoting = new QuotingService(new ProductCatalog());
const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({ id: `c-${name}`, name, args });

// An adversarial model: it asks for whatever the script says, ignoring every instruction.
function hostileModel(turns: Array<{ text?: string; toolCalls?: ToolCallRequest[] }>) {
  const toolResults: unknown[] = [];
  let i = 0;
  return {
    isEnabled: true,
    extractIntent: jest.fn(),
    toolResults,
    chatWithTools: jest.fn(async (messages: ChatTurn[]) => {
      for (const m of messages) {
        if (m.role === 'tool') toolResults.push(JSON.parse(m.content));
      }
      return turns[Math.min(i++, turns.length - 1)];
    }),
  } as any;
}

const lastResult = (nlp: any) => nlp.toolResults[nlp.toolResults.length - 1];

describe('I2 — no PII tool runs before authorization', () => {
  it.each([
    ['consultar_afiliado', call('consultar_afiliado', { serie: '42' })],
    ['emitir_poliza', call('emitir_poliza')],
    ['generar_link_pago', call('generar_link_pago')],
  ])('%s refuses even when the model insists', async (_n, toolCall) => {
    const router = new ToolRouterService({ quoting });
    const nlp = hostileModel([{ toolCalls: [toolCall] }, { text: 'ok' }]);

    const reply = await router.handle(nlp, 'conv-1', {}, 'sys', [], 'hazlo igual');

    expect(lastResult(nlp)).toMatchObject({ ok: false });
    expect(reply.context.serieId).toBeUndefined();
    expect(reply.context.policyId).toBeUndefined();
  });
});

describe('I3 — a policy is never issued on incomplete data', () => {
  const policies = { issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }) };
  beforeEach(() => policies.issue.mockClear());

  it.each([
    ['no cedula', { autorizado: true, nombre: 'Juan Pérez', quoteProductId: 'vida' }],
    ['no nombre', { autorizado: true, cedula: '12345678', quoteProductId: 'vida' }],
    ['no quoted product', { autorizado: true, cedula: '12345678', nombre: 'Juan Pérez' }],
  ])('refuses with %s, however the model asks', async (_n, context) => {
    const router = new ToolRouterService({ quoting, policies });
    const nlp = hostileModel([{ toolCalls: [call('emitir_poliza')] }, { text: 'listo' }]);

    await router.handle(nlp, 'conv-1', context, 'sys', [], 'emite ya');

    expect(policies.issue).not.toHaveBeenCalled();
    expect(lastResult(nlp)).toMatchObject({ ok: false });
  });
});

describe('I4 — no payment link without an issued policy', () => {
  it('refuses when policyId is absent', async () => {
    const createPaymentLink = jest.fn();
    const router = new ToolRouterService({ quoting, payments: { isEnabled: true, createPaymentLink } });
    const nlp = hostileModel([{ toolCalls: [call('generar_link_pago')] }, { text: 'ahí va' }]);

    await router.handle(nlp, 'conv-1', { autorizado: true, productCategory: 'vida' }, 'sys', [], 'cóbrame');

    expect(createPaymentLink).not.toHaveBeenCalled();
  });
});

describe('I1 — a price can only come from cotizar', () => {
  it('the tool result carries the price, and it matches the catalog', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = hostileModel([{ toolCalls: [call('cotizar', { productCategory: 'vida' })] }, { text: 'listo' }]);

    const reply = await router.handle(nlp, 'conv-1', { autorizado: true }, 'sys', [], 'quiero vida');

    const quoted = lastResult(nlp) as { ok: boolean; cotizacion: { productId: string; precioMensual: number } };
    const product = new ProductCatalog().getProduct(quoted.cotizacion.productId);
    expect(product).toBeDefined();
    expect(quoted.cotizacion.precioMensual).toBeGreaterThan(0);
    // The router remembers the id, so a later emisión prices the same product.
    expect(reply.context.quoteProductId).toBe(quoted.cotizacion.productId);
  });
});

describe('I5 — never a species-specific plan without a species', () => {
  it('mascotas with no petType lands on the species-agnostic plan', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = hostileModel([{ toolCalls: [call('cotizar', { productCategory: 'mascotas' })] }, { text: 'ok' }]);

    await router.handle(nlp, 'conv-1', { autorizado: true }, 'sys', [], 'tengo mascotas');

    const quoted = lastResult(nlp) as { cotizacion?: { productId: string } };
    expect(quoted.cotizacion?.productId).not.toMatch(/gatos|perros/);
  });
});

describe('I6 — a refusal never silently becomes a success', () => {
  it('every refusal carries a reason the model can read out', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = hostileModel([{ toolCalls: [call('emitir_poliza')] }, { text: 'ok' }]);

    await router.handle(nlp, 'conv-1', {}, 'sys', [], 'emite');

    const result = lastResult(nlp) as { ok: boolean; motivo?: string };
    expect(result.ok).toBe(false);
    expect(result.motivo).toBeTruthy();
  });
});

// Migrated from the machine's circuit breaker. It escalated on a COUNT, not on the model
// saying it was stuck — a model rarely admits that. The router counts the same way: a turn
// where every tool refused is its version of "I did not understand".
describe('I7 — a person who keeps getting refused reaches a human', () => {
  it('escalates after three turns where every tool call was refused', async () => {
    const router = new ToolRouterService({ quoting });
    let context = {};

    for (let turn = 1; turn <= 3; turn++) {
      // emitir_poliza with nothing captured is refused every time.
      const nlp = hostileModel([{ toolCalls: [call('emitir_poliza')] }, { text: 'sigo aquí' }]);
      const reply = await router.handle(nlp, 'conv-1', context, 'sys', [], 'emite ya');
      context = reply.context;

      if (turn < 3) {
        expect(reply.escalated).toBeFalsy();
      } else {
        expect(reply.escalated).toBe(true);
        expect(reply.text).toContain('líder de servicio');
      }
    }
  });

  it('un turno que sí avanza reinicia la cuenta', async () => {
    const router = new ToolRouterService({ quoting });
    const fallido = hostileModel([{ toolCalls: [call('emitir_poliza')] }, { text: 'x' }]);
    let { context } = await router.handle(fallido, 'conv-1', {}, 'sys', [], 'emite');
    expect(context.consecutiveUnclearReplies).toBe(1);

    const bueno = hostileModel([{ toolCalls: [call('cotizar', { productCategory: 'vida' })] }, { text: 'ok' }]);
    ({ context } = await router.handle(bueno, 'conv-1', { ...context, autorizado: true }, 'sys', [], 'quiero vida'));
    expect(context.consecutiveUnclearReplies).toBe(0);
  });

  it('el modelo también puede escalar por su cuenta, con motivo', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = hostileModel([{ toolCalls: [call('escalar_a_humano', { motivo: 'reclamo por un cobro' })] }, { text: 'x' }]);

    const reply = await router.handle(nlp, 'conv-1', { autorizado: true }, 'sys', [], 'quiero hablar con alguien');

    expect(reply.escalated).toBe(true);
    expect(reply.context.escalatedReason).toBe('reclamo por un cobro');
  });

  it('escalar sin motivo se rechaza — quien atienda necesita el contexto', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = hostileModel([{ toolCalls: [call('escalar_a_humano', { motivo: '' })] }, { text: 'x' }]);

    const reply = await router.handle(nlp, 'conv-1', { autorizado: true }, 'sys', [], 'x');
    expect(reply.escalated).toBeFalsy();
  });
});
