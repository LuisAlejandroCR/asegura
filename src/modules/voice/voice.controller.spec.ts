// voice.controller.spec.ts: POST /voice/session — the LiveKit token endpoint AseguraWeb's
// voz.html calls. Verifies the webToken → LiveKit identity linkage (plan-17 §11/§12
// groundwork): a valid webToken ties the room to the real conversationId; an invalid/
// missing one falls back to today's random-identity behavior, never crashes.

import { VoiceController } from './voice.controller';

function makeDeps(overrides: { verify?: any; createSession?: any } = {}) {
  const reminders = { closeNow: jest.fn(async () => undefined) };
  const liveKit = {
    createSession: jest.fn(overrides.createSession ?? (async (identity?: string) => ({
      url: 'wss://asegura.livekit.cloud', token: 'jwt.token.here', roomName: 'asegura-room', identity,
    }))),
  };
  const webSessionTokens = {
    verify: jest.fn(overrides.verify ?? (() => null)),
  };
  const controller = new VoiceController(liveKit as any, webSessionTokens as any, reminders as any);
  return { controller, liveKit, webSessionTokens, reminders };
}

describe('VoiceController.createSession — webToken linkage', () => {
  it('uses the token\'s conversationId as the LiveKit identity when webToken verifies', async () => {
    const { controller, liveKit, webSessionTokens } = makeDeps({
      verify: () => ({ conversationId: 'conv-42' }),
    });
    await controller.createSession({ webToken: 'good-token' });
    expect(webSessionTokens.verify).toHaveBeenCalledWith('good-token');
    expect(liveKit.createSession).toHaveBeenCalledWith('conv-42');
  });

  it('falls back to a random identity (no args) when webToken is missing', async () => {
    const { controller, liveKit, webSessionTokens } = makeDeps();
    await controller.createSession({});
    expect(webSessionTokens.verify).not.toHaveBeenCalled();
    expect(liveKit.createSession).toHaveBeenCalledWith();
  });

  it('falls back to a random identity when webToken is present but invalid/expired — never crashes', async () => {
    const { controller, liveKit } = makeDeps({ verify: () => null });
    await controller.createSession({ webToken: 'bad-token' });
    expect(liveKit.createSession).toHaveBeenCalledWith();
  });

  it('throws ServiceUnavailableException when LiveKit itself is not configured (unchanged behavior)', async () => {
    const { controller } = makeDeps({ createSession: async () => null });
    await expect(controller.createSession({})).rejects.toThrow('Voice is not configured');
  });
});

// "Terminar" solo colgaba la llamada: el chat seguía creyendo que la persona estaba en
// AseguraWeb hasta que vencía un temporizador de minutos.
describe('VoiceController.endSession — cerrar el chat al terminar en la web', () => {
  it('cierra la conversación que firma el token', async () => {
    const { controller, reminders } = makeDeps({ verify: () => ({ conversationId: 'conv-42' }) });

    const resultado = await controller.endSession({ webToken: 'good-token' });

    expect(resultado).toEqual({ closed: true });
    expect(reminders.closeNow).toHaveBeenCalledWith('conv-42', expect.stringContaining('AseguraWeb'));
  });

  it('sin token válido no cierra nada y responde igual', async () => {
    const { controller, reminders } = makeDeps({ verify: () => null });

    expect(await controller.endSession({ webToken: 'bad-token' })).toEqual({ closed: false });
    expect(await controller.endSession({})).toEqual({ closed: false });
    expect(reminders.closeNow).not.toHaveBeenCalled();
  });
});
