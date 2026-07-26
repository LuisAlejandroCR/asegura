import { ConversationState, ConversationContext } from './types';
import { PRODUCTS } from '../quoting/products.data';
import { hasRememberedProfile } from './persistent-context';

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

// "Ramón, Bruna y Pancha" — Spanish list joining, "y" before the last item. Exported so
// wompi-webhook.controller.ts's multi-policy confirmation can reuse the same formatting.
export function formatNameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

export const STATE_RESPONSES: ResponsesMap = {
  // 2026-07-24 feedback: the greeting + full authorization paragraph as two separate
  // messages read as a wall of text before the user gets to say anything — people
  // arrive with social-media attention spans and bounce. Combined into one short
  // message; the Ley 1581 disclosure is kept (legally required) but folded into a
  // parenthetical instead of its own centered paragraph.
  // 2026-07-26 persistent memory (Diseño preguntas.docx: "la siguiente conversación
  // nunca debe empezar desde cero") — a returning user whose durable profile facts
  // survived a restart (see persistent-context.ts) gets an honest acknowledgment: only
  // ever states that SOME profile carried over, never invents specifics not actually in
  // context (rule #12). Personalizes by first name when we already have it (KYC nombre
  // survives restarts too) — same pattern already used in POLICY_ISSUED's greeting.
  // 2026-07-26 (moved up from the affiliate-ID question, per feedback): "puedes
  // responder por texto o audio" belongs in the very FIRST message, not two turns later
  // — reworded short so it doesn't recreate the "wall of text" the 2026-07-24 combine
  // was meant to fix. Not repeated in the affiliate-ID question anymore (agent.service.ts).
  [ConversationState.GREETING]: (ctx) => {
    const c = translate(ctx);
    const firstName = c.nombre?.split(' ')[0];
    const greetingLine = firstName ? `¡Hola de nuevo, ${firstName}!` : '¡Hola!';
    const rememberedLine = hasRememberedProfile(c)
      ? '\n\nYa tengo parte de tu perfil de una conversación anterior, así que esto debería ser más rápido.'
      : '';
    return (
      `${greetingLine} Soy Asegura 🛡️ — encuentro tu seguro ideal en 3 minutos, sin formularios ni asesores. ` +
      `Puedes escribirme o responder por audio, lo que prefieras 😊` +
      rememberedLine + '\n\n' +
      'Para cotizarte necesito tu autorización para consultar tu perfil de afiliado ' +
      '(*Ley 1581* · [política de datos](https://colsubsidio.com/transparencia-acceso-informacion/tratamiento-datos-personales)).\n\n' +
      'Escríbeme *"sí"* para empezar.'
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
    // 2026-07-26 cleanup: this used to have a 3rd tier asking "¿En qué rango de edades
    // están?" once coverage AND beneficiaries were both known. No field in the NLP intent
    // schema ever captured a human beneficiary's age (only petAge, for pets), and
    // QuotingService never read one — the question was unreachable from its only call
    // site anyway (handleDiscovery's hasEnoughInfo/stuckWithoutCategory guard fires
    // before this tier could ever be hit — see agent.service.ts:387-394) but stayed here
    // as dead, confusing copy. Removed; Step 3's `dependents` question is the real,
    // functional replacement.
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

  // 2026-07-24 gamification feedback: celebratory milestone copy at the biggest "you
  // did it" moment in the flow — personalized with the user's first name and, for a
  // mascotas purchase, each pet's name (reuses data already in context, no new fields).
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
