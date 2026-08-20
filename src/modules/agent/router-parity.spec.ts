// router-parity.spec.ts: the gate for turning AGENT_ROUTER on — every routing decision has a
// fixture and both engines must agree on the context they leave behind. DISCOVERY is absent on
// purpose: the machine clarifies where the router already quotes, so per-turn comparison there
// measures bookkeeping; router-invariants.spec.ts covers what it would have proven.
import { ConversationState } from './types';
import { ParityFixture, call, machineOutcome, pick, quoting, routerOutcome } from './router-parity.harness';

const authorized = { autorizado: true };
const policies = { issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }) };
const payments = { isEnabled: true, createPaymentLink: jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' }) };

const FIXTURES: ParityFixture[] = [
  // ── AUTHORIZATION ───────────────────────────────────────────────────────────
  {
    name: 'sí autoriza',
    state: ConversationState.AUTHORIZATION,
    user: 'sí',
    modelTurns: [{ toolCalls: [call('autorizar', { autoriza: true })] }, { text: 'Gracias.' }],
    compare: ['autorizado'],
  },
  {
    name: 'sí con punto autoriza igual',
    state: ConversationState.AUTHORIZATION,
    user: 'Sí.',
    modelTurns: [{ toolCalls: [call('autorizar', { autoriza: true })] }, { text: 'Gracias.' }],
    compare: ['autorizado'],
  },

  // ── DISCOVERY ───────────────────────────────────────────────────────────────
  {
    name: 'mascotas con perro cotiza perro',
    state: ConversationState.DISCOVERY,
    context: { ...authorized, productCategory: 'mascotas', petType: 'perro' },
    user: 'tengo un perro',
    intent: { productCategory: 'mascotas', petType: 'perro' },
    modelTurns: [{ toolCalls: [call('cotizar', { productCategory: 'mascotas', petType: 'perro' })] }, { text: 'ok' }],
    compare: ['petType'],
  },

  // ── DATA_CAPTURE ────────────────────────────────────────────────────────────
  {
    name: 'cédula válida se guarda',
    state: ConversationState.DATA_CAPTURE,
    context: { ...authorized, quoteProductId: 'vida' },
    user: '12345678',
    modelTurns: [{ toolCalls: [call('capturar_datos', { cedula: '12345678' })] }, { text: '¿Nombre?' }],
    compare: ['cedula'],
  },
  {
    name: 'cédula con puntos de miles se rechaza',
    state: ConversationState.DATA_CAPTURE,
    context: { ...authorized, quoteProductId: 'vida' },
    user: '12.345.678',
    modelTurns: [{ toolCalls: [call('capturar_datos', { cedula: '12.345.678' })] }, { text: 'Repíteme.' }],
    compare: ['cedula'],
  },
  {
    name: 'cédula dictada dígito a dígito se une',
    state: ConversationState.DATA_CAPTURE,
    context: { ...authorized, quoteProductId: 'vida' },
    user: '1, 2, 3, 4, 5, 6, 7',
    modelTurns: [{ toolCalls: [call('capturar_datos', { cedula: '1, 2, 3, 4, 5, 6, 7' })] }, { text: 'ok' }],
    compare: ['cedula'],
  },
  {
    name: 'nombre conserva capitalización',
    state: ConversationState.DATA_CAPTURE,
    context: { ...authorized, quoteProductId: 'vida', cedula: '12345678' },
    user: 'Michelle Gómez',
    modelTurns: [{ toolCalls: [call('capturar_datos', { nombre: 'Michelle Gómez' })] }, { text: 'ok' }],
    compare: ['nombre', 'cedula'],
  },
  {
    name: 'un nombre con dígitos se rechaza',
    state: ConversationState.DATA_CAPTURE,
    context: { ...authorized, quoteProductId: 'vida', cedula: '12345678' },
    user: '2+2',
    modelTurns: [{ toolCalls: [call('capturar_datos', { nombre: '2+2' })] }, { text: 'Repíteme.' }],
    compare: ['nombre'],
  },
  {
    name: 'el punto del correo no se borra',
    state: ConversationState.DATA_CAPTURE,
    context: { ...authorized, quoteProductId: 'vida', cedula: '12345678', nombre: 'Juan Pérez' },
    user: 'juan@email.com',
    modelTurns: [{ toolCalls: [call('capturar_datos', { email: 'juan@email.com' })] }, { text: 'ok' }],
    compare: ['email'],
  },
];

describe.each(FIXTURES)('paridad — $name', (fixture) => {
  it('ambos motores dejan el mismo contexto', async () => {
    const machine = await machineOutcome(fixture);
    const router = await routerOutcome({ ...fixture, deps: { policies, payments, quoting } });

    expect(pick(router, fixture.compare)).toEqual(pick(machine, fixture.compare));
  });
});
