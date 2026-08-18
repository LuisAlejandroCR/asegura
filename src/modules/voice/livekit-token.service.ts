// livekit-token.service.ts: issues short-lived LiveKit room-join tokens for AseguraWeb's
// browser voice client, with the dispatch that summons the named voice worker into the room.
import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomAgentDispatch, RoomConfiguration, VideoGrant } from 'livekit-server-sdk';

// Must match ServerOptions.agentName in src/voice-agent/main.ts. Naming a worker turns OFF
// automatic dispatch — it joins only rooms it was explicitly sent to.
const VOICE_AGENT_NAME = 'asegura-voice';

export interface VoiceSession {
  url: string;
  token: string;
  roomName: string;
}

// Long enough for a real conversation, short enough that a leaked token expires fast.
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

  // One room per session; identity falls back to a random id when no chat session is linked.
  async createSession(identity: string = randomUUID()): Promise<VoiceSession | null> {
    if (!this.enabled) return null;

    const roomName = `asegura-${randomUUID()}`;
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      ttl: TOKEN_TTL_SECONDS,
    });
    const grant: VideoGrant = { room: roomName, roomJoin: true, canPublish: true, canSubscribe: true };
    at.addGrant(grant);
    // Safe because createSession always mints a NEW room: a token's dispatch config is
    // ignored for a room that already exists.
    at.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: VOICE_AGENT_NAME })],
    });

    return { url: this.url, token: await at.toJwt(), roomName };
  }
}
