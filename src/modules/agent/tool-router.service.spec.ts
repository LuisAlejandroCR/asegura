// tool-router.service.spec.ts: the LLM-driven path. The model is a stub here on purpose —
// what is under test is that the router runs the shared tools, threads context between hops,
// and cannot be talked past the Ley 1581 gate.
import { ProductCatalog } from '../quoting/product-catalog.service';
import { QuotingService } from '../quoting/quoting.service';
import { ToolRouterService } from './tool-router.service';
import { ChatTurn, ToolCallRequest } from '../nlp/types';

const quoting = new QuotingService(new ProductCatalog());

// Replays a scripted sequence of model turns, and records what it was shown.
function stubModel(turns: Array<{ text?: string; toolCalls?: ToolCallRequest[] }>) {
  const seen: ChatTurn[][] = [];
  let i = 0;
  return {
    isEnabled: true,
    extractIntent: jest.fn(),
    chatWithTools: jest.fn(async (messages: ChatTurn[]) => {
      seen.push([...messages]);
      return turns[Math.min(i++, turns.length - 1)];
    }),
    seen,
  } as any;
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({ id: `c${name}`, name, args });

describe('ToolRouterService', () => {
  it('returns the model answer when no tool was asked for', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = stubModel([{ text: '¡Hola! ¿Qué quieres proteger?' }]);

    const reply = await router.handle(nlp, 'conv-1', {}, 'sys', [], 'hola');
    expect(reply.text).toBe('¡Hola! ¿Qué quieres proteger?');
  });

  it('runs a tool and feeds its result back before answering', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = stubModel([
      { toolCalls: [call('cotizar', { productCategory: 'vida' })] },
      { text: 'Te recomiendo el seguro de vida.' },
    ]);

    const reply = await router.handle(nlp, 'conv-1', { autorizado: true }, 'sys', [], 'quiero vida');

    expect(reply.text).toBe('Te recomiendo el seguro de vida.');
    // The quoted product is remembered, so emitir_poliza later prices the same thing.
    expect(reply.context.quoteProductId).toBeTruthy();
    const toolTurn = nlp.seen[1].find((m: ChatTurn) => m.role === 'tool');
    expect(JSON.parse(toolTurn.content)).toMatchObject({ ok: true });
  });

  // The gate lives in the tools, so no amount of prompting reaches the data.
  it('cannot be talked past Ley 1581 — the tool refuses and the model is told why', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = stubModel([
      { toolCalls: [call('consultar_afiliado', { serie: '42' })] },
      { text: 'Necesito tu autorización primero.' },
    ]);

    const reply = await router.handle(nlp, 'conv-1', {}, 'sys', [], 'mi id es 42');

    const toolTurn = nlp.seen[1].find((m: ChatTurn) => m.role === 'tool');
    expect(JSON.parse(toolTurn.content)).toMatchObject({ ok: false });
    expect(reply.context.serieId).toBeUndefined();
  });

  it('records authorization so the following tools are allowed', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = stubModel([
      { toolCalls: [call('autorizar', { autoriza: true })] },
      { text: 'Gracias.' },
    ]);

    const reply = await router.handle(nlp, 'conv-1', {}, 'sys', [], 'sí, autorizo');
    expect(reply.context.autorizado).toBe(true);
  });

  it('an unknown tool name is answered, not thrown', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = stubModel([{ toolCalls: [call('inventada')] }, { text: 'Listo.' }]);

    await expect(router.handle(nlp, 'conv-1', {}, 'sys', [], 'x')).resolves.toBeDefined();
  });

  // A model that keeps calling tools must not keep a person waiting forever.
  it('stops after the hop limit instead of looping', async () => {
    const router = new ToolRouterService({ quoting });
    const nlp = stubModel([{ toolCalls: [call('cotizar', { productCategory: 'vida' })] }]);

    await router.handle(nlp, 'conv-1', { autorizado: true }, 'sys', [], 'x');
    // Four hops plus the final toolless call.
    expect(nlp.chatWithTools).toHaveBeenCalledTimes(5);
  });
});
