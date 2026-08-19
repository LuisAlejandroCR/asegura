// router-parity.harness.ts: runs one scenario through both engines and compares only the
// context keys a fixture declares. Wording is free to differ — that is the point of the
// migration; what may not differ is what the conversation ends up knowing.
import { ConversationState, ConversationContext } from './types';
import { makeMessage, makeIntent, buildService } from './agent.service.test-helpers';
import { ProductCatalog } from './../quoting/product-catalog.service';
import { QuotingService } from '../quoting/quoting.service';
import { ToolRouterService } from './tool-router.service';
import { ChatTurn, InsuranceIntent, ToolCallRequest } from '../nlp/types';

export const quoting = new QuotingService(new ProductCatalog());

export const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest =>
  ({ id: `c-${name}`, name, args });

export interface ParityFixture {
  name: string;
  state: ConversationState;
  context?: ConversationContext;
  user: string;
  // What the model would ask for on this turn, if the router were driving.
  modelTurns: Array<{ text?: string; toolCalls?: ToolCallRequest[] }>;
  // The same understanding, expressed the way the machine consumes it. Without this the
  // comparison is rigged: the machine's stub NLP returns null while the router's script
  // already "understood" the message, so they diverge on the harness, not on behaviour.
  intent?: Partial<InsuranceIntent>;
  // Only these keys are compared. `undefined` asserts both engines leave it unset.
  compare: Array<keyof ConversationContext>;
  deps?: Partial<ConstructorParameters<typeof ToolRouterService>[0]>;
}

function scriptedModel(turns: ParityFixture['modelTurns']) {
  let i = 0;
  return {
    isEnabled: true,
    extractIntent: jest.fn(),
    chatWithTools: jest.fn(async (_m: ChatTurn[]) => turns[Math.min(i++, turns.length - 1)]),
  } as never;
}

// The machine persists through saveState; its last write is the outcome of the turn. When it
// writes nothing, the turn changed nothing, so the starting context IS the outcome.
export async function machineOutcome(f: ParityFixture): Promise<ConversationContext> {
  const { service, telegram, conversations } = buildService({
    state: f.state,
    context: f.context ?? {},
    ...(f.intent ? { intent: makeIntent(f.intent) } : {}),
  });
  telegram.normalize.mockResolvedValue(makeMessage(f.user));
  await service.handleMessage({});
  const calls = conversations.saveState.mock.calls;
  return (calls.length ? calls[calls.length - 1][2] : (f.context ?? {})) as ConversationContext;
}

export async function routerOutcome(f: ParityFixture): Promise<ConversationContext> {
  const router = new ToolRouterService({ quoting, ...(f.deps ?? {}) });
  const reply = await router.handle(scriptedModel(f.modelTurns), 'conv-1', f.context ?? {}, 'sys', [], f.user);
  return reply.context;
}

export function pick(ctx: ConversationContext, keys: Array<keyof ConversationContext>) {
  return Object.fromEntries(keys.map((k) => [k, ctx[k]]));
}

// ── Multi-turn ──────────────────────────────────────────────────────────────
// The engines reach the same place in a DIFFERENT number of turns, so each one gets its own
// script and only the END of the conversation is compared. That is the honest question:
// given this exchange, do both end up knowing the same things?

export interface MultiTurnFixture {
  name: string;
  start: { state: ConversationState; context?: ConversationContext };
  machineTurns: Array<{ user: string; intent?: Partial<InsuranceIntent> }>;
  routerTurns: Array<{ user: string; modelTurns: ParityFixture['modelTurns'] }>;
  compare: Array<keyof ConversationContext>;
  deps?: ParityFixture['deps'];
}

export async function runMachine(f: MultiTurnFixture): Promise<ConversationContext> {
  let state = f.start.state;
  let context: ConversationContext = f.start.context ?? {};

  for (const turn of f.machineTurns) {
    const { service, telegram, conversations } = buildService({
      state,
      context,
      ...(turn.intent ? { intent: makeIntent(turn.intent) } : {}),
    });
    telegram.normalize.mockResolvedValue(makeMessage(turn.user));
    await service.handleMessage({});

    const calls = conversations.saveState.mock.calls;
    if (calls.length) {
      const last = calls[calls.length - 1];
      state = last[1] as ConversationState;
      context = last[2] as ConversationContext;
    }
  }
  return context;
}

export async function runRouter(f: MultiTurnFixture): Promise<ConversationContext> {
  const router = new ToolRouterService({ quoting, ...(f.deps ?? {}) });
  let context: ConversationContext = f.start.context ?? {};

  for (const turn of f.routerTurns) {
    context = (await router.handle(scriptedModel(turn.modelTurns), 'conv-1', context, 'sys', [], turn.user)).context;
  }
  return context;
}
