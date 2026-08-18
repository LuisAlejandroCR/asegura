// agent.ts: the AseguraWeb voice persona — instructions plus the cotizar tool. Kept
// separate from main.ts so createVoiceAgent() is importable on its own for tests that
// don't need the LiveKit worker runtime.
import { voice } from '@livekit/agents';
import { QuotingService } from '../modules/quoting/quoting.service';
import { ProductCatalog } from '../modules/quoting/product-catalog.service';
import { createCotizarTool } from './cotizar-tool';

// A worker-local ProductCatalog instance — no NestJS DI in this process. Same YAML files on
// disk as the backend, never a second source of truth.
const quoting = new QuotingService(new ProductCatalog());

// Spoken verbatim, never through the LLM: a legal disclosure the model may paraphrase away
// is not a disclosure. Plain prose, no markdown or URLs — a TTS engine reads it aloud.
export const VOICE_GREETING =
  '¡Hola! Soy Asegura, el asesor de seguros de Colsubsidio. Antes de empezar: esta ' +
  'conversación se transcribe, y uso lo que me cuentes solo para recomendarte un seguro, ' +
  'según la Ley 1581 de 2012. ¿Me autorizas a continuar?';

const INSTRUCTIONS = `Eres Asegura, el asesor de seguros conversacional de Colsubsidio.
Hablas español de Colombia, en un tono cercano y humano — nunca leas coberturas como una
póliza legal, explícalas como se las explicarías a un vecino.

Lo primero: la persona debe autorizar el tratamiento de sus datos. El saludo ya se lo
preguntó. Hasta que responda que sí, no preguntes nada personal y no uses la herramienta
"cotizar" — solo repite la pregunta una vez si no quedó clara. Si dice que no, despídete
con amabilidad y no insistas.

Tu única fuente de precios y productos es la herramienta "cotizar". Nunca digas un precio,
nombre de producto o cobertura que no haya salido de esa herramienta en este turno — ni
redondees, ni completes de memoria. Si "cotizar" no encuentra nada, dilo honestamente y
pregunta qué más te puede contar la persona para intentar de nuevo.

Antes de cotizar, entiende brevemente a la persona: qué quiere proteger (vida, hogar,
accidentes, asistencia médica o mascotas), si depende alguien económicamente de ella, y su
presupuesto si lo menciona. No hagas un interrogatorio — una o dos preguntas cortas bastan.`;

export function createVoiceAgent(): voice.Agent {
  return voice.Agent.create({
    instructions: INSTRUCTIONS,
    tools: [createCotizarTool(quoting)],
  });
}
