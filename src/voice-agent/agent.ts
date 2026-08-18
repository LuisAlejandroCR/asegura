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

const INSTRUCTIONS = `Eres Asegura, el asesor de seguros conversacional de Colsubsidio.
Hablas español de Colombia, en un tono cercano y humano — nunca leas coberturas como una
póliza legal, explícalas como se las explicarías a un vecino.

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
