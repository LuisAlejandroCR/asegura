// lead.service.spec.ts: qué se guarda de quien se fue sin comprar, y a quién NO hay que
// perseguir — llamar a alguien que acaba de pagar es peor que no llamarlo.
import { LeadService, mereceSeguimiento } from './lead.service';
import { Conversation, ConversationState } from '../agent/types';

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    user_id: 'user-1',
    channel: 'telegram',
    state: ConversationState.QUOTE_PRESENTED,
    context: {},
    ...overrides,
  } as Conversation;
}

describe('mereceSeguimiento', () => {
  it('sí, cuando la persona se fue con una cotización sin pagar', () => {
    expect(mereceSeguimiento(conv({ context: { quoteProductId: 'exequial-recordar' } }))).toBe(true);
  });

  it('no, con un link de pago abierto — esa venta está en vuelo', () => {
    expect(mereceSeguimiento(conv({ context: { checkoutUrl: 'https://checkout.wompi.co/l/x' } }))).toBe(false);
  });

  it('no, con la póliza ya emitida o en PAYMENT', () => {
    expect(mereceSeguimiento(conv({ context: { policyId: 'pol-1' } }))).toBe(false);
    expect(mereceSeguimiento(conv({ context: { policyIds: ['pol-1'] } }))).toBe(false);
    expect(mereceSeguimiento(conv({ state: ConversationState.PAYMENT }))).toBe(false);
    expect(mereceSeguimiento(conv({ state: ConversationState.COMPLETED }))).toBe(false);
  });
});

describe('LeadService.registrar', () => {
  function supabaseFalso(error: { message: string } | null = null) {
    const upsert = jest.fn().mockResolvedValue({ error });
    return { servicio: { db: { from: jest.fn(() => ({ upsert })) } } as never, upsert };
  }

  it('guarda con qué se quedó a medias y por dónde llamarla', async () => {
    const { servicio, upsert } = supabaseFalso();
    await new LeadService(servicio).registrar(
      conv({
        state: ConversationState.DATA_CAPTURE,
        context: {
          productCategory: 'exequial', quoteProductId: 'exequial-recordar',
          nombre: 'Ana Gómez', cedula: '1234567890', documentType: 'CC',
          email: 'ana@ejemplo.co', verifiedPhone: '+573001112233',
        },
      }),
      'web_session_ended',
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'conv-1',
        last_state: ConversationState.DATA_CAPTURE,
        reason: 'web_session_ended',
        quote_product_id: 'exequial-recordar',
        nombre: 'Ana Gómez',
        phone: '+573001112233',
        status: 'pending',
      }),
      { onConflict: 'conversation_id' },
    );
  });

  // Nunca las respuestas de aseguramiento: son datos de salud, categoría sensible bajo la Ley
  // 1581, y para devolver una llamada no hacen falta.
  it('no copia la información médica al lead', async () => {
    const { servicio, upsert } = supabaseFalso();
    await new LeadService(servicio).registrar(
      conv({ context: { medicalInfo: 'hipertensión diagnosticada en 2019', medicalInfoProvided: true } }),
      'no_response',
    );

    expect(JSON.stringify(upsert.mock.calls[0][0])).not.toContain('hipertensión');
  });

  // Un fallo de Supabase no puede dejar a la persona esperando en pantalla.
  it('no lanza cuando Supabase falla', async () => {
    const { servicio } = supabaseFalso({ message: 'relation "leads" does not exist' });
    await expect(new LeadService(servicio).registrar(conv(), 'insufficient_info')).resolves.toBeUndefined();
  });
});
