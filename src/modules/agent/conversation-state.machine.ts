// conversation-state.machine.ts: the allowed state transitions plus the Spanish reply
// text for each state. STATE_RESPONSES is a function per state so the copy can adapt
// to what the context already knows (name, cédula, remembered profile).

import { ConversationState, ConversationContext } from './types';
import { ProductCatalog } from '../quoting/product-catalog.service';
import { hasRememberedProfile } from './persistent-context';

// Loads its own ProductCatalog: STATE_RESPONSES is plain module state with no DI constructor
// to inject IProductRepository into. Same files on disk, never a second data source.
const PRODUCTS = new ProductCatalog().getProducts();

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

// "Ramón, Bruna y Pancha" — Spanish list joining. Exported so the multi-policy confirmation
// in wompi-webhook.controller.ts formats names identically.
export function formatNameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

// A web session always starts AFTER authorization, so the bar's 0% is DISCOVERY.
// GREETING/AUTHORIZATION clamp to step 1 (a 0 reads as broken, not "not started") and the
// terminal states clamp to the last real step — there is no future step to point at.
const WEB_FLOW_STATES: ConversationState[] = [
  ConversationState.DISCOVERY,
  ConversationState.QUOTING,
  ConversationState.QUOTE_PRESENTED,
  ConversationState.DATA_CAPTURE,
  ConversationState.PAYMENT,
  ConversationState.POLICY_ISSUED,
];

const WEB_FLOW_LABELS: Record<ConversationState, string> = {
  [ConversationState.GREETING]: 'Cuéntanos',
  [ConversationState.AUTHORIZATION]: 'Cuéntanos',
  [ConversationState.DISCOVERY]: 'Cuéntanos',
  [ConversationState.QUOTING]: 'Cotizando',
  [ConversationState.QUOTE_PRESENTED]: 'Tu oferta',
  [ConversationState.DATA_CAPTURE]: 'Tus datos',
  [ConversationState.PAYMENT]: 'Pago',
  [ConversationState.POLICY_ISSUED]: '¡Listo!',
  [ConversationState.COMPLETED]: '¡Listo!',
  [ConversationState.ABANDONED]: '¡Listo!',
  [ConversationState.REJECTED]: '¡Listo!',
};

export function progressFor(state: ConversationState): { step: number; totalSteps: number; label: string } {
  const totalSteps = WEB_FLOW_STATES.length;
  const index = WEB_FLOW_STATES.indexOf(state);

  if (index !== -1) {
    return { step: index + 1, totalSteps, label: WEB_FLOW_LABELS[state] };
  }

  const isBeforeFlow = state === ConversationState.GREETING || state === ConversationState.AUTHORIZATION;
  return {
    step: isBeforeFlow ? 1 : totalSteps,
    totalSteps,
    label: isBeforeFlow ? WEB_FLOW_LABELS[state] : WEB_FLOW_LABELS[ConversationState.POLICY_ISSUED],
  };
}

export const STATE_RESPONSES: ResponsesMap = {
  // Greeting and authorization in ONE message: as two, it read as a wall of text and people
  // bounced. Ley 1581 stays disclosed, demoted to a trailing italic footnote. A returning user
  // gets an honest acknowledgment that some profile carried over, never invented specifics.
  [ConversationState.GREETING]: (ctx) => {
    const c = translate(ctx);
    const firstName = c.nombre?.split(' ')[0];
    const greetingLine = firstName ? `¡Hola de nuevo, ${firstName}!` : '¡Hola!';
    const rememberedLine = hasRememberedProfile(c)
      ? ' Ya tengo parte de tu perfil de antes, así que esto va rápido.'
      : '';
    return (
      `${greetingLine} Soy Asegura 🛡️ — tu seguro ideal en 3 minutos, sin formularios. ` +
      `Escríbeme o mándame un audio, como prefieras 😊${rememberedLine}\n\n` +
      '¿Me autorizas a consultar tu perfil de afiliado? Responde *"sí"* para empezar.\n\n' +
      '_(Ley 1581 · [política de datos](https://colsubsidio.com/transparencia-acceso-informacion/tratamiento-datos-personales))_'
    );
  },

  [ConversationState.AUTHORIZATION]: () =>
    '¿Autorizas el tratamiento de tus datos según la *Ley 1581 de 2012*? Escríbeme *"sí"* para continuar.\n\n' +
    '📋 [Política de tratamiento de datos — Colsubsidio](https://colsubsidio.com/transparencia-acceso-informacion/tratamiento-datos-personales)',

  [ConversationState.DISCOVERY]: (ctx) => {
    const c = translate(ctx);
    if (!c.coverage || c.coverage.length === 0) {
      return (
        'Para encontrarte el seguro ideal comparteme un poco de tu historia:\n\n' +
        '¿Tienes familia o personas que dependen de ti? ¿Qué es lo que más te preocupa proteger — tu salud, tu ingreso, tu hogar, tus mascotas?\n' +
        'Puedes enviar tus respuestas en audio o texto'
      );
    }
    // A 3rd tier asking the beneficiaries' age range was removed: no NLP field ever captured a
    // human's age, only a pet's. Step 3's `dependents` replaces it.
    return '¿Cuántas personas son en tu familia o grupo familiar?';
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
    if (!c.cedula) return 'Para emitir la póliza necesito tu número de documento de identidad — cédula de ciudadanía, cédula de extranjería o PEP. Solo dígitos, sin puntos ni espacios.';
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

  // Celebratory copy at the biggest moment in the flow, personalized from data already in
  // context — the user's first name and, for mascotas, each pet's name.
  [ConversationState.POLICY_ISSUED]: (ctx) => {
    const c = translate(ctx);
    const firstName = c.nombre?.split(' ')[0];
    const petNames = (c.pets ?? []).map((p) => p.name);
    const headline = firstName ? `¡Listo, ${firstName}!` : '¡Listo!';
    const petsLine = petNames.length > 0
      ? ` ${formatNameList(petNames)} ya ${petNames.length > 1 ? 'cuentan' : 'cuenta'} con su seguro.`
      : '';
    return (
      `🎉 *${headline}*${petsLine}\n\n` +
      `Tu seguro está activo desde hoy. Recibirás el PDF con todos los detalles adjunto a este chat.\n\n` +
      `Si tienes dudas sobre coberturas o quieres proteger algo más, aquí estoy 24/7.`
    );
  },

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
