// telegram-adapter.service.ts: the Telegram implementation of IChannelAdapter —
// normalizes inbound updates into NormalizedMessage, transcribes voice notes, and
// sends text, reply keyboards, reactions, animations and documents back.

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, InputFile, Keyboard, webhookCallback } from 'grammy';
import { createReadStream } from 'fs';
import { IChannelAdapter, NormalizedMessage } from './types';

@Injectable()
export class TelegramAdapter implements IChannelAdapter, OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramAdapter.name);
  private bot: Bot | null = null;
  private enabled = false;

  constructor(private readonly config: ConfigService) {
    const token = config.get<string>('TELEGRAM_BOT_TOKEN');
    if (token) {
      this.bot = new Bot(token);
      this.enabled = true;
    } else {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram disabled');
    }
  }

  onApplicationBootstrap() {
    if (this.enabled && this.bot && this.config.get<string>('TELEGRAM_WEBHOOK_SECRET')) {
      const host = this.config.get<string>('PUBLIC_URL', '');
      // The webhook itself is registered in main.ts; this only reports readiness.
      if (host) this.logger.log('Telegram ready');
    }
  }

  get instance(): Bot | null {
    return this.bot;
  }

  // grammy throws when botInfo is read before init(), and a page asking where the chat lives
  // is not a reason to fail a request.
  get botUsername(): string | undefined {
    try {
      return this.bot?.botInfo?.username;
    } catch {
      return undefined;
    }
  }

  // Longer voice notes aren't worth a Whisper call — a quick insurance answer never is.
  private static readonly MAX_VOICE_DURATION_SECONDS = 60;

  async normalize(raw: unknown): Promise<NormalizedMessage> {
    const ctx = raw as Context;
    const msg = ctx.message ?? ctx.editedMessage;

    let text = msg?.text ?? '';
    let unsupportedInput: NormalizedMessage['unsupportedInput'];

    // Only self-shared contacts count as verification: Telegram guarantees contact.user_id
    // equals the sender for a request_contact tap, but not for a forwarded contact card.
    const senderId = msg?.from?.id ?? ctx.from?.id;
    const contact = (msg?.contact && msg.contact.user_id === senderId)
      ? { phoneNumber: msg.contact.phone_number, firstName: msg.contact.first_name }
      : undefined;

    // Telegram sends several resolutions; the LARGEST reflects the photo actually sent, which
    // is what the tiny-image sanity check needs.
    const photo = msg?.photo?.length
      ? msg.photo.reduce((max, p) => (p.width > max.width ? { width: p.width, height: p.height } : max), { width: msg.photo[0].width, height: msg.photo[0].height })
      : undefined;

    if (msg?.document || msg?.sticker || msg?.video || msg?.video_note) {
      unsupportedInput = 'image';
    } else if (msg?.voice) {
      if (msg.voice.duration > TelegramAdapter.MAX_VOICE_DURATION_SECONDS) {
        unsupportedInput = 'audio_too_long';
      } else if (!text) {
        try {
          text = await this.transcribeVoice(msg.voice.file_id);
        } catch (err) {
          this.logger.error(`Voice transcription failed: ${err}`);
        }
      }
    }

    const username = msg?.from?.username ?? ctx.from?.username;

    return {
      channelId: String(msg?.chat.id ?? ctx.chat?.id),
      channel: 'telegram',
      userId: String(msg?.from?.id ?? ctx.from?.id),
      ...(username && { username }),
      text,
      timestamp: msg?.date ? new Date(msg.date * 1000) : new Date(),
      metadata: { updateId: ctx.update.update_id },
      ...(unsupportedInput && { unsupportedInput }),
      ...(contact && { contact }),
      ...(photo && { photo }),
      ...(msg?.message_id !== undefined && { messageId: msg.message_id }),
    };
  }

  private async transcribeVoice(fileId: string): Promise<string> {
    if (!this.bot) return '';
    const llmKey = this.config.get<string>('LLM_API_KEY');
    if (!llmKey) {
      // This used to return '' with no log — indistinguishable from a silent voice note, so a
      // missing env var disabled voice invisibly.
      this.logger.warn('LLM_API_KEY not set — voice transcription disabled');
      return '';
    }
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';

    const fileInfo = await this.bot.api.getFile(fileId);
    if (!fileInfo.file_path) return '';

    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const fileRes = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await fileRes.arrayBuffer());

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
      // A non-2xx with a valid JSON body would otherwise fall through to `data.text ?? ''`,
      // indistinguishable from "the user said nothing".
      throw new Error(`Groq transcription failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { text?: string };
    this.logger.log(`Voice transcribed (${(data.text ?? '').length} chars)`);
    return data.text ?? '';
  }

  // Pacing only: an instant text dump reads as an IVR menu, not a conversation.
  private static readonly TYPING_DELAY_MS = 600;

  async sendText(userId: string, text: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendChatAction(Number(userId), 'typing').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, TelegramAdapter.TYPING_DELAY_MS));
    // Previews disabled: Telegram FETCHES every link it previews, and /s/<code> links are
    // single-use — a preview crawl would spend the person's one use before they tapped.
    await this.bot.api.sendMessage(Number(userId), text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  }

  // Telegram's native request_contact keyboard — one tap shares the tapping user's own
  // verified number. An identity capability, not a conversational menu (rule #10).
  async sendContactRequest(userId: string, text: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendChatAction(Number(userId), 'typing').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, TelegramAdapter.TYPING_DELAY_MS));
    const keyboard = new Keyboard().requestContact('📱 Compartir mi contacto').resized().oneTime();
    await this.bot.api.sendMessage(Number(userId), text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  // Reply keyboard ONLY, never InlineKeyboard: a tap arrives back as a normal text message on
  // the same webhook, so it is a shortcut over the NLP path, not a callback_query flow.
  async sendChoices(userId: string, text: string, choices: string[]): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendChatAction(Number(userId), 'typing').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, TelegramAdapter.TYPING_DELAY_MS));
    const keyboard = choices
      .reduce((kb, choice, i) => (i > 0 && i % 2 === 0 ? kb.row().text(choice) : kb.text(choice)), new Keyboard())
      .resized()
      .oneTime();
    await this.bot.api.sendMessage(Number(userId), text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  // Telegram reactions animate with no hosted asset, unlike sendAnimation. Purely cosmetic,
  // so it is never allowed to break the real message flow.
  async reactToMessage(userId: string, messageId: number, emoji: string, isBig?: boolean): Promise<void> {
    if (!this.bot) return;
    // grammy types `emoji` as a closed union of Telegram's allowed reactions; the cast keeps
    // IChannelAdapter channel-agnostic. isBig maps to Telegram's is_big flag. Reported three
    // times as "never shows" — a silent .catch() made it undebuggable, so failures are logged.
    await this.bot.api.setMessageReaction(Number(userId), messageId, [{ type: 'emoji', emoji } as any], { is_big: isBig })
      .catch((err) => this.logger.warn(`reactToMessage failed: ${err}`));
  }

  // A branded success clip — heavier than a reaction, and never allowed to break the flow.
  async sendAnimation(userId: string, filePath: string): Promise<void> {
    if (!this.bot) return;
    // A missing or unreadable asset emits 'error' on the stream itself; with no listener
    // that crashes the whole process, not just this cosmetic send.
    const stream = createReadStream(filePath);
    stream.on('error', () => undefined);
    await this.bot.api.sendAnimation(Number(userId), new InputFile(stream)).catch(() => undefined);
  }

  async sendDocument(userId: string, file: Buffer, filename: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendDocument(Number(userId), new InputFile(file, filename));
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.setWebhook(url, { secret_token: secret });
    this.logger.log(`Webhook set to ${url}`);
  }

  // grammy corta a los 10 s y por defecto RECHAZA la promesa: una nota de voz —Whisper, modelo
  // y PDF— se pasa de ahí, y ese rechazo mataba el proceso. Contestar y seguir procesando es lo
  // que Telegram espera; el margen es el suyo, no el nuestro.
  webhookCallback(): (req: any, res: any, next?: any) => any {
    return this.bot
      ? webhookCallback(this.bot, 'express', { onTimeout: 'return', timeoutMilliseconds: 55_000 })
      : (_req: any, _res: any) => {};
  }
}
