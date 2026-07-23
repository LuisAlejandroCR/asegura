import { ConversationState, ConversationContext } from './types';

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
    '¡Hola! Soy Asegura 🛡️ Tu asistente de seguros Colsubsidio.\nCuéntame, ¿en qué te puedo ayudar?',

  [ConversationState.AUTHORIZATION]: () =>
    'Antes de continuar, necesito tu autorización para tratar tus datos personales según la Ley 1581 de 2012.\n\n¿Autorizas el tratamiento de tus datos? Escríbeme "sí" para continuar.',

  [ConversationState.DISCOVERY]: (ctx) => {
    const c = translate(ctx);
    if (!c.coverage || c.coverage.length === 0) {
      return 'Cuéntame, ¿qué te preocupa o qué quieres proteger?';
    }
    if (!c.beneficiaries || c.beneficiaries <= 0) {
      return '¿Cuántas personas son en tu familia?';
    }
    return '¿Qué edades tienen?';
  },

  [ConversationState.QUOTING]: () =>
    'Déjame buscar la mejor opción para ti...',

  [ConversationState.QUOTE_PRESENTED]: (ctx) => {
    const c = translate(ctx);
    const budget = c.budget ? `$${c.budget.toLocaleString()}` : 'precio competitivo';
    const category = c.productCategory ?? 'seguros';
    return `📋 *Tu cotización personalizada*\n\n🛡️ Seguro de ${category}\n💰 Desde ${budget}/mes\n\n¿Te interesa o prefieres que busquemos otra opción?`;
  },

  [ConversationState.DATA_CAPTURE]: (ctx) => {
    const c = translate(ctx);
    if (!c.cedula) return 'Para emitir la póliza necesito tu número de cédula (sin puntos ni espacios).';
    if (!c.nombre) return '¿Cuál es tu nombre completo?';
    if (!c.email) return '¿Cuál es tu correo electrónico?';
    return `📱 *Resumen de tu compra:*\n\n🛡️ ${c.productCategory ?? 'Seguro'}\n👤 ${c.nombre} - CC ${c.cedula}\n\n¿Todo correcto? Escríbeme "sí" para continuar al pago.`;
  },

  [ConversationState.PAYMENT]: (ctx) => {
    const c = translate(ctx);
    const amount = c.budget ? `$${c.budget.toLocaleString()}` : 'el valor';
    return `Para completar tu compra, paga aquí:\n🔗 [Pagar ${amount}](link_wompi)\n\nEl link es seguro (Wompi + Bancolombia). Acepta tarjeta de crédito, débito, Nequi y PSE.\n\n⏱️ El link vence en 30 minutos.`;
  },

  [ConversationState.POLICY_ISSUED]: () =>
    '✅ ¡Tu seguro está activo!\n\nTu póliza ya fue emitida. En un momento recibirás el PDF y el link de verificación en blockchain.',

  [ConversationState.COMPLETED]: () =>
    '✅ ¡Todo listo! Quedaste asegurado.\n\nSi necesitas algo más, solo escríbeme.',

  [ConversationState.ABANDONED]: () =>
    'Entendido. Si cambias de opinión, aquí estoy 24/7.',

  [ConversationState.REJECTED]: () =>
    'Entendido. Sin tu autorización no podemos continuar. Si cambias de opinión, escríbeme cuando quieras.',
};

export function isValidTransition(from: ConversationState, to: ConversationState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export { VALID_TRANSITIONS };