import { ConversationState, ConversationContext } from './types';
import { PRODUCTS } from '../quoting/products.data';

type TransitionMap = Partial<Record<ConversationState, ConversationState[]>>;

const VALID_TRANSITIONS: TransitionMap = {
  [ConversationState.GREETING]: [ConversationState.AUTHORIZATION],
  [ConversationState.AUTHORIZATION]: [ConversationState.DISCOVERY, ConversationState.REJECTED],
  [ConversationState.DISCOVERY]: [ConversationState.QUOTING, ConversationState.ABANDONED],
  [ConversationState.QUOTING]: [ConversationState.QUOTE_PRESENTED],
  [ConversationState.QUOTE_PRESENTED]: [ConversationState.DATA_CAPTURE, ConversationState.QUOTING, ConversationState.ABANDONED],
  [ConversationState.DATA_CAPTURE]: [ConversationState.PAYMENT, ConversationState.ABANDONED],
  [ConversationState.PAYMENT]: [ConversationState.POLICY_ISSUED, ConversationState.ABANDONED],
  [ConversationState.POLICY_ISSUED]: [ConversationState.COMPLETED],
  [ConversationState.COMPLETED]: [],
  [ConversationState.ABANDONED]: [],
  [ConversationState.REJECTED]: [],
};

type ResponsesMap = Record<ConversationState, (ctx: ConversationContext) => string>;

function translate(ctx: ConversationContext): ConversationContext {
  return ctx && typeof ctx === 'object' ? ctx : {};
}

export const STATE_RESPONSES: ResponsesMap = {
  [ConversationState.GREETING]: () =>
    '¡Hola! Soy Asegura 🛡️ — tu asesor de seguros Colsubsidio, disponible 24/7.\n\n' +
    'En menos de 3 minutos te ayudo a encontrar el seguro que realmente necesitas, según tu situación de vida. Sin formularios. Sin asesores. Sin esperas.\n\n' +
    '¿En qué te puedo ayudar hoy?',

  [ConversationState.AUTHORIZATION]: () =>
    'Antes de continuar, necesito tu autorización para consultar tu perfil de afiliado y enviarte cotizaciones personalizadas, según la *Ley 1581 de 2012*.\n\n' +
    '📋 [Política de tratamiento de datos — Colsubsidio](https://colsubsidio.com/transparencia-acceso-informacion/tratamiento-datos-personales)\n\n' +
    '¿Autorizas el tratamiento de tus datos? Escríbeme *"sí"* para continuar.',

  [ConversationState.DISCOVERY]: (ctx) => {
    const c = translate(ctx);
    if (!c.coverage || c.coverage.length === 0) {
      return (
        'Para encontrarte el seguro ideal necesito entender tu situación:\n\n' +
        '¿Tienes familia o personas que dependen de ti? ¿Qué es lo que más te preocupa proteger — tu salud, tu ingreso, tu hogar, tus mascotas?\n\n' +
        'Cuéntame con tus palabras'
      );
    }
    if (!c.beneficiaries || c.beneficiaries <= 0) {
      return '¿Cuántas personas son en tu familia o grupo familiar?';
    }
    return '¿En qué rango de edades están? (esto me ayuda a ajustar la cobertura)';
  },

  [ConversationState.QUOTING]: () =>
    '🔍 Analizando tu perfil para encontrar la mejor opción...',

  [ConversationState.QUOTE_PRESENTED]: (ctx) => {
    const c = translate(ctx);
    const budget = c.budget ? `$${c.budget.toLocaleString()}` : 'precio accesible';
    const category = c.productCategory ?? 'seguros';
    return (
      `📋 *Tu cotización personalizada*\n\n` +
      `🛡️ Seguro de ${category}\n` +
      `💰 Desde ${budget}/mes\n\n` +
      `¿Te interesa o prefieres que busquemos otra opción?`
    );
  },

  [ConversationState.DATA_CAPTURE]: (ctx) => {
    const c = translate(ctx);
    if (!c.cedula) return 'Para emitir la póliza necesito tu número de documento de identidad (cédula de ciudadanía, cédula de extranjería, tarjeta de identidad, NIP o NUIP) — solo dígitos, sin puntos ni espacios.';
    if (!c.nombre) return '¿Cuál es tu nombre completo?';
    if (!c.email) return '¿Cuál es tu correo electrónico? Ahí recibirás la póliza.';

    const productIds = c.selectedProductIds?.length ? c.selectedProductIds : (c.quoteProductId ? [c.quoteProductId] : []);
    const products = productIds.map((id) => PRODUCTS.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
    const productLines = products.length
      ? products.map((p) => `🛡️ ${p.name}`).join('\n')
      : `🛡️ ${c.productCategory ?? 'Seguro'} Colsubsidio`;

    return (
      `📱 *Resumen de tu compra:*\n\n${productLines}\n` +
      `👤 ${c.nombre} — ${c.documentType ?? 'CC'} ${c.cedula}\n` +
      `📧 ${c.email}\n\n` +
      `¿Todo correcto? Escríbeme *"sí"* para continuar al pago.`
    );
  },

  [ConversationState.PAYMENT]: () =>
    '🔐 El pago es 100% seguro a través de Wompi — plataforma oficial de Bancolombia.\n\nAcepta tarjeta débito/crédito, Nequi y PSE.\n\n¿Listo para generar tu link de pago?',

  [ConversationState.POLICY_ISSUED]: () =>
    `✅ *¡Quedaste asegurado!*\n\n` +
    `Tu seguro está activo desde hoy. Recibirás el PDF con todos los detalles adjunto a este chat.\n\n` +
    `Si tienes dudas sobre coberturas o quieres proteger algo más, aquí estoy 24/7.`,

  [ConversationState.COMPLETED]: () =>
    '✅ ¡Todo listo! Tu seguro Colsubsidio está activo.\n\n' +
    'Si necesitas algo más — una duda sobre coberturas, comparar otro plan, o proteger algo nuevo — escríbeme cuando quieras. Aquí estoy.',

  [ConversationState.ABANDONED]: () =>
    'Entendido. Cuando quieras retomar, aquí estoy — 24/7, sin esperas.',

  [ConversationState.REJECTED]: () =>
    'Entendido. Sin tu autorización no podemos continuar. Si cambias de opinión, escríbeme cuando quieras.',
};

export function isValidTransition(from: ConversationState, to: ConversationState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export { VALID_TRANSITIONS };
