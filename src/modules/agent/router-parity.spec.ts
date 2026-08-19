// router-parity.spec.ts: the gate for turning the router on. Both engines run the same
// scenario and must agree on the OUTCOME — the context they leave behind — while the wording
// is free to differ. Nothing here compares prose; that is the whole point of the migration.
import { ConversationState, ConversationContext } from './types';
import { makeMessage, buildService } from './agent.service.test-helpers';
import { ProductCatalog } from '../quoting/product-catalog.service';
import { QuotingService } from '../quoting/quoting.service';
import { ToolRouterService } from './tool-router.service';
import { ChatTurn, ToolCallRequest } from '../nlp/types';

const quoting = new QuotingService(new ProductCatalog());
const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({ id: `c-${name}`, name, args });

function scriptedModel(turns: Array<{ text?: string; toolCalls?: ToolCallRequest[] }>) {
  let i = 0;
  return {
    isEnabled: true,
    extractIntent: jest.fn(),
    chatWithTools: jest.fn(async (_m: ChatTurn[]) => turns[Math.min(i++, turns.length - 1)]),
  } as any;
}

// The machine persists through saveState; its last write is the outcome of the turn.
async function machineOutcome(
  state: ConversationState,
  context: ConversationContext,
  userText: string,
): Promise<ConversationContext> {
  const { service, telegram, conversations } = buildService({ state, context });
  telegram.normalize.mockResolvedValue(makeMessage(userText));
  await service.handleMessage({});
  const calls = conversations.saveState.mock.calls;
  return (calls.length ? calls[calls.length - 1][2] : context) as ConversationContext;
}

async function routerOutcome(
  context: ConversationContext,
  userText: string,
  turns: Array<{ text?: string; toolCalls?: ToolCallRequest[] }>,
): Promise<ConversationContext> {
  const router = new ToolRouterService({ quoting });
  return (await router.handle(scriptedModel(turns), 'conv-1', context, 'sys', [], userText)).context;
}

describe('paridad — autorización', () => {
  it('ambos motores terminan con la conversación autorizada', async () => {
    const machine = await machineOutcome(ConversationState.AUTHORIZATION, {}, 'sí');
    const router = await routerOutcome({}, 'sí', [
      { toolCalls: [call('autorizar', { autoriza: true })] },
      { text: 'Gracias.' },
    ]);

    expect(machine.autorizado).toBe(true);
    expect(router.autorizado).toBe(true);
  });
});

describe('paridad — captura de cédula', () => {
  it('ambos guardan la misma cédula normalizada', async () => {
    const start = { autorizado: true, quoteProductId: 'vida' };
    const machine = await machineOutcome(ConversationState.DATA_CAPTURE, start, '12345678');
    const router = await routerOutcome(start, '12345678', [
      { toolCalls: [call('capturar_datos', { cedula: '12345678' })] },
      { text: '¿Tu nombre?' },
    ]);

    expect(machine.cedula).toBe('12345678');
    expect(router.cedula).toBe(machine.cedula);
  });

  it('ambos rechazan una cédula con puntos de miles', async () => {
    const start = { autorizado: true, quoteProductId: 'vida' };
    const machine = await machineOutcome(ConversationState.DATA_CAPTURE, start, '12.345.678');
    const router = await routerOutcome(start, '12.345.678', [
      { toolCalls: [call('capturar_datos', { cedula: '12.345.678' })] },
      { text: 'Repíteme.' },
    ]);

    expect(machine.cedula).toBeUndefined();
    expect(router.cedula).toBeUndefined();
  });
});

describe('paridad — mascotas sin especie', () => {
  it('ninguno de los dos elige un plan de una sola especie', async () => {
    const start = { autorizado: true, productCategory: 'mascotas' };
    const machine = await machineOutcome(ConversationState.DISCOVERY, start, 'tengo mascotas');
    const router = await routerOutcome(start, 'tengo mascotas', [
      { toolCalls: [call('cotizar', { productCategory: 'mascotas' })] },
      { text: 'ok' },
    ]);

    for (const outcome of [machine, router]) {
      expect(outcome.quoteProductId ?? '').not.toMatch(/gatos|perros/);
    }
  });
});
