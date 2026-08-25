// meta-whatsapp-adapter.service.ts: the WhatsApp implementation of IChannelAdapter, talking
// to Meta's WhatsApp Cloud API directly with fetch — the same lean-fetch convention this
// codebase uses for Wompi and Groq. Contract read from developers.facebook.com on 2026-08-25:
//   POST https://graph.facebook.com/{version}/{phoneNumberId}/messages   send anything
//   POST https://graph.facebook.com/{version}/{phoneNumberId}/media      upload, returns {id}
//   GET  https://graph.facebook.com/{version}/{mediaId}                  returns {url}, 5 min TTL
// Auth is a bearer token on every call, media URLs included.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { IChannelAdapter, NormalizedMessage } from './types';

// Meta's webhook envelope — only the fields this adapter reads. Everything is optional
// because a delivery receipt arrives on the same endpoint with `statuses` and no `messages`.
interface MetaWebhookBody {
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: MetaInboundMessage[];
        statuses?: unknown[];
      };
    }[];
  }[];
}

interface MetaInboundMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; voice?: boolean };
  interactive?: {
    type?: string;
    list_reply?: { id?: string; title?: string };
    button_reply?: { id?: string; title?: string };
  };
}

// Meta's own limits for an interactive list, same source and date as the endpoints above.
const LIST_MAX_ROWS = 10;
const LIST_ROW_TITLE_MAX = 24;
const LIST_BODY_MAX = 1024;

@Injectable()
export class MetaWhatsAppAdapter implements IChannelAdapter {
  private readonly logger = new Logger(MetaWhatsAppAdapter.name);
  private readonly enabled: boolean;
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly graphVersion: string;

