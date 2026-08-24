// telegram-webhook.controller.spec.ts: grammy rejects the webhook promise after its timeout,
// and nobody awaited it — the unhandled rejection killed the whole API, which Railway restarted
// every two minutes.
import { TelegramWebhookController } from './telegram-webhook.controller';

function makeController(handler: (req: unknown, res: unknown) => unknown) {
  const telegram = { webhookCallback: () => handler };
  return new TelegramWebhookController(telegram as never);
}

describe('POST /webhook/telegram', () => {
  it('un handler que se pasa del tiempo no tumba el proceso', async () => {
    const controller = makeController(() => Promise.reject(new Error('Request timed out after 10000 ms')));

    await expect(controller.handle({} as never, respuesta() as never)).resolves.toBeUndefined();
  });

  it('responde 200 igual: Telegram reintenta una entrega sin respuesta', async () => {
    const res = respuesta();
    const controller = makeController(() => Promise.reject(new Error('boom')));

    await controller.handle({} as never, res as never);

    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it('no responde dos veces cuando grammy ya contestó', async () => {
    const res = respuesta({ headersSent: true });
    const controller = makeController(() => Promise.reject(new Error('boom')));

    await controller.handle({} as never, res as never);

    expect(res.sendStatus).not.toHaveBeenCalled();
  });

  it('deja pasar el camino feliz sin tocar la respuesta', async () => {
    const res = respuesta();
    const controller = makeController(() => Promise.resolve());

    await controller.handle({} as never, res as never);

    expect(res.sendStatus).not.toHaveBeenCalled();
  });
});

function respuesta(overrides: { headersSent?: boolean } = {}) {
  return { headersSent: overrides.headersSent ?? false, sendStatus: jest.fn() };
}
