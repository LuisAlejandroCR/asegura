// meta-webhook.controller.spec.ts: the GET subscription handshake, and the two production
// properties the POST half owes agent_loops' production checklist — it acknowledges before
// doing the work, and a redelivered wamid does nothing the second time.

import { ForbiddenException } from '@nestjs/common';
import { MetaWebhookController } from './meta-webhook.controller';

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as any;
}

function body(messageId: string) {
  return { entry: [{ changes: [{ value: { messages: [{ id: messageId, from: '573001234567' }] } }] }] };
}

describe('MetaWebhookController — GET verification handshake', () => {
  const config = makeConfig({ WHATSAPP_VERIFY_TOKEN: 'el-token-secreto' });

  it('echoes hub.challenge when the mode and token match', () => {
    const controller = new MetaWebhookController({} as any, config);
    expect(controller.verify('subscribe', 'el-token-secreto', '1158201444')).toBe('1158201444');
  });

  it('rejects a wrong verify token', () => {
    const controller = new MetaWebhookController({} as any, config);
    expect(() => controller.verify('subscribe', 'otro', '1158201444')).toThrow(ForbiddenException);
  });

  it('rejects a mode that is not "subscribe"', () => {
    const controller = new MetaWebhookController({} as any, config);
    expect(() => controller.verify('unsubscribe', 'el-token-secreto', '1')).toThrow(ForbiddenException);
  });

  // Fail closed: with no token configured, anyone could point their own Meta app here.
  it('rejects every handshake when WHATSAPP_VERIFY_TOKEN is unset', () => {
    const controller = new MetaWebhookController({} as any, makeConfig({}));
    expect(() => controller.verify('subscribe', '', '1')).toThrow(ForbiddenException);
  });
});

describe('MetaWebhookController — POST delivery', () => {
  it('returns before the turn is processed, so Meta is not left waiting on the LLM', () => {
    let resolveTurn: () => void = () => undefined;
    const agent = { handleMessage: jest.fn(() => new Promise<void>((r) => (resolveTurn = r))) };
    const controller = new MetaWebhookController(agent as any, makeConfig({}));

    expect(controller.handle(body('wamid.A'))).toBeUndefined();
    expect(agent.handleMessage).toHaveBeenCalledTimes(1);
    resolveTurn();
  });

  // The failure this prevents: Meta redelivers anything it did not see acknowledged, and a
  // second run of the same turn is a second payment link.
  it('ignores a redelivered wamid', () => {
    const agent = { handleMessage: jest.fn().mockResolvedValue(undefined) };
    const controller = new MetaWebhookController(agent as any, makeConfig({}));

    controller.handle(body('wamid.A'));
    controller.handle(body('wamid.A'));
    expect(agent.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('still processes a different wamid', () => {
    const agent = { handleMessage: jest.fn().mockResolvedValue(undefined) };
    const controller = new MetaWebhookController(agent as any, makeConfig({}));

    controller.handle(body('wamid.A'));
    controller.handle(body('wamid.B'));
    expect(agent.handleMessage).toHaveBeenCalledTimes(2);
  });

  // A status payload has no message id to dedupe on; normalize() drops it downstream.
  it('passes a payload with no message id straight through without deduping', () => {
    const agent = { handleMessage: jest.fn().mockResolvedValue(undefined) };
    const controller = new MetaWebhookController(agent as any, makeConfig({}));

    controller.handle({ entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }] }] });
    controller.handle({ entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }] }] });
    expect(agent.handleMessage).toHaveBeenCalledTimes(2);
  });

  // An unhandled rejection here took the whole process down once on the Telegram side.
  it('swallows a failing turn instead of leaving an unhandled rejection', async () => {
    const agent = { handleMessage: jest.fn().mockRejectedValue(new Error('LLM down')) };
    const controller = new MetaWebhookController(agent as any, makeConfig({}));

    expect(() => controller.handle(body('wamid.C'))).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
