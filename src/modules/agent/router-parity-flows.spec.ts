// router-parity-flows.spec.ts: whole conversations through both engines. Each engine gets its
// own script because they need a different number of turns to reach the same place; only the
// end of the exchange is compared. This is the evidence the regex branches can be retired.
import { ConversationState } from './types';
import { ProductCatalog } from '../quoting/product-catalog.service';
import { MultiTurnFixture, call, pick, quoting, runMachine, runRouter } from './router-parity.harness';

const policies = { issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }) };
const payments = {
  isEnabled: true,
  createPaymentLink: jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' }),
};
const deps = { quoting, policies, payments, catalog: new ProductCatalog() };

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
  {
    // The flow that exposed the gap: vida cannot be issued until the underwriting answers
    // exist. Both engines now ask for them and only then close.
    name: 'cierre con aseguramiento — vida exige preguntas de salud antes de emitir',
    start: {
      state: ConversationState.DATA_CAPTURE,
      context: { autorizado: true, quoteProductId: 'vida', productCategory: 'vida' },
    },
    machineTurns: [
      { user: '12345678' },
      { user: 'Juan Pérez' },
      { user: 'juan@email.com' },
      { user: 'Tengo 34 años y no tengo enfermedades' },
      { user: 'sí', intent: { isAffirmative: true } },
    ],
    routerTurns: [
      { user: '12345678', modelTurns: [{ toolCalls: [call('capturar_datos', { cedula: '12345678' })] }, { text: '¿Nombre?' }] },
      { user: 'Juan Pérez', modelTurns: [{ toolCalls: [call('capturar_datos', { nombre: 'Juan Pérez' })] }, { text: '¿Correo?' }] },
      { user: 'juan@email.com', modelTurns: [{ toolCalls: [call('capturar_datos', { email: 'juan@email.com' })] }, { text: '¿Tu estado de salud?' }] },
      {
        user: 'Tengo 34 años y no tengo enfermedades',
        modelTurns: [{ toolCalls: [call('preguntas_aseguramiento', { respuestas: 'Tengo 34 años y no tengo enfermedades' })] }, { text: 'Te leo el resumen.' }],
      },
      { user: 'sí', modelTurns: [{ toolCalls: [call('emitir_poliza')] }, { text: 'Emitida.' }] },
    ],
    compare: ['cedula', 'nombre', 'email', 'medicalInfoProvided', 'policyId'],
  },
  {
    name: 'QUOTE_PRESENTED — un "sí" deja elegido el mismo producto en los dos motores',
    start: {
      state: ConversationState.QUOTE_PRESENTED,
      context: { autorizado: true, productCategory: 'accidentes', quoteProductId: 'accidentes-personales' },
    },
    machineTurns: [{ user: 'sí', intent: { isAffirmative: true } }],
    routerTurns: [{ user: 'sí', modelTurns: [{ text: 'Perfecto, ahora tus datos.' }] }],
    compare: ['quoteProductId', 'productCategory'],
  },
  {
    name: 'QUOTE_PRESENTED — "otro" no vuelve a ofrecer el mismo producto',
    start: {
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        autorizado: true,
        productCategory: 'accidentes',
        quoteProductId: 'accidentes-personales',
        shownProductIds: ['accidentes-personales'],
      },
    },
    machineTurns: [{ user: 'otro', intent: { wantsAlternative: true } }],
    // The router expresses the same thing by quoting again; the tool never returns a product
    // the conversation already rejected because the model passes the category, not the id.
    routerTurns: [
      { user: 'otro', modelTurns: [{ toolCalls: [call('cotizar', { productCategory: 'accidentes' })] }, { text: 'Mira esta otra.' }] },
    ],
    compare: ['productCategory'],
  },
  {
    name: 'PAYMENT — confirmar deja un link de pago en los dos motores',
    start: {
      state: ConversationState.PAYMENT,
      context: {
        autorizado: true,
        productCategory: 'accidentes',
        quoteProductId: 'accidentes-personales',
        cedula: '12345678',
        nombre: 'Juan Pérez',
        policyId: 'pol-1',
      },
    },
    machineTurns: [{ user: 'sí', intent: { isAffirmative: true } }],
    routerTurns: [
      { user: 'sí', modelTurns: [{ toolCalls: [call('generar_link_pago')] }, { text: 'Te dejo el link.' }] },
    ],
    compare: ['policyId'],
  },
  {
    // Money: a second link for the same policy is a second charge waiting to happen.
    name: 'PAYMENT — con un link vigente no se crea un segundo',
    start: {
      state: ConversationState.PAYMENT,
      context: {
        autorizado: true,
        productCategory: 'accidentes',
        quoteProductId: 'accidentes-personales',
        cedula: '12345678',
        nombre: 'Juan Pérez',
        policyId: 'pol-1',
        checkoutUrl: 'https://checkout.wompi.co/l/ya-existe',
      },
    },
    machineTurns: [{ user: 'sí', intent: { isAffirmative: true } }],
    routerTurns: [
      { user: 'sí', modelTurns: [{ toolCalls: [call('generar_link_pago')] }, { text: 'Sigue activo.' }] },
    ],
    compare: ['checkoutUrl'],
  },
  {
    // The back-reference block, end to end: "prefiero la anterior" must land on the product
    // the person actually heard before, not re-quote whatever the category returns now.
    name: 'QUOTE_PRESENTED — "la anterior" vuelve al producto ya ofrecido, no a otro',
    start: {
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        autorizado: true,
        productCategory: 'asistencia',
        quoteProductId: 'exequial',
        shownProductIds: ['asistencias-medicas', 'exequial'],
      },
    },
    machineTurns: [{ user: 'prefiero la anterior' }],
    routerTurns: [
      {
        user: 'prefiero la anterior',
        modelTurns: [{ toolCalls: [call('seleccionar_producto', { productId: 'asistencias-medicas' })] }, { text: 'Volvemos a esa.' }],
      },
    ],
    compare: ['quoteProductId'],
  },
  {
    // The decline that once produced a second payment link: after a purchase, "no gracias"
    // must close, never re-quote what was just bought.
    name: 'cross-sell — un "no" tras la compra no vuelve a ofrecer lo comprado',
    start: {
      state: ConversationState.DISCOVERY,
      context: {
        autorizado: true,
        hasCompletedPurchase: true,
        purchasedProductIds: ['vida'],
        awaitingCrossSellResponse: true,
      },
    },
    machineTurns: [{ user: 'no gracias', intent: { isNegative: true } }],
    routerTurns: [
      {
        user: 'no gracias',
        modelTurns: [{ toolCalls: [call('cotizar', { productCategory: 'vida' })] }, { text: 'Entendido, quedo atento.' }],
      },
    ],
    // Neither engine may end up re-quoting the product already owned.
    compare: ['quoteProductId'],
  },
];

describe.each(FLOWS)('paridad de flujo — $name', (flow) => {
  it('ambos motores terminan sabiendo lo mismo', async () => {
    const machine = await runMachine(flow);
    const router = await runRouter({ ...flow, deps });

    expect(pick(router, flow.compare)).toEqual(pick(machine, flow.compare));
  });
});
