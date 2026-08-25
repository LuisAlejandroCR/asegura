// router-conversations.spec.ts: the historic live bugs, replayed as scripted conversations
// against the router. The state machine locked these down with exact strings; here they are
// locked down by what the tools were allowed to do and what ended up in context.
import { ProductCatalog } from '../quoting/product-catalog.service';
import { QuotingService } from '../quoting/quoting.service';
import { ToolRouterService } from './tool-router.service';
import { ChatTurn, ToolCallRequest } from '../nlp/types';
import { ConversationContext } from './types';

const catalog = new ProductCatalog();
const quoting = new QuotingService(catalog);
const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({ id: `c-${name}`, name, args });

// Replays one model turn per user turn, so a fixture reads as a conversation.
function scriptedModel(turns: Array<{ text?: string; toolCalls?: ToolCallRequest[] }>) {
  const results: unknown[] = [];
  let i = 0;
  return {
    isEnabled: true,
    extractIntent: jest.fn(),
    results,
    chatWithTools: jest.fn(async (messages: ChatTurn[]) => {
      for (const m of messages) if (m.role === 'tool') results.push(JSON.parse(m.content));
      return turns[Math.min(i++, turns.length - 1)];
    }),
  } as any;
}

// Drives several user turns, threading context the way the channel does between messages.
async function converse(
  router: ToolRouterService,
  nlp: unknown,
  turns: Array<{ user: string }>,
  start: ConversationContext = {},
): Promise<ConversationContext> {
  let ctx = start;
  for (const t of turns) {
    ctx = (await router.handle(nlp as never, 'conv-1', ctx, 'sys', [], t.user)).context;
  }
  return ctx;
}

describe('conversación — autorización antes que nada', () => {
  it('un "Sí." con punto autoriza igual que un "sí" pelado', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = scriptedModel([{ toolCalls: [call('autorizar', { autoriza: true })] }, { text: 'Gracias.' }]);

    const ctx = await converse(router, nlp, [{ user: 'Sí.' }]);
    expect(ctx.autorizado).toBe(true);
  });

  it('un "no" deja la conversación sin autorizar y sin datos', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = scriptedModel([{ toolCalls: [call('autorizar', { autoriza: false })] }, { text: 'Entendido.' }]);

    const ctx = await converse(router, nlp, [{ user: 'no' }]);
    expect(ctx.autorizado).toBe(false);
    expect(ctx.cedula).toBeUndefined();
  });
});

describe('conversación — captura de datos', () => {
  it('la cédula sobrevive al turno en que se captura el nombre', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = scriptedModel([
      { toolCalls: [call('capturar_datos', { cedula: '12345678' })] },
      { text: '¿Tu nombre?' },
      { toolCalls: [call('capturar_datos', { nombre: 'Juan Pérez' })] },
      { text: '¿Tu correo?' },
    ]);

    const ctx = await converse(router, nlp, [{ user: '12345678' }, { user: 'Juan Pérez' }], { autorizado: true });
    expect(ctx).toMatchObject({ cedula: '12345678', nombre: 'Juan Pérez' });
  });

  it('una cédula con puntos de miles se rechaza en vez de cambiarle el número', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = scriptedModel([{ toolCalls: [call('capturar_datos', { cedula: '12.345.678' })] }, { text: 'Repíteme.' }]);

    const ctx = await converse(router, nlp, [{ user: '12.345.678' }], { autorizado: true });
    expect(ctx.cedula).toBeUndefined();
    expect(nlp.results[0]).toMatchObject({ ok: false });
  });

  it('el nombre conserva la capitalización que escribió la persona', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = scriptedModel([{ toolCalls: [call('capturar_datos', { nombre: 'Michelle Gómez' })] }, { text: 'ok' }]);

    const ctx = await converse(router, nlp, [{ user: 'Michelle Gómez' }], { autorizado: true });
    expect(ctx.nombre).toBe('Michelle Gómez');
  });

  it('el punto de un correo no se borra al normalizar', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = scriptedModel([{ toolCalls: [call('capturar_datos', { email: 'juan@email.com' })] }, { text: 'ok' }]);

    const ctx = await converse(router, nlp, [{ user: 'juan@email.com' }], { autorizado: true });
    expect(ctx.email).toBe('juan@email.com');
  });
});

describe('conversación — mascotas', () => {
  it('"no dije gatos": sin especie nunca cae en un plan de una sola especie', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = scriptedModel([{ toolCalls: [call('cotizar', { productCategory: 'mascotas' })] }, { text: 'ok' }]);

    const ctx = await converse(router, nlp, [{ user: 'tengo mascotas' }], { autorizado: true });
    expect(ctx.quoteProductId).toBe('asistencia-veterinaria');
  });

  it('con la especie dada, cotiza esa y no la otra', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = scriptedModel([{ toolCalls: [call('cotizar', { productCategory: 'mascotas', petType: 'perro' })] }, { text: 'ok' }]);

    const ctx = await converse(router, nlp, [{ user: 'tengo un perro' }], { autorizado: true });
    expect(ctx.quoteProductId).toBe('medicina-prepagada-perros');
  });
});

describe('conversación — cierre completo', () => {
  it('cotiza, captura, emite y cobra, en ese orden y sin saltarse un paso', async () => {
    const policies = { issue: jest.fn().mockResolvedValue({ policyId: 'pol-9' }) };
    const createPaymentLink = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' });
    const router = new ToolRouterService({ quoting, catalog, policies, payments: { isEnabled: true, createPaymentLink } });

    const nlp = scriptedModel([
      { toolCalls: [call('cotizar', { productCategory: 'vida' })] },
      { text: '¿Te sirve?' },
      { toolCalls: [call('capturar_datos', { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@mail.com' })] },
      { text: 'Confirmo el resumen.' },
      // vida exige aseguramiento. Este paso faltaba y el test pasaba igual porque el router
      // se construía sin catálogo, y requiresUnderwriting devuelve false sin él: la prueba
      // llamada "sin saltarse un paso" se saltaba justo este.
      { toolCalls: [call('preguntas_aseguramiento', { respuestas: '32 años, sin enfermedades.' })] },
      { text: 'Gracias, lo registro.' },
      { toolCalls: [call('emitir_poliza')] },
      { text: 'Emitida.' },
      { toolCalls: [call('generar_link_pago')] },
      { text: 'Te dejo el link en el chat.' },
    ]);

    const ctx = await converse(
      router,
      nlp,
      [{ user: 'quiero vida' }, { user: 'mis datos' }, { user: 'sin enfermedades' }, { user: 'confirmo' }, { user: 'pagar' }],
      { autorizado: true },
    );

    expect(ctx.policyId).toBe('pol-9');
    expect(ctx.checkoutUrl).toContain('checkout.wompi.co');
    expect(policies.issue).toHaveBeenCalledTimes(1);
    // Priced from the catalog through the quoting engine, never from a model argument.
    expect(createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({ amountCOP: expect.any(Number) }));
  });
});
