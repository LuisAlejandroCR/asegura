// meta-whatsapp-adapter.service.spec.ts: normalize()'s handling of Meta's nested webhook
// envelope (text, tapped list rows, voice, unsupported media, and the delivery receipts that
// arrive on the same endpoint), the disabled-without-crashing degrade every optional
// integration here shares, and the outbound calls against a mocked fetch.

import { MetaWhatsAppAdapter } from './meta-whatsapp-adapter.service';

function mockResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    json: jest.fn().mockResolvedValue(body),
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
  };
}

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as any;
}

const ENABLED_ENV = {
  WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  WHATSAPP_ACCESS_TOKEN: 'EAAGtest',
};

// The shape Meta actually posts, trimmed to the fields the adapter reads.
function webhookBody(message: Record<string, unknown>, profileName = 'Juan') {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: profileName }, wa_id: '573001234567' }],
              messages: [{ id: 'wamid.ABC', from: '573001234567', ...message }],
            },
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  (global as any).fetch = undefined;
});

describe('MetaWhatsAppAdapter — disabled (WHATSAPP_* not set)', () => {
  it('isEnabled is false and sendText does not call fetch', async () => {
    const adapter = new MetaWhatsAppAdapter(makeConfig({}));
    expect(adapter.isEnabled).toBe(false);
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    await adapter.sendText('573001234567', 'hola');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MetaWhatsAppAdapter — normalize()', () => {
  const adapter = new MetaWhatsAppAdapter(makeConfig(ENABLED_ENV));

  it('maps a plain text message to a WhatsApp NormalizedMessage', async () => {
    const msg = await adapter.normalize(webhookBody({ type: 'text', text: { body: 'Quiero un seguro de vida' } }));
    expect(msg.channel).toBe('whatsapp');
    expect(msg.userId).toBe('573001234567');
    expect(msg.text).toBe('Quiero un seguro de vida');
    expect(msg.username).toBe('Juan');
  });

  // WhatsApp itself verifies the sending phone number, so this must be unconditional —
  // unlike Telegram's opt-in self-attested share. AgentService's phoneVerified gate reads it.
  it('always populates `contact` for a real message', async () => {
    const msg = await adapter.normalize(webhookBody({ type: 'text', text: { body: 'hola' } }));
    expect(msg.contact).toEqual({ phoneNumber: '573001234567', firstName: 'Juan' });
  });

  // A tapped row must be indistinguishable from typed speech downstream — rule #10: a
  // button never replaces free text, and there is no separate callback path.
  it('maps a tapped list row to its title, as if the person had typed it', async () => {
    const msg = await adapter.normalize(
      webhookBody({
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'choice_0', title: '❤️ Mi familia' } },
      }),
    );
    expect(msg.text).toBe('❤️ Mi familia');
    expect(msg.unsupportedInput).toBeUndefined();
  });

  it('maps a tapped reply button to its title too', async () => {
    const msg = await adapter.normalize(
      webhookBody({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Sí, acepto' } },
      }),
    );
    expect(msg.text).toBe('Sí, acepto');
  });

  it('flags an image as unsupportedInput', async () => {
    const msg = await adapter.normalize(webhookBody({ type: 'image', image: { id: 'media123' } }));
    expect(msg.unsupportedInput).toBe('image');
  });

  // The bug this prevents: a delivery receipt carries no `messages`, and populating
  // `contact` anyway would run the whole state machine on a read confirmation.
  it('returns an empty message with no contact for a delivery/read status payload', async () => {
    const msg = await adapter.normalize({
      entry: [{ changes: [{ value: { statuses: [{ status: 'delivered', id: 'wamid.ABC' }] } }] }],
    });
    expect(msg.text).toBe('');
    expect(msg.contact).toBeUndefined();
  });

  it('does not throw on a body that is nothing like a webhook', async () => {
    const msg = await adapter.normalize({ unexpected: true });
    expect(msg.text).toBe('');
    expect(msg.contact).toBeUndefined();
  });

  it('transcribes a voice note through the media lookup, the download and Groq', async () => {
    const adapterWithKey = new MetaWhatsAppAdapter(makeConfig({ ...ENABLED_ENV, LLM_API_KEY: 'gsk_test' }));
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { url: 'https://lookaside.fbsbx.com/audio' }))
      .mockResolvedValueOnce(mockResponse(200, {}))
      .mockResolvedValueOnce(mockResponse(200, { text: 'Quiero asegurar a mi mamá' }));
    (global as any).fetch = fetchMock;

    const msg = await adapterWithKey.normalize(webhookBody({ type: 'audio', audio: { id: 'media999', voice: true } }));
    expect(msg.text).toBe('Quiero asegurar a mi mamá');
    // The CDN URL is not public — the download must carry the same bearer token.
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer EAAGtest');
  });

  it('degrades to empty text when the media lookup fails, instead of throwing', async () => {
    const adapterWithKey = new MetaWhatsAppAdapter(makeConfig({ ...ENABLED_ENV, LLM_API_KEY: 'gsk_test' }));
    (global as any).fetch = jest.fn().mockResolvedValue(mockResponse(404, 'not found'));
    const msg = await adapterWithKey.normalize(webhookBody({ type: 'audio', audio: { id: 'media999' } }));
    expect(msg.text).toBe('');
  });
});

