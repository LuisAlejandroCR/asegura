// web-session.controller.spec.ts: the HTTP surface texto.html/voz.html actually call.
// Verifies token gating (invalid/expired → 401, never leaks conversation data) and that
// each endpoint delegates to the already-tested WebSessionTokenService/AgentService
// methods rather than re-implementing anything.

import { UnauthorizedException } from '@nestjs/common';
import { WebSessionController } from './web-session.controller';
import { ConversationState } from './types';

function makeDeps(overrides: { verify?: any; channel?: string; configValues?: Record<string, string>; context?: Record<string, unknown>; botUsername?: string } = {}) {
  const tokens = {
    verify: jest.fn(overrides.verify ?? (() => ({ conversationId: 'conv-1' }))),
  };
  const conversations = {
    findById: jest.fn().mockResolvedValue({
      id: 'conv-1',
      user_id: 'u1',
      channel: overrides.channel ?? 'telegram',
      state: ConversationState.DISCOVERY,
      context: overrides.context ?? { lastMessages: [{ role: 'agent', text: 'hola' }] },
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
  const telegram = { botUsername: overrides.botUsername };
  const controller = new WebSessionController(tokens as any, conversations as any, agent as any, config as any, telegram as any);
  return { controller, tokens, conversations, agent, config, telegram };
}

// El link de pago que la llamada de voz generó vivía dentro del worker: la persona oía "te lo
// dejé en el chat" y no aparecía en ninguna parte. AseguraWeb lo lee de aquí.
describe('WebSessionController — el pago que la voz dejó listo', () => {
  it('publica el link de pago y la cotización que la herramienta produjo', async () => {
    const { controller } = makeDeps({
      context: {
        checkoutUrl: 'https://checkout.wompi.co/l/test_abc',
        quoteSnapshot: {
          productId: 'vida-pan-american',
          producto: 'Seguro de vida',
          aseguradora: 'Pan American Life',
          precioMensual: 12000,
          coberturas: ['Protección por fallecimiento'],
          razon: 'Tienes dos hijos que dependen de ti',
        },
      },
    });

    const snapshot = await controller.getSession('good-token');

    expect(snapshot.checkoutUrl).toBe('https://checkout.wompi.co/l/test_abc');
    expect(snapshot.cotizacion?.precioMensual).toBe(12000);
    expect(snapshot.cotizacion?.producto).toBe('Seguro de vida');
  });

  // Un precio que no salió de la herramienta es un precio inventado: sin cotización guardada
  // la hoja no se pinta, en vez de rellenarse con el catálogo por su cuenta.
  it('no inventa una cotización cuando la llamada no dejó ninguna', async () => {
    const { controller } = makeDeps({ context: { checkoutUrl: 'https://checkout.wompi.co/l/x' } });

    const snapshot = await controller.getSession('good-token');

    expect(snapshot.checkoutUrl).toBe('https://checkout.wompi.co/l/x');
    expect(snapshot.cotizacion).toBeUndefined();
  });
});

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

// "Terminar" colgaba la llamada y dejaba la página abierta: la persona tenía que tocar el botón
// y después la X. El navegador interno de Telegram no expone forma de cerrarse, pero sí atiende
// un enlace t.me — el mismo mecanismo que ya devuelve a WhatsApp.
// El webhook de Wompi guarda DISCOVERY después de cobrar, porque el chat sigue con el
// cross-sell: el estado de la fila no sirve para saber si ESTA compra se pagó.
describe('WebSessionController — cuándo la compra está pagada', () => {
  it('lo dice explícitamente, sin que la página lo deduzca del estado', async () => {
    const { controller } = makeDeps({ context: { hasCompletedPurchase: true } });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.compraConfirmada).toBe(true);
  });

  it('es falso mientras solo hay póliza emitida y link de pago', async () => {
    const { controller } = makeDeps({ context: { policyId: 'pol-1', checkoutUrl: 'https://x' } });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.compraConfirmada).toBe(false);
  });
});

describe('WebSessionController — por dónde se sale de AseguraWeb', () => {
  it('da el enlace al chat de Telegram con el usuario real del bot', async () => {
    const { controller } = makeDeps({ channel: 'telegram', botUsername: 'AseguraBot' });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.chatUrl).toBe('https://t.me/AseguraBot');
  });

  it('en WhatsApp reusa el mismo wa.me del retorno', async () => {
    const { controller } = makeDeps({
      channel: 'whatsapp',
      configValues: { TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155238886' },
    });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.chatUrl).toBe('https://wa.me/14155238886');
  });

  // Sin nombre de usuario no hay enlace que inventar: la página muestra "ya puedes cerrar"
  // en vez de mandar a la persona a una URL que no existe.
  it('sin usuario del bot no hay enlace', async () => {
    const { controller } = makeDeps({ channel: 'telegram' });
    const snapshot = await controller.getSession('good-token');
    expect(snapshot.chatUrl).toBeUndefined();
  });

  it('el retorno automático de post-checkout sigue siendo solo de WhatsApp', async () => {
    const { controller } = makeDeps({ channel: 'telegram', botUsername: 'AseguraBot' });
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
