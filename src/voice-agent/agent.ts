// agent.ts: the AseguraWeb voice persona — the instructions plus every capability the text
// channel has. Kept separate from main.ts so createVoiceAgent() is importable without the
// LiveKit worker runtime.
import { voice, type llm } from '@livekit/agents';
import { QuotingService } from '../modules/quoting/quoting.service';
import { ProductCatalog } from '../modules/quoting/product-catalog.service';
import { ToolDeps } from '../modules/agent/tools';
import { ConversationContext } from '../modules/agent/types';
import { VoiceSessionState } from './session-state';
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

Para cerrar la venta: cuando diga que quiere el seguro, pide el documento preguntando cuál
es — cédula de ciudadanía, cédula de extranjería o PEP — y pásalo en "documentType"; cuando
lo tengas, el nombre; después el correo — uno por turno, guardando cada uno con
"capturar_datos". Si la herramienta dice que un dato no es válido, vuelve a pedir ESE dato. Después léele un resumen
corto (producto, precio y sus datos) y pide confirmación. Solo entonces llama "emitir_poliza",
y después "generar_link_pago". El link se lo dejas en el chat: nunca leas una URL en voz alta.

Si no puedes ayudar, si te lo piden, o ante un reclamo que no resuelvas con estas
herramientas, usa "escalar_a_humano" con el motivo. No insistas ni improvises una solución.

Las herramientas mandan sobre ti: si una responde que no puede, dile a la persona lo que
falta en tus palabras, no inventes un resultado.`;

// Los esquemas de las once herramientas son ~1.000 de los ~1.075 tokens fijos de cada
// petición, y se reenvían en cada turno contra un techo de 8.000 por minuto. Exponer solo las
// del paso actual es lo único que baja ese costo sin tocar las reglas: quién puede cotizar,
// emitir o cobrar lo siguen decidiendo las precondiciones dentro de cada herramienta.
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
    cotizar: createCotizarTool(deps.quoting, (productId) => {
      const shown = state.context.shownProductIds ?? [];
      state.merge({
        quoteProductId: productId,
        shownProductIds: shown.includes(productId) ? shown : [...shown, productId],
      });
    }, () => state.context),
    seleccionar_producto: createSeleccionarProductoTool(deps, state),
    capturar_datos: createCapturarDatosTool(state),
    registrar_lead: createRegistrarLeadTool(state),
    escalar_a_humano: createEscalarTool(state),
    registrar_mascotas: createRegistrarMascotasTool(state),
    preguntas_aseguramiento: createPreguntasAseguramientoTool(deps, state),
    emitir_poliza: createEmitirPolizaTool(deps, state),
    generar_link_pago: createGenerarLinkPagoTool({ ...deps, quoting: deps.quoting }, state),
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
    instructions: INSTRUCTIONS,
    tools: herramientasDeFase(state, deps),
  });
}
