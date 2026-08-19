// router-parity-flows.spec.ts: whole conversations through both engines. Each engine gets its
// own script because they need a different number of turns to reach the same place; only the
// end of the exchange is compared. This is the evidence the regex branches can be retired.
import { ConversationState } from './types';
import { MultiTurnFixture, call, pick, quoting, runMachine, runRouter } from './router-parity.harness';

const policies = { issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }) };
const payments = {
  isEnabled: true,
  createPaymentLink: jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' }),
};
const deps = { quoting, policies, payments };

const FLOWS: MultiTurnFixture[] = [
  {
    // The classic regression: the cedula used to vanish on the turn that captured the name.
    name: 'captura secuencial — cédula, nombre y correo sobreviven los tres',
    start: { state: ConversationState.DATA_CAPTURE, context: { autorizado: true, quoteProductId: 'vida' } },
    machineTurns: [
      { user: '12345678' },
      { user: 'Juan Pérez' },
      { user: 'juan@email.com' },
    ],
    routerTurns: [
      { user: '12345678', modelTurns: [{ toolCalls: [call('capturar_datos', { cedula: '12345678' })] }, { text: '¿Nombre?' }] },
      { user: 'Juan Pérez', modelTurns: [{ toolCalls: [call('capturar_datos', { nombre: 'Juan Pérez' })] }, { text: '¿Correo?' }] },
      { user: 'juan@email.com', modelTurns: [{ toolCalls: [call('capturar_datos', { email: 'juan@email.com' })] }, { text: 'Listo.' }] },
    ],
    compare: ['cedula', 'nombre', 'email'],
  },
  {
    name: 'un dato inválido no borra los ya capturados',
    start: { state: ConversationState.DATA_CAPTURE, context: { autorizado: true, quoteProductId: 'vida' } },
    machineTurns: [
      { user: '12345678' },
      { user: '2+2' },
      { user: 'Juan Pérez' },
    ],
    routerTurns: [
      { user: '12345678', modelTurns: [{ toolCalls: [call('capturar_datos', { cedula: '12345678' })] }, { text: '¿Nombre?' }] },
      { user: '2+2', modelTurns: [{ toolCalls: [call('capturar_datos', { nombre: '2+2' })] }, { text: 'Repíteme el nombre.' }] },
      { user: 'Juan Pérez', modelTurns: [{ toolCalls: [call('capturar_datos', { nombre: 'Juan Pérez' })] }, { text: 'Listo.' }] },
    ],
    compare: ['cedula', 'nombre'],
  },
  {
    name: 'cédula dictada dígito a dígito, luego nombre',
    start: { state: ConversationState.DATA_CAPTURE, context: { autorizado: true, quoteProductId: 'vida' } },
    machineTurns: [
      { user: '1, 2, 3, 4, 5, 6, 7' },
      { user: 'Michelle Gómez' },
    ],
    routerTurns: [
      { user: '1, 2, 3, 4, 5, 6, 7', modelTurns: [{ toolCalls: [call('capturar_datos', { cedula: '1, 2, 3, 4, 5, 6, 7' })] }, { text: '¿Nombre?' }] },
      { user: 'Michelle Gómez', modelTurns: [{ toolCalls: [call('capturar_datos', { nombre: 'Michelle Gómez' })] }, { text: 'Listo.' }] },
    ],
    compare: ['cedula', 'nombre'],
  },
  {
    name: 'correo dictado por voz ("arroba", "punto") queda igual que uno escrito',
    start: { state: ConversationState.DATA_CAPTURE, context: { autorizado: true, quoteProductId: 'vida', cedula: '12345678', nombre: 'Juan Pérez' } },
    machineTurns: [{ user: 'juan arroba mail punto com' }],
    routerTurns: [
      { user: 'juan arroba mail punto com', modelTurns: [{ toolCalls: [call('capturar_datos', { email: 'juan arroba mail punto com' })] }, { text: 'Listo.' }] },
    ],
    compare: ['email'],
  },
  {
    // The whole sale in one exchange: this is the evidence the router can replace the machine.
    name: 'cierre completo — captura, confirmación y emisión',
    start: {
      state: ConversationState.DATA_CAPTURE,
      // accidentes-personales, not vida: vida requires underwriting questions and the router
      // has no capability for those yet (see docs/plan-router.md, blocker for block E).
      context: { autorizado: true, quoteProductId: 'accidentes-personales', productCategory: 'accidentes' },
    },
    machineTurns: [
      { user: '12345678' },
      { user: 'Juan Pérez' },
      { user: 'juan@email.com' },
      { user: 'sí', intent: { isAffirmative: true } },
    ],
    routerTurns: [
      { user: '12345678', modelTurns: [{ toolCalls: [call('capturar_datos', { cedula: '12345678' })] }, { text: '¿Nombre?' }] },
      { user: 'Juan Pérez', modelTurns: [{ toolCalls: [call('capturar_datos', { nombre: 'Juan Pérez' })] }, { text: '¿Correo?' }] },
      { user: 'juan@email.com', modelTurns: [{ toolCalls: [call('capturar_datos', { email: 'juan@email.com' })] }, { text: 'Te leo el resumen.' }] },
      { user: 'sí', modelTurns: [{ toolCalls: [call('emitir_poliza')] }, { text: 'Emitida.' }] },
    ],
    compare: ['cedula', 'nombre', 'email', 'policyId'],
  },
];

describe.each(FLOWS)('paridad de flujo — $name', (flow) => {
  it('ambos motores terminan sabiendo lo mismo', async () => {
    const machine = await runMachine(flow);
    const router = await runRouter({ ...flow, deps });

    expect(pick(router, flow.compare)).toEqual(pick(machine, flow.compare));
  });
});
