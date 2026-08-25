// channel-registry.service.spec.ts: the resolver AgentService and the Wompi webhook
// both rely on to reply on the same channel a message/conversation came in on.

import { ChannelRegistry } from './channel-registry.service';

describe('ChannelRegistry', () => {
  it('resolves "whatsapp" to the Meta adapter', () => {
    const telegram = {} as any;
    const whatsapp = {} as any;
    const registry = new ChannelRegistry(telegram, whatsapp);
    expect(registry.get('whatsapp')).toBe(whatsapp);
  });

  it('resolves "telegram" to the Telegram adapter', () => {
    const telegram = {} as any;
    const whatsapp = {} as any;
    const registry = new ChannelRegistry(telegram, whatsapp);
    expect(registry.get('telegram')).toBe(telegram);
  });
});
