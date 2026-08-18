// twilio-whatsapp-adapter.service.ts: the WhatsApp (Twilio) implementation of
// IChannelAdapter. Talks to the Messages REST API with fetch + Basic Auth, no SDK — the
// same lean-fetch convention this codebase uses for Wompi and Groq.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { IChannelAdapter, NormalizedMessage } from './types';
import { DocumentCacheService } from './document-cache.service';

// Twilio's form-encoded webhook body, parsed by Nest — only the fields this adapter reads.
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
      // WhatsApp verifies the sending number itself, so every inbound message already proves
      // the phone. Populated unconditionally to satisfy AgentService's phoneVerified gate.
      contact: { phoneNumber: userId, firstName: body.ProfileName ?? '' },
    };
  }

  // Twilio media URLs need the same credentials as the REST API; they are not public.
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
    // Same URL constraint as sendDocument — the local asset is served via a download token.
    try {
      const buffer = await readFile(filePath);
      const token = this.docs.put(buffer, 'video.mp4', 'video/mp4');
      await this.send(userId, { MediaUrl: `${this.publicUrl}/downloads/${token}.mp4` });
    } catch (err) {
      this.logger.warn(`sendAnimation failed: ${err}`);
    }
  }

  // No request_contact equivalent: plain text, since the channel already proves the phone.
  async sendContactRequest(userId: string, text: string): Promise<void> {
    await this.send(userId, { Body: text });
  }

  // Reactions are not part of Twilio's Messages API — a safe no-op beats an unverified guess.
  async reactToMessage(_userId: string, _messageId: number, _emoji: string, _isBig?: boolean): Promise<void> {
    return;
  }

  // Quick Reply buttons need a pre-approved Meta template, out of sandbox scope. Degrades to
  // a plain list — the category keywords still match if the person retypes one.
  async sendChoices(userId: string, text: string, choices: string[]): Promise<void> {
    await this.send(userId, { Body: `${text}\n\n${choices.join('\n')}` });
  }

  // The Sandbox's webhook URL is set once in the Twilio console, not programmatically.
  async setWebhook(): Promise<void> {
    this.logger.log('Twilio WhatsApp webhook is configured in the Twilio console, not via this app — see .env.example');
  }
}