  constructor(private readonly config: ConfigService) {
    this.phoneNumberId = config.get<string>('WHATSAPP_PHONE_NUMBER_ID') ?? '';
    this.accessToken = config.get<string>('WHATSAPP_ACCESS_TOKEN') ?? '';
    // Pinned to the version the contract above was read against; overridable so a Meta
    // deprecation is an env change in Railway, not a redeploy.
    this.graphVersion = config.get<string>('WHATSAPP_GRAPH_VERSION') ?? 'v25.0';
    this.enabled = !!(this.phoneNumberId && this.accessToken);
    if (!this.enabled) {
      this.logger.warn('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set — WhatsApp disabled');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private get graphBase(): string {
    return `https://graph.facebook.com/${this.graphVersion}`;
  }

  async normalize(raw: unknown): Promise<NormalizedMessage> {
    const value = (raw as MetaWebhookBody)?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const profileName = value?.contacts?.[0]?.profile?.name ?? '';
    const userId = message?.from ?? value?.contacts?.[0]?.wa_id ?? '';

    // A delivery/read receipt hits the same endpoint with `statuses` instead of `messages`.
    // Returning without `contact` is what makes AgentService bail on the empty-text check —
    // populating it unconditionally would run the whole state machine on a read receipt.
    if (!message || !userId) {
      return { channelId: userId, channel: 'whatsapp', userId, text: '', timestamp: new Date() };
    }

    let text = '';
    let unsupportedInput: NormalizedMessage['unsupportedInput'];

    if (message.type === 'text') {
      text = message.text?.body ?? '';
    } else if (message.type === 'interactive') {
      // A tapped row arrives as an ordinary inbound message on this same webhook, so its
      // title becomes the text and flows through extractIntent exactly like typed speech.
      text = message.interactive?.list_reply?.title ?? message.interactive?.button_reply?.title ?? '';
    } else if (message.type === 'audio' && message.audio?.id) {
      try {
        text = await this.transcribeVoice(message.audio.id);
      } catch (err) {
        this.logger.error(`Voice transcription failed: ${err}`);
      }
    } else {
      unsupportedInput = 'image';
    }

    return {
      channelId: userId,
      channel: 'whatsapp',
      userId,
      ...(profileName && { username: profileName }),
      text,
      timestamp: new Date(),
      metadata: { messageId: message.id },
      ...(unsupportedInput && { unsupportedInput }),
      // WhatsApp verifies the sending number itself, so every inbound message already proves
      // the phone. Populated unconditionally to satisfy AgentService's phoneVerified gate.
      contact: { phoneNumber: userId, firstName: profileName },
    };
  }

  private async transcribeVoice(mediaId: string): Promise<string> {
    const llmKey = this.config.get<string>('LLM_API_KEY');
    if (!llmKey) {
      this.logger.warn('LLM_API_KEY not set — voice transcription disabled');
      return '';
    }
    const auth = { Authorization: `Bearer ${this.accessToken}` };

    const metaRes = await fetch(`${this.graphBase}/${mediaId}`, { headers: auth });
    if (!metaRes.ok) {
      throw new Error(`Meta media lookup failed: ${metaRes.status}`);
    }
    const { url } = (await metaRes.json()) as { url?: string };
    if (!url) {
      throw new Error('Meta media lookup returned no url');
    }

    // The CDN URL is not public: it needs the same bearer token as the Graph call.
    const binRes = await fetch(url, { headers: auth });
    if (!binRes.ok) {
      throw new Error(`Meta media download failed: ${binRes.status}`);
    }
    const audioBuffer = Buffer.from(await binRes.arrayBuffer());

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'es');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${llmKey}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Groq transcription failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { text?: string };
    this.logger.log(`Voice transcribed (${(data.text ?? '').length} chars)`);
    return data.text ?? '';
  }

  private async send(to: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    const res = await fetch(`${this.graphBase}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    });
    if (!res.ok) {
      this.logger.error(`Meta send failed: ${res.status} ${await res.text()}`);
    }
  }

  // Uploading returns a media id usable for 30 days. This is why WhatsApp no longer needs
  // PUBLIC_URL or the unauthenticated /downloads route the Twilio adapter depended on.
  private async uploadMedia(file: Buffer, filename: string, mimeType: string): Promise<string | null> {
    if (!this.enabled) return null;
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    // Uint8Array, not the Buffer itself: a Buffer's backing store is typed ArrayBufferLike,
    // which strict mode refuses as a BlobPart.
    form.append('file', new Blob([new Uint8Array(file)], { type: mimeType }), filename);

    const res = await fetch(`${this.graphBase}/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });
    if (!res.ok) {
      this.logger.error(`Meta media upload failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as { id?: string };
    return data.id ?? null;
  }

  async sendText(userId: string, text: string): Promise<void> {
    // Previews off, for the same reason TelegramAdapter turns them off: WhatsApp FETCHES a
    // link to build the card, and /s/<code> links are single-use — the crawl spends the
    // person's one use and they tap into "este enlace ya se usó". The HEAD handler on
    // WebLinkController does not help: preview crawlers GET, they need the HTML.
    await this.send(userId, { type: 'text', text: { body: text, preview_url: false } });
  }

  async sendDocument(userId: string, file: Buffer, filename: string): Promise<void> {
    const mediaId = await this.uploadMedia(file, filename, 'application/pdf');
    if (!mediaId) return;
    await this.send(userId, { type: 'document', document: { id: mediaId, filename } });
  }

  async sendAnimation(userId: string, filePath: string): Promise<void> {
    try {
      const buffer = await readFile(filePath);
      const mediaId = await this.uploadMedia(buffer, 'video.mp4', 'video/mp4');
      if (!mediaId) return;
      await this.send(userId, { type: 'video', video: { id: mediaId } });
    } catch (err) {
      this.logger.warn(`sendAnimation failed: ${err}`);
    }
  }

  // No request_contact equivalent: plain text, since the channel already proves the phone.
  async sendContactRequest(userId: string, text: string): Promise<void> {
    await this.sendText(userId, text);
  }

  // Meta does support reactions, but they address a prior message by its `wamid.*` string
  // and IChannelAdapter types messageId as a number for Telegram. A no-op beats sending a
  // reaction to the wrong message.
  async reactToMessage(_userId: string, _messageId: number, _emoji: string, _isBig?: boolean): Promise<void> {
    return;
  }

  async sendChoices(userId: string, text: string, choices: string[]): Promise<void> {
    // Every limit here is Meta's, and exceeding one returns a 400 that would leave the
    // person with no message at all — so a list that does not fit degrades to plain text,
    // where the category keywords still match if they retype one.
    const fits =
      choices.length > 0 &&
      choices.length <= LIST_MAX_ROWS &&
      text.length <= LIST_BODY_MAX &&
      choices.every((c) => c.length <= LIST_ROW_TITLE_MAX);

    if (!fits) {
      await this.sendText(userId, `${text}\n\n${choices.join('\n')}`);
      return;
    }

    await this.send(userId, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text },
        action: {
          button: 'Ver opciones',
          sections: [{ rows: choices.map((c, i) => ({ id: `choice_${i}`, title: c })) }],
        },
      },
    });
  }

  // The callback URL lives in the Meta App Dashboard (WhatsApp > Configuration), not in an
  // API call — there is no setWebhook equivalent for a business phone number.
  async setWebhook(): Promise<void> {
    this.logger.log('Meta WhatsApp webhook is configured in the Meta App Dashboard, not via this app — see .env.example');
  }
}
