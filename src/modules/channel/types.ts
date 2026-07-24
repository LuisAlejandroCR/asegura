interface NormalizedMessage {
  channelId: string;
  channel: 'telegram' | 'whatsapp';
  userId: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  // Set instead of attempting to process the message when it's media we can't handle —
  // images/documents/stickers (no text extraction possible) or a voice note long enough
  // that transcribing it isn't worth the API call. AgentService responds with a plain
  // "I can't read that, try again" instead of silently doing nothing.
  unsupportedInput?: 'image' | 'audio_too_long';
  // Set only when the shared contact is self-attested — Telegram's contact.user_id
  // matches the sender's own id, which is guaranteed for a native request_contact button
  // tap (2026-07-24 KYC feedback) but not for a manually forwarded contact card, so a
  // mismatch (or a non-Telegram contact with no user_id) leaves this unset rather than
  // being treated as identity verification.
  contact?: { phoneNumber: string; firstName: string };
}

interface IChannelAdapter {
  normalize(raw: unknown): Promise<NormalizedMessage>;
  sendText(userId: string, text: string): Promise<void>;
  sendDocument(userId: string, file: Buffer, filename: string): Promise<void>;
  sendContactRequest(userId: string, text: string): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
}

export { NormalizedMessage, IChannelAdapter };