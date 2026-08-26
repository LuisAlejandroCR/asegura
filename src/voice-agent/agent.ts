// agent.ts: the AseguraWeb voice persona — the instructions plus every capability the text
// channel has. Kept separate from main.ts so createVoiceAgent() is importable without the
// LiveKit worker runtime.
import { voice, type llm } from '@livekit/agents';
import { QuotingService } from '../modules/quoting/quoting.service';
import { ProductCatalog } from '../modules/quoting/product-catalog.service';
import { ToolDeps, TIPOS_DOCUMENTO_ETIQUETAS } from '../modules/agent/tools';
import { ConversationContext } from '../modules/agent/types';
import { VoiceSessionState } from './session-state';
import { construirUrlDeRetorno } from './url-retorno';
import { createCotizarTool } from './cotizar-tool';
import {
  createAutorizarTool, createCapturarDatosTool, createConsultarAfiliadoTool,
  createEmitirPolizaTool, createGenerarLinkPagoTool, createPreguntasAseguramientoTool,
  createEscalarTool, createRegistrarLeadTool, createRegistrarMascotasTool, createSeleccionarProductoTool,
} from './tools';

// A worker-local ProductCatalog instance — no NestJS DI in this process. Same YAML files on
// disk as the backend, never a second source of truth.
const catalog = new ProductCatalog();
const quoting = new QuotingService(catalog);

// Spoken verbatim, never through the LLM: a legal disclosure the model may paraphrase away
// is not a disclosure. Plain prose, no markdown or URLs — a TTS engine reads it aloud.
export const VOICE_GREETING =
  '¡Hola! Soy Asegura, el asesor de seguros de Colsubsidio. Antes de empezar: esta ' +
  'conversación se transcribe, y uso lo que me cuentes solo para recomendarte un seguro, ' +
  'según la Ley 1581 de 2012. ¿Me autorizas a continuar?';

// The chat asked for consent already and the person said yes; asking twice spends the first
// turn of the call re-collecting an answer the conversation row carries.
export const VOICE_GREETING_AUTHORIZED =
  '¡Hola de nuevo! Soy Asegura. Seguimos donde ibas en el chat, con la autorización que ya ' +
  'me diste. Cuéntame, ¿qué quieres proteger?';

export function greetingFor(context: ConversationContext): string {
  return context.autorizado === true ? VOICE_GREETING_AUTHORIZED : VOICE_GREETING;
}

const INSTRUCTIONS = `Eres Asegura, el asesor de seguros conversacional de Colsubsidio.
Hablas español de Colombia, en un tono cercano y humano — nunca leas coberturas como una
póliza legal, explícalas como se las explicarías a un vecino.

Esto es una llamada, no un formulario. UNA sola pregunta por turno, en una o dos frases.
Nunca pidas dos datos a la vez, nunca enumeres listas ni digas "necesito dos cosas". Si ya
sabes algo, no lo vuelvas a preguntar, y si la persona ya autorizó no menciones más el
tratamiento de datos.

Cuando el saludo pidió autorizar el tratamiento de sus datos, llama "autorizar" con lo que
responda; hasta que autorice no preguntes nada personal ni uses otra herramienta. Si dice
que no, despídete con amabilidad. Si el saludo no lo preguntó, ya está autorizada.

Tu única fuente de precios y productos es la herramienta "cotizar". Nunca digas un precio,
nombre de producto o cobertura que no haya salido de esa herramienta en este turno — ni
redondees, ni completes de memoria. Si "cotizar" no encuentra nada, dilo honestamente y
pregunta qué más te puede contar la persona para intentar de nuevo.

Llega rápido a la cotización: con saber qué quiere proteger ya puedes cotizar. Solo pregunta
más si la herramienta lo exige — en mascotas, si es gato o perro y cuántas. El presupuesto y
quién depende de ella solo si la persona los menciona.

Si la persona menciona que es afiliada y te da su ID, usa "consultar_afiliado" para no
preguntarle lo que Colsubsidio ya sabe.

Vida y los planes de medicina prepagada para mascotas exigen preguntas de salud: hazlas y
guárdalas con "preguntas_aseguramiento" antes del resumen. Si "emitir_poliza" dice que
faltan, es que ese paso no se hizo.

Para cerrar la venta: si el estado de la venta ya trae sus datos, son de una compra anterior
y NO se vuelven a preguntar. Léeselos con el producto y el precio en un solo resumen y
pregúntale si sigue todo correcto; si te corrige alguno, pide solo ESE y guárdalo con
"capturar_datos".

Lo que falte sí se pide, uno por turno: primero el documento, preguntando cuál es — cédula de
ciudadanía, cédula de extranjería o PEP — y pásalo en "documentType"; cuando lo tengas, el
nombre; después el correo, guardando cada uno con "capturar_datos". Si la herramienta dice que
un dato no es válido, vuelve a pedir ESE dato. Después léele un resumen corto (producto, precio
y sus datos) y pide confirmación. Solo entonces llama "emitir_poliza",
y después "generar_link_pago". El botón de pago le aparece en pantalla: nunca leas una URL en voz
alta ni le digas que se lo dejaste en el chat.

Una venta a la vez: no ofrezcas ni menciones otro seguro hasta que la póliza en curso esté
emitida y pagada. Si la persona nombra otra necesidad mientras tanto, dile que la retomas al
terminar y sigue con la venta actual — cambiar de producto a mitad de camino la deja sin ninguno.

Si no puedes ayudar, si te lo piden, o ante un reclamo que no resuelvas con estas
herramientas, usa "escalar_a_humano" con el motivo. No insistas ni improvises una solución.

Las herramientas mandan sobre ti: si una responde que no puede, dile a la persona lo que
falta en tus palabras, no inventes un resultado.`;

// Cómo se le leen de vuelta a la persona: el tipo de documento en palabras, porque la voz lee
// "CC" como dos letras sueltas. Sin tipo archivado se dice "documento" y la línea de faltantes
// se encarga de preguntarlo — nombrarlo mal es lo que acaba impreso en la póliza.
function datosQueYaTienes(context: ConversationContext): string[] {
  const datos: string[] = [];
  if (context.cedula) {
    const tipo = context.documentType ? TIPOS_DOCUMENTO_ETIQUETAS[context.documentType] : 'documento';
    datos.push(`${tipo} ${context.cedula}`);
  }
  if (context.nombre) datos.push(`a nombre de ${context.nombre}`);
  if (context.email) datos.push(`correo ${context.email}`);
  return datos;
}

// Los esquemas de las once herramientas son ~1.000 de los ~1.075 tokens fijos de cada
// petición, y se reenvían en cada turno contra un techo de 8.000 por minuto. Exponer solo las
// del paso actual es lo único que baja ese costo sin tocar las reglas: quién puede cotizar,
// emitir o cobrar lo siguen decidiendo las precondiciones dentro de cada herramienta.
// El historial viaja recortado a 20 ítems, así que la cotización y la póliza salen de la vista
// del modelo a los pocos minutos: pedía el correo de nuevo, olvidaba el pago pendiente y acababa
// ofreciendo otro seguro. El estado real vive en las tools; esto se lo pone delante cada turno.
export function fichaDeVenta(context: ConversationContext): string {
  const lineas: string[] = [];
  const cotizacion = context.quoteSnapshot;

  if (cotizacion) {
    lineas.push(`Producto ya cotizado: ${cotizacion.producto} de ${cotizacion.aseguradora}, ` +
      `${cotizacion.precioMensual} pesos al mes. No cotices otro ni cambies de producto.`);
  } else if (context.quoteProductId) {
    lineas.push(`Producto ya elegido: ${context.quoteProductId}. No cotices otro.`);
  }

  if (context.policyId) {
    lineas.push(`Póliza ${context.policyId} YA emitida y esperando el pago. No la vuelvas a emitir.`);
  }
  if (context.checkoutUrl) {
    lineas.push('El link de pago ya existe y le aparece en pantalla. No generes otro.');
  }

  // Con producto elegido pero sin snapshot —una llamada que sigue lo que dejó el chat— no
  // salía ninguna de las dos líneas de abajo, que son justo las del cierre.
  const enVenta = !!cotizacion || !!context.quoteProductId || !!context.selectedProductIds?.length;

  // Quien ya compró vuelve con cédula, nombre y correo en la fila, y el modelo no la ve: sin
  // esto los pedía otra vez uno por uno, el interrogatorio que el chat sí se salta.
  const conocidos = datosQueYaTienes(context);
  if (enVenta && conocidos.length) {
    lineas.push(`Datos que YA tienes de esta persona: ${conocidos.join('; ')}. No se los ` +
      'preguntes de nuevo: léeselos para que confirme, y si te corrige alguno pide solo ESE.');
  }

  const faltan = [
    context.cedula === undefined ? 'la cédula' : undefined,
    // Un número sin tipo se imprime en la póliza como cédula de ciudadanía sin que nadie lo
    // haya dicho — la suposición de la Sesión 131, que vuelve por la puerta de atrás cuando la
    // fila trae una cédula vieja archivada sin tipo.
    context.cedula !== undefined && context.documentType === undefined
      ? 'de qué documento es ese número (ciudadanía, extranjería o PEP)' : undefined,
    context.nombre === undefined ? 'el nombre' : undefined,
    context.email === undefined ? 'el correo' : undefined,
  ].filter((dato): dato is string => dato !== undefined);
  if (enVenta && faltan.length) {
    lineas.push(`Falta por capturar: ${faltan.join(', ')}. Pide uno por turno.`);
  }

  if (!lineas.length) return '';
  return 'ESTADO DE LA VENTA EN CURSO (esto manda sobre lo que recuerdes de la ' +
    'conversación):\n' + lineas.map((l) => `- ${l}`).join('\n');
}

