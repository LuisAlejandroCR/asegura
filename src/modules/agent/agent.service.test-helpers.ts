// agent.service.test-helpers.ts: shared builders for AgentService spec files — extracted
// from agent.service.spec.ts so new focused spec files (e.g. per conversation state) don't
// each redefine their own copy of the same mocks.
import { AgentService } from './agent.service';
import { ConversationState, ConversationContext } from './types';
import { InsuranceIntent } from '../nlp/types';

function makeMessage(text: string) {
  return { userId: 'u1', channel: 'telegram' as const, channelId: '1', text, timestamp: new Date() };
}

function makeIntent(overrides: Partial<InsuranceIntent> = {}): InsuranceIntent {
  return { productCategory: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null, petCount: null, ...overrides };
}

function extractPetResolutionMock(lower: string): 'gato' | 'perro' | 'all' | null {
  const hasCat = lower.includes('gato') || lower.includes('michi') || lower.includes('felino');
  const hasDog = lower.includes('perro') || lower.includes('canino');
  const hasAll = lower.includes('todos') || lower.includes('ambos') || lower.includes('los dos');
  if (hasCat && !hasDog) return 'gato';
  if (hasDog && !hasCat) return 'perro';
  if (hasAll) return 'all';
  return null;
}

function makeConversation(state: ConversationState, context: ConversationContext = {}) {
  return { id: 'conv-1', user_id: 'u1', channel: 'telegram', state, context };
}

function buildService(overrides: {
  state?: ConversationState;
  context?: ConversationContext;
  intent?: InsuranceIntent;
} = {}) {
  const state = overrides.state ?? ConversationState.GREETING;
  const context = overrides.context ?? {};
  const staticIntent = overrides.intent;

  const nlp = {
    extractIntent: jest.fn().mockImplementation(async (text: string) => {
      if (staticIntent) return staticIntent;
      const lower = text.toLowerCase();
      return makeIntent({
        isAffirmative: ['sí', 'si', 'claro', 'me interesa', 'quiero', 'perfecto', 'adelante', 'todos', 'todas', 'ambos', 'hagámoslo', 'confirmo', 'listo', 'dale'].some((a) => lower.includes(a)),
        isNegative: ['no', 'paso', 'otro', 'otra', 'diferente', 'ninguno', 'ninguna', 'después', 'luego'].some((n) => lower.includes(n)),
        wantsAlternative: ['otro', 'otra', 'diferente', 'muéstrame más', 'más opciones', 'cambia', 'cambiar', 'siguiente'].some((a) => lower.includes(a)),
        petResolution: extractPetResolutionMock(lower),
      });
    }),
  };
  const telegram = {
    normalize: jest.fn().mockResolvedValue(makeMessage('test')),
    sendText: jest.fn().mockResolvedValue(undefined),
    sendDocument: jest.fn().mockResolvedValue(undefined),
  };
  const conversations = {
    getOrCreate: jest.fn().mockResolvedValue(makeConversation(state, context)),
    saveState: jest.fn().mockResolvedValue(undefined),
  };
  const quoting = {
    score: jest.fn().mockReturnValue([]),
    bestQuote: jest.fn().mockReturnValue(null),
  };
  const policy = {
    issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const wompi = {
    createPaymentLink: jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/test', paymentLinkId: 'link-test' }),
    isEnabled: true,
  };
  const service = new AgentService(
    nlp as any, telegram as any, conversations as any,
    quoting as any, policy as any, wompi as any,
  );

  return { service, nlp, telegram, conversations, quoting, policy, wompi };
}

export { makeMessage, makeIntent, extractPetResolutionMock, makeConversation, buildService };
