// persistencia.spec.ts: the call used to keep everything it captured in memory, so the web
// session bar stayed on step 1 of 6 and the payment link reached nobody.
import { ConversationState } from '../modules/agent/types';
import { estadoDeVoz, crearGuardador } from './persistencia';
import { VoiceSessionState } from './session-state';

describe('estado derivado del contexto de la llamada', () => {
  it('avanza con lo que la llamada ya capturó', () => {
    expect(estadoDeVoz({})).toBe(ConversationState.GREETING);
    expect(estadoDeVoz({ autorizado: true })).toBe(ConversationState.DISCOVERY);
    expect(estadoDeVoz({ autorizado: true, quoteProductId: 'vida-pan-american' }))
      .toBe(ConversationState.QUOTE_PRESENTED);
    expect(estadoDeVoz({ autorizado: true, quoteProductId: 'x', cedula: '123' }))
      .toBe(ConversationState.DATA_CAPTURE);
    expect(estadoDeVoz({ autorizado: true, policyId: 'pol-1' })).toBe(ConversationState.PAYMENT);
    expect(estadoDeVoz({ autorizado: true, policyId: 'pol-1', checkoutUrl: 'https://x' }))
      .toBe(ConversationState.PAYMENT);
  });

  // `hasCompletedPurchase` no se borra nunca —es lo que distingue "ya compró" de "nunca
  // compró"—, así que usarlo como estado ponía a todo cliente que regresa en la pantalla de
  // "¡Listo!" desde el saludo, con la llamada todavía corriendo.
  it('una compra vieja no adelanta la venta de hoy', () => {
    expect(estadoDeVoz({ autorizado: true, hasCompletedPurchase: true }))
      .toBe(ConversationState.DISCOVERY);
    expect(estadoDeVoz({ autorizado: true, hasCompletedPurchase: true, quoteProductId: 'vida-pan-american' }))
      .toBe(ConversationState.QUOTE_PRESENTED);
    expect(estadoDeVoz({ autorizado: true, hasCompletedPurchase: true, policyId: 'pol-1' }))
      .toBe(ConversationState.PAYMENT);
  });

  // La cédula y el correo tampoco se borran entre compras: solos no significan que haya una
  // venta avanzada, solo que esta persona ya estuvo aquí.
  it('los datos guardados de antes no cuentan como paso sin una cotización viva', () => {
    expect(estadoDeVoz({ autorizado: true, cedula: '123', nombre: 'Ana', email: 'a@b.co' }))
      .toBe(ConversationState.DISCOVERY);
  });
});

describe('guardador del contexto de voz', () => {
  it('escribe el contexto y el estado derivado en la conversación', async () => {
    const escrituras: Array<[string, ConversationState, unknown]> = [];
    const guardar = crearGuardador(async (id, estado, ctx) => { escrituras.push([id, estado, ctx]); });

    await guardar('conv-1', { autorizado: true, quoteProductId: 'vida-pan-american' });

    expect(escrituras).toEqual([['conv-1', ConversationState.QUOTE_PRESENTED, { autorizado: true, quoteProductId: 'vida-pan-american' }]]);
  });

  // Cada herramienta hace merge, así que un turno dispara varias escrituras seguidas. Sin
  // serializar, la más lenta puede aterrizar de última y dejar la fila en un estado anterior.
  it('no deja que una escritura vieja pise a una nueva', async () => {
    const vistos: string[] = [];
    let resolverPrimera: () => void = () => {};
    const primera = new Promise<void>((r) => { resolverPrimera = r; });
    let llamadas = 0;

    const guardar = crearGuardador(async (_id, _estado, ctx) => {
      llamadas++;
      if (llamadas === 1) await primera;
      vistos.push((ctx as { cedula?: string }).cedula ?? 'sin-cedula');
    });

    const a = guardar('conv-1', { autorizado: true });
    const b = guardar('conv-1', { autorizado: true, cedula: '111' });
    const c = guardar('conv-1', { autorizado: true, cedula: '222' });
    resolverPrimera();
    await Promise.all([a, b, c]);

    expect(vistos[vistos.length - 1]).toBe('222');
  });

  it('un fallo de la base no tumba la llamada', async () => {
    const guardar = crearGuardador(async () => { throw new Error('supabase caído'); });

    await expect(guardar('conv-1', { autorizado: true })).resolves.toBeUndefined();
  });

  it('sin conversación real no escribe nada', async () => {
    let escrituras = 0;
    const guardar = crearGuardador(async () => { escrituras++; });

    await guardar(undefined, { autorizado: true });

    expect(escrituras).toBe(0);
  });
});

describe('VoiceSessionState avisa de cada cambio', () => {
  it('llama al guardador con el contexto acumulado, no con el parche', () => {
    const vistos: unknown[] = [];
    const state = new VoiceSessionState('conv-1', (ctx) => { vistos.push({ ...ctx }); });

    state.merge({ autorizado: true });
    state.merge({ cedula: '123' });

    expect(vistos).toEqual([{ autorizado: true }, { autorizado: true, cedula: '123' }]);
  });

  // El contexto que traía el chat no es progreso de la llamada: anunciarlo reescribe la fila
  // con lo que la fila ya decía, antes de que la persona hable.
  it('no avisa de lo que venía del chat', () => {
    const vistos: unknown[] = [];
    const state = new VoiceSessionState('conv-1', (ctx) => { vistos.push({ ...ctx }); });

    state.hidratar({ autorizado: true, cedula: '123' });

    expect(vistos).toEqual([]);
    expect(state.context).toEqual({ autorizado: true, cedula: '123' });
  });
});
