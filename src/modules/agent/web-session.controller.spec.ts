// web-session.controller.spec.ts: the HTTP surface texto.html/voz.html actually call.
// Verifies token gating (invalid/expired → 401, never leaks conversation data) and that
// each endpoint delegates to the already-tested WebSessionTokenService/AgentService
// methods rather than re-implementing anything.

import { UnauthorizedException } from '@nestjs/common';
import { WebSessionController } from './web-session.controller';
import { ConversationState } from './types';

function makeDeps(overrides: { verify?: any; channel?: string; configValues?: Record<string, string> } = {}) {
  const tokens = {
    verify: jest.fn(overrides.verify ?? (() => ({ conversationId: 'conv-1' }))),
  };
  const conversations = {
    findById: jest.fn().mockResolvedValue({
      id: 'conv-1',
      user_id: 'u1',
      channel: overrides.channel ?? 'telegram',
      state: ConversationState.DISCOVERY,
      context: { lastMessages: [{ role: 'agent', text: 'hola' }] },
    }),
  };
  const agent = {
    handleWebMessage: jest.fn().mockResolvedValue({
      texts: ['ok'],
      state: ConversationState.DISCOVERY,
      progress: { step: 1, totalSteps: 6, label: 'Cuéntanos' },
      expectedInput: 'text',
    }),
  };
  const config = {
    get: jest.fn((key: string) => (overrides.configValues ?? {})[key]),
  };
  const controller = new WebSessionController(tokens as any, conversations as any, agent as any, config as any);
  return { controller, tokens, conversations, agent, config };
}

describe('WebSessionController — GET :token', () => {
  it('rejects an invalid/expired token with 401, never touching ConversationService', async () => {
    const { controller, conversations } = makeDeps({ verify: () => null });
    await expect(controller.getSession('bad-token')).rejects.toThrow(UnauthorizedException);
    expect(conversations.findById).not.toHaveBeenCalled();
  });

  it('returns state/progress/transcript for a valid token', async () => {
    const { controller } = makeDeps();
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.state).toBe(ConversationState.DISCOVERY);
    expect(snapshot.progress.totalSteps).toBeGreaterThan(0);
    expect(snapshot.transcript).toEqual([{ role: 'agent', text: 'hola' }]);
  });

  it('rejects when the token verifies but the conversation no longer exists', async () => {
    const { controller, conversations } = makeDeps();
    conversations.findById.mockResolvedValue(null);
    await expect(controller.getSession('good-token')).rejects.toThrow(UnauthorizedException);
  });

  it('includes the conversation channel — texto.html/voz.html need it to pick the post-checkout return mechanic (plan-17 §12)', async () => {
    const { controller } = makeDeps({ channel: 'whatsapp' });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.channel).toBe('whatsapp');
  });

  it('returnUrl is a real wa.me link for WhatsApp when TWILIO_WHATSAPP_NUMBER is configured', async () => {
    const { controller } = makeDeps({
      channel: 'whatsapp',
      configValues: { TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155238886' },
    });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.returnUrl).toBe('https://wa.me/14155238886');
  });

  it('returnUrl is undefined for Telegram — no auto-redirect, the chat WebView already IS the chat', async () => {
    const { controller } = makeDeps({ channel: 'telegram' });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.returnUrl).toBeUndefined();
  });

  it('returnUrl is undefined for WhatsApp when TWILIO_WHATSAPP_NUMBER is unset — never crash on a misconfiguration', async () => {
    const { controller } = makeDeps({ channel: 'whatsapp' });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.returnUrl).toBeUndefined();
  });
});

describe('WebSessionController — POST :token/message', () => {
  it('rejects an invalid/expired token with 401, never calling AgentService', async () => {
    const { controller, agent } = makeDeps({ verify: () => null });
    await expect(controller.postMessage('bad-token', { text: 'hola' })).rejects.toThrow(UnauthorizedException);
    expect(agent.handleWebMessage).not.toHaveBeenCalled();
  });

  it('delegates to AgentService.handleWebMessage using the TOKEN\'s conversationId (never anything from the request body)', async () => {
    const { controller, agent } = makeDeps();
    const reply = await controller.postMessage('good-token', { text: 'hola' });
    expect(agent.handleWebMessage).toHaveBeenCalledWith('conv-1', { text: 'hola' });
    expect(reply.texts).toEqual(['ok']);
  });
});
