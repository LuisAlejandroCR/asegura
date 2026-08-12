// livekit-token.service.ts: issues short-lived LiveKit room-join tokens for AseguraWeb's
// browser voice client. Deliberately scoped to just the LiveKit auth handshake — linking
// a room to an existing Telegram/WhatsApp conversation's context (plan 17 Fase 1: signed
// link from chat, GET /web-session/:token) is separate, still-open work, not built here.
import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, VideoGrant } from 'livekit-server-sdk';

export interface VoiceSession {
  url: string;
  token: string;
  roomName: string;
}

// Long enough for a real conversation, short enough that a leaked token (e.g. via
// browser history) isn't useful for long — same reasoning as Wompi's
// PAYMENT_LINK_EXPIRY_MINUTES.
const TOKEN_TTL_SECONDS = 30 * 60;

@Injectable()
export class LiveKitTokenService {
  private readonly logger = new Logger(LiveKitTokenService.name);
  private readonly url: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.url = config.get<string>('LIVEKIT_URL') ?? '';
    this.apiKey = config.get<string>('LIVEKIT_API_KEY') ?? '';
    this.apiSecret = config.get<string>('LIVEKIT_API_SECRET') ?? '';
    this.enabled = !!(this.url && this.apiKey && this.apiSecret);
    if (!this.enabled) {
      this.logger.warn('LIVEKIT_* not fully set — voice sessions disabled');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // `identity` defaults to a fresh random id — the browser has no prior identity to
  // reuse here (no signed link from chat yet, see the file header). One room per
  // session: no reason for two AseguraWeb tabs to ever share a room.
  async createSession(identity: string = randomUUID()): Promise<VoiceSession | null> {
    if (!this.enabled) return null;

    const roomName = `asegura-${randomUUID()}`;
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      ttl: TOKEN_TTL_SECONDS,
    });
    const grant: VideoGrant = { room: roomName, roomJoin: true, canPublish: true, canSubscribe: true };
    at.addGrant(grant);

    return { url: this.url, token: await at.toJwt(), roomName };
  }
}
