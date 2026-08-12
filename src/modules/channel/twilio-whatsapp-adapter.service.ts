// twilio-whatsapp-adapter.service.ts: the WhatsApp (Twilio) implementation of
// IChannelAdapter. Talks to the Messages REST API directly via fetch + Basic Auth — no
// Twilio SDK dependency, same lean-fetch convention this codebase already uses for Wompi
// and Groq. Field names verified against Twilio's own webhook-request docs (2026-08-12).
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { IChannelAdapter, NormalizedMessage } from './types';
import { DocumentCacheService } from './document-cache.service';

// Twilio's raw webhook body — application/x-www-form-urlencoded, parsed by Nest's default
// body parser into a plain object of strings. Only the fields this adapter reads.
interface TwilioIncomingMessage {
  MessageSid?: string;
  From?: string; // "whatsapp:+15551234567"
  To?: string;
  Body?: string;
  ProfileName?: string; // WhatsApp display name — best-effort, not a stable handle
  WaId?: string; // sender's WhatsApp id, no "whatsapp:" prefix — the stable userId
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
}

@Injectable()
export class TwilioWhatsAppAdapter implements IChannelAdapter {
  private readonly logger = new Logger(TwilioWhatsAppAdapter.name);
  private enabled = false;
  private accountSid = '';
  private authToken = '';
  private fromNumber = '';
  private publicUrl = '';

  constructor(
    private readonly config: ConfigService,
    private readonly docs: DocumentCacheService,
  ) {
    this.accountSid = config.get<string>('TWILIO_ACCOUNT_SID') ?? '';
    this.authToken = config.get<string>('TWILIO_AUTH_TOKEN') ?? '';
    this.fromNumber = config.get<string>('TWILIO_WHATSAPP_NUMBER') ?? '';
    this.publicUrl = config.get<string>('PUBLIC_URL') ?? '';
    this.enabled = !!(this.accountSid && this.authToken && this.fromNumber);
    if (!this.enabled) {
      this.logger.warn('TWILIO_* not fully set — WhatsApp disabled');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private stripPrefix(waNumber: string): string {
    return waNumber.replace(/^whatsapp:/, '');
  }

  async normalize(raw: unknown): Promise<NormalizedMessage> {
    const body = raw as TwilioIncomingMessage;
    const userId = body.WaId ?? this.stripPrefix(body.From ?? '');
    const text = body.Body ?? '';
    const numMedia = parseInt(body.NumMedia ?? '0', 10);

    let unsupportedInput: NormalizedMessage['unsupportedInput'];
    let transcribed = text;

    if (numMedia > 0 && body.MediaUrl0) {
      if ((body.MediaContentType0 ?? '').startsWith('audio/')) {
        if (!text) {
          try {
            transcribed = await this.transcribeVoice(body.MediaUrl0);
          } catch (err) {
            this.logger.error(`Voice transcription failed: ${err}`);
          }
        }
      } else {
        unsupportedInput = 'image';
      }
    }

    return {
      channelId: userId,
      channel: 'whatsapp',
      userId,
      ...(body.ProfileName && { username: body.ProfileName }),
      text: transcribed,
      timestamp: new Date(),
      metadata: { messageSid: body.MessageSid },
      ...(unsupportedInput && { unsupportedInput }),
      // WhatsApp itself verifies the sending phone number — there's no request_contact
      // equivalent here, but none is needed: every inbound message already proves the
      // phone. Populated unconditionally so AgentService's phoneVerified gate (built for
      // Telegram's opt-in contact share) is satisfied for free on this channel.
      contact: { phoneNumber: userId, firstName: body.ProfileName ?? '' },
    };
  }

  // Twilio media URLs require the same Account SID/Auth Token as the REST API to fetch —
  // unlike Telegram's file URLs, they're not publicly readable.
  private async transcribeVoice(mediaUrl: string): Promise<string> {
    const llmKey = this.config.get<string>('LLM_API_KEY');
    if (!llmKey) {
      this.logger.warn('LLM_API_KEY not set — voice transcription disabled');
      return '';
    }
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const mediaRes = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!mediaRes.ok) {
      throw new Error(`Twilio media fetch failed: ${mediaRes.status}`);
    }
    const audioBuffer = Buffer.from(await mediaRes.arrayBuffer());

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
    this.logger.log(`Voice transcribed: "${(data.text ?? '').slice(0, 80)}"`);
    return data.text ?? '';
  }

  private async send(to: string, params: Record<string, string>): Promise<void> {
    if (!this.enabled) return;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const body = new URLSearchParams({ From: this.fromNumber, To: `whatsapp:${to}`, ...params });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    if (!res.ok) {
      this.logger.error(`Twilio send failed: ${res.status} ${await res.text()}`);
    }
  }

  async sendText(userId: string, text: string): Promise<void> {
    await this.send(userId, { Body: text });
  }

  async sendDocument(userId: string, file: Buffer, filename: string): Promise<void> {
    if (!this.publicUrl) {
      this.logger.warn('PUBLIC_URL not set — cannot build a fetchable media URL for Twilio, document not sent');
      return;
    }
    const token = this.docs.put(file, filename, 'application/pdf');
    await this.send(userId, { MediaUrl: `${this.publicUrl}/downloads/${token}.pdf` });
  }

  async sendAnimation(userId: string, filePath: string): Promise<void> {
    if (!this.publicUrl) return;
    // Same URL constraint as sendDocument — read the local asset once and serve it via
    // the same ephemeral download token, never allowed to break the real flow if it fails.
    try {
      const buffer = await readFile(filePath);
      const token = this.docs.put(buffer, 'video.mp4', 'video/mp4');
      await this.send(userId, { MediaUrl: `${this.publicUrl}/downloads/${token}.mp4` });
    } catch (err) {
      this.logger.warn(`sendAnimation failed: ${err}`);
    }
  }

  // No request_contact equivalent — see the comment on normalize()'s `contact` field.
  // Sent as plain text; the channel itself already proves the phone.
  async sendContactRequest(userId: string, text: string): Promise<void> {
    await this.send(userId, { Body: text });
  }

  // WhatsApp message reactions exist on the platform but sending one isn't part of
  // Twilio's standard Messages API — purely cosmetic even on Telegram, so a safe no-op
  // here rather than an unverified implementation.
  async reactToMessage(_userId: string, _messageId: number, _emoji: string, _isBig?: boolean): Promise<void> {
    return;
  }

  // Freeform Quick Reply buttons require a pre-approved Meta Content Template — out of
  // MVP/sandbox scope. Degrades to a plain numbered-free text list: the same category
  // keywords still match via GroqNlpService.matchCategoryKeyword if the user retypes one.
  async sendChoices(userId: string, text: string, choices: string[]): Promise<void> {
    await this.send(userId, { Body: `${text}\n\n${choices.join('\n')}` });
  }

  // The Sandbox's webhook URL is set once in the Twilio console (Messaging > Try it out),
  // not programmatically per-app like Telegram's setWebhook — a real WhatsApp Sender
  // (non-sandbox) does support this via the Messaging Service API, out of MVP scope.
  async setWebhook(): Promise<void> {
    this.logger.log('Twilio WhatsApp webhook is configured in the Twilio console, not via this app — see .env.example');
  }
}
