// twilio-whatsapp-adapter.service.spec.ts: normalize()'s WhatsApp-specific shape
// (contact always populated, media→transcription/unsupportedInput), the disabled-without-
// crashing degrade (same optional-integration contract as every other adapter here), and
// the outbound send methods against a mocked fetch.

import { TwilioWhatsAppAdapter } from './twilio-whatsapp-adapter.service';
import { DocumentCacheService } from './document-cache.service';

function mockResponse(status: number, body: unknown, isJson = true) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    json: jest.fn().mockResolvedValue(body),
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
    ...(isJson ? {} : {}),
  };
}

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as any;
}

const ENABLED_ENV = {
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'authtoken',
  TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155238886',
  PUBLIC_URL: 'https://asegura.example.com',
};

describe('TwilioWhatsAppAdapter — disabled (TWILIO_* not fully set)', () => {
  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it('isEnabled is false and sendText does not call fetch', async () => {
    const adapter = new TwilioWhatsAppAdapter(makeConfig({}), new DocumentCacheService());
    expect(adapter.isEnabled).toBe(false);
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    await adapter.sendText('573001234567', 'hola');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TwilioWhatsAppAdapter — normalize()', () => {
  const adapter = new TwilioWhatsAppAdapter(makeConfig(ENABLED_ENV), new DocumentCacheService());

  it('maps a plain text message to a WhatsApp NormalizedMessage', async () => {
    const msg = await adapter.normalize({
      From: 'whatsapp:+15551234567',
      To: 'whatsapp:+14155238886',
      Body: 'Quiero un seguro de vida',
      WaId: '15551234567',
      ProfileName: 'Juan',
      MessageSid: 'SM123',
    });
    expect(msg.channel).toBe('whatsapp');
    expect(msg.userId).toBe('15551234567');
    expect(msg.text).toBe('Quiero un seguro de vida');
    expect(msg.username).toBe('Juan');
  });

  // WhatsApp itself verifies the sending phone number — see the comment on normalize()'s
  // `contact` field. No request_contact button exists on this channel, so this must be
  // unconditional, unlike Telegram's opt-in self-attested share.
  it('always populates `contact` from WaId — the channel itself already verified the phone', async () => {
    const msg = await adapter.normalize({
      From: 'whatsapp:+15551234567', WaId: '15551234567', Body: 'hola', ProfileName: 'Juan',
    });
    expect(msg.contact).toEqual({ phoneNumber: '15551234567', firstName: 'Juan' });
  });

  it('flags a non-audio attachment as unsupportedInput', async () => {
    const msg = await adapter.normalize({
      From: 'whatsapp:+15551234567', WaId: '15551234567', Body: '',
      NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME123', MediaContentType0: 'image/jpeg',
    });
    expect(msg.unsupportedInput).toBe('image');
  });

  it('transcribes an audio attachment via the Twilio media URL then Groq', async () => {
    const withKey = new TwilioWhatsAppAdapter(
      makeConfig({ ...ENABLED_ENV, LLM_API_KEY: 'gsk_test' }),
      new DocumentCacheService(),
    );
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse(200, {})) // Twilio media download
      .mockResolvedValueOnce(mockResponse(200, { text: 'quiero un seguro de vida' })); // Groq
    (global as any).fetch = fetchMock;

    const msg = await withKey.normalize({
      From: 'whatsapp:+15551234567', WaId: '15551234567', Body: '',
      NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME123', MediaContentType0: 'audio/ogg',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(msg.text).toBe('quiero un seguro de vida');
    expect(msg.unsupportedInput).toBeUndefined();
    (global as any).fetch = undefined;
  });
});

describe('TwilioWhatsAppAdapter — outbound sends', () => {
  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it('sendText POSTs to the Messages API with Basic Auth and the whatsapp: prefix', async () => {
    const adapter = new TwilioWhatsAppAdapter(makeConfig(ENABLED_ENV), new DocumentCacheService());
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(201, { sid: 'SM999' }));
    (global as any).fetch = fetchMock;

    await adapter.sendText('573001234567', 'Tu cotización está lista');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
    expect(init.headers.Authorization).toMatch(/^Basic /);
    const body = init.body as URLSearchParams;
    expect(body.get('To')).toBe('whatsapp:573001234567');
    expect(body.get('From')).toBe('whatsapp:+14155238886');
    expect(body.get('Body')).toBe('Tu cotización está lista');
  });

  it('sendChoices degrades to plain text with choices appended (no Content Template)', async () => {
    const adapter = new TwilioWhatsAppAdapter(makeConfig(ENABLED_ENV), new DocumentCacheService());
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(201, {}));
    (global as any).fetch = fetchMock;

    await adapter.sendChoices('573001234567', '¿Qué te preocupa proteger?', ['❤️ Mi familia', '🏥 Mi salud']);

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('Body')).toBe('¿Qué te preocupa proteger?\n\n❤️ Mi familia\n🏥 Mi salud');
  });

  it('sendDocument registers the buffer with DocumentCacheService and sends a MediaUrl pointing at /downloads', async () => {
    const docs = new DocumentCacheService();
    const adapter = new TwilioWhatsAppAdapter(makeConfig(ENABLED_ENV), docs);
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(201, {}));
    (global as any).fetch = fetchMock;

    await adapter.sendDocument('573001234567', Buffer.from('%PDF-1.4'), 'poliza-abc.pdf');

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    const mediaUrl = body.get('MediaUrl')!;
    expect(mediaUrl.startsWith('https://asegura.example.com/downloads/')).toBe(true);
    const token = mediaUrl.split('/downloads/')[1].replace('.pdf', '');
    expect(docs.get(token)?.filename).toBe('poliza-abc.pdf');
  });

  it('reactToMessage is a safe no-op (Twilio Messages API has no reaction endpoint)', async () => {
    const adapter = new TwilioWhatsAppAdapter(makeConfig(ENABLED_ENV), new DocumentCacheService());
    await expect(adapter.reactToMessage('573001234567', 1, '👍')).resolves.toBeUndefined();
  });
});