export function instruccionesCon(context: ConversationContext): string {
  const ficha = fichaDeVenta(context);
  return ficha ? `${INSTRUCTIONS}\n\n${ficha}` : INSTRUCTIONS;
}

export type FaseVoz = 'consentimiento' | 'descubrimiento' | 'cierre';

const HERRAMIENTAS_POR_FASE: Record<FaseVoz, readonly string[]> = {
  consentimiento: ['autorizar', 'escalar_a_humano'],
  descubrimiento: ['cotizar', 'consultar_afiliado', 'registrar_mascotas', 'registrar_lead', 'escalar_a_humano'],
  cierre: [
    'cotizar', 'seleccionar_producto', 'registrar_mascotas', 'capturar_datos',
    'preguntas_aseguramiento', 'emitir_poliza', 'generar_link_pago', 'escalar_a_humano',
  ],
};

export function faseDe(context: ConversationContext): FaseVoz {
  if (context.autorizado !== true) return 'consentimiento';
  const eligio = !!context.quoteProductId || !!context.selectedProductIds?.length;
  return eligio ? 'cierre' : 'descubrimiento';
}

type MapaHerramientas = Record<string, llm.ToolContextEntry>;

function construirHerramientas(state: VoiceSessionState, deps: ToolDeps): MapaHerramientas {
  return {
    autorizar: createAutorizarTool(state),
    consultar_afiliado: createConsultarAfiliadoTool(deps, state),
    cotizar: createCotizarTool(deps.quoting, (cotizacion) => {
      const shown = state.context.shownProductIds ?? [];
      const productId = cotizacion.productId;
      state.merge({
        quoteProductId: productId,
        shownProductIds: shown.includes(productId) ? shown : [...shown, productId],
        quoteSnapshot: cotizacion,
      });
    }, () => state.context),
    seleccionar_producto: createSeleccionarProductoTool(deps, state),
    capturar_datos: createCapturarDatosTool(state),
    registrar_lead: createRegistrarLeadTool(state),
    escalar_a_humano: createEscalarTool(state),
    registrar_mascotas: createRegistrarMascotasTool(state),
    preguntas_aseguramiento: createPreguntasAseguramientoTool(deps, state),
    emitir_poliza: createEmitirPolizaTool(deps, state),
    generar_link_pago: createGenerarLinkPagoTool(deps, state, () => construirUrlDeRetorno(state.conversationId)),
  };
}

export function herramientasDeFase(
  state: VoiceSessionState,
  deps: ToolDeps = { quoting, catalog },
  fase: FaseVoz = faseDe(state.context),
): llm.ToolContextEntry[] {
  const todas = construirHerramientas(state, deps);
  return HERRAMIENTAS_POR_FASE[fase].map((name) => todas[name]);
}

export function createVoiceAgent(state: VoiceSessionState, deps: ToolDeps = { quoting, catalog }): voice.Agent {
  return voice.Agent.create({
    instructions: instruccionesCon(state.context),
    tools: herramientasDeFase(state, deps),
  });
}