describe('MetaWhatsAppAdapter — outbound', () => {
  const adapter = new MetaWhatsAppAdapter(makeConfig(ENABLED_ENV));

  it('sendText posts a text message to the pinned Graph version and phone number id', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { messages: [{ id: 'wamid.X' }] }));
    (global as any).fetch = fetchMock;
    await adapter.sendText('573001234567', 'Tu póliza quedó lista');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v25.0/123456789012345/messages');
    expect(init.headers.Authorization).toBe('Bearer EAAGtest');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '573001234567',
      type: 'text',
      text: { body: 'Tu póliza quedó lista', preview_url: true },
    });
  });

  it('honours WHATSAPP_GRAPH_VERSION when set', async () => {
    const pinned = new MetaWhatsAppAdapter(makeConfig({ ...ENABLED_ENV, WHATSAPP_GRAPH_VERSION: 'v26.0' }));
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, {}));
    (global as any).fetch = fetchMock;
    await pinned.sendText('573001234567', 'hola');
    expect(fetchMock.mock.calls[0][0]).toContain('/v26.0/');
  });

  // The whole reason WhatsApp no longer needs PUBLIC_URL or the unauthenticated /downloads
  // route: the PDF goes up as bytes and is sent by media id.
  it('sendDocument uploads the buffer and sends it by media id, never a URL', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { id: 'media-abc' }))
      .mockResolvedValueOnce(mockResponse(200, {}));
    (global as any).fetch = fetchMock;
    await adapter.sendDocument('573001234567', Buffer.from('%PDF-1.4'), 'poliza.pdf');

    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v25.0/123456789012345/media');
    const sendBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sendBody).toMatchObject({ type: 'document', document: { id: 'media-abc', filename: 'poliza.pdf' } });
  });

  it('sendDocument sends nothing when the upload fails, rather than a broken message', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(mockResponse(400, { error: 'too big' }));
    (global as any).fetch = fetchMock;
    await adapter.sendDocument('573001234567', Buffer.from('%PDF-1.4'), 'poliza.pdf');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sendChoices sends a native interactive list when every choice fits Meta limits', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, {}));
    (global as any).fetch = fetchMock;
    await adapter.sendChoices('573001234567', '¿Qué te preocupa hoy?', [
      '❤️ Mi familia',
      '🏥 Mi salud',
      '🐾 Mi mascota',
      '🤕 Accidentes',
      '🤔 No estoy seguro',
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('interactive');
    expect(body.interactive.action.sections[0].rows).toHaveLength(5);
    expect(body.interactive.action.sections[0].rows[0]).toEqual({ id: 'choice_0', title: '❤️ Mi familia' });
  });

  // A 400 from an over-long row would leave the person with no message at all, so the
  // list degrades to plain text where the keywords still match if they retype one.
  it('sendChoices falls back to plain text when a choice exceeds Meta 24-char row title', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, {}));
    (global as any).fetch = fetchMock;
    await adapter.sendChoices('573001234567', '¿Qué te preocupa?', ['a'.repeat(25), 'corta']);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('text');
    expect(body.text.body).toContain('corta');
  });

  it('sendChoices falls back to plain text with more than 10 choices', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, {}));
    (global as any).fetch = fetchMock;
    await adapter.sendChoices('573001234567', 'Elige', Array.from({ length: 11 }, (_, i) => `op ${i}`));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).type).toBe('text');
  });

  it('does not throw when Meta answers an error', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue(mockResponse(400, { error: { message: 'bad token' } }));
    await expect(adapter.sendText('573001234567', 'hola')).resolves.toBeUndefined();
  });

  it('reactToMessage is a no-op — a wamid cannot be carried in the numeric messageId', async () => {
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    await adapter.reactToMessage('573001234567', 42, '👍');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
