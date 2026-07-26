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
  // A plain photo message — set instead of unsupportedInput because a cosmetic
  // selfie-KYC step (2026-07-24, simulated identity confirmation — see
  // AgentService's awaitingSelfie step) needs to receive a photo as a valid answer.
  // AgentService decides what it means based on conversation state. Carries the
  // dimensions of the largest Telegram-provided size so a suspiciously tiny image (an
  // icon/sticker-shaped file, not an actual camera photo) can be sanity-checked without
  // any real face detection — width/height only, never analyzing pixel content.
  photo?: { width: number; height: number };
  // The channel-native message id — needed to react to a SPECIFIC message (e.g. the
  // selfie photo itself) rather than just sending a new one.
  messageId?: number;
}

interface IChannelAdapter {
  normalize(raw: unknown): Promise<NormalizedMessage>;
  sendText(userId: string, text: string): Promise<void>;
  sendDocument(userId: string, file: Buffer, filename: string): Promise<void>;
  // Sends a short video/animation from a local file path (e.g. the branded
  // success-checkmark clip) — heavier than a reaction, used only for the moments that
  // explicitly ask for it.
  sendAnimation(userId: string, filePath: string): Promise<void>;
  sendContactRequest(userId: string, text: string): Promise<void>;
  // Reacts to a specific prior message with an emoji (Telegram's setMessageReaction) — a
  // lightweight, asset-free "animated" success touch (the reaction itself renders with a
  // small built-in animation) that doesn't require hosting a GIF/sticker.
  reactToMessage(userId: string, messageId: number, emoji: string, isBig?: boolean): Promise<void>;
  // 2026-07-26 hybrid buttons (Step 4) — a shortcut over the NLP path, never a
  // replacement: a reply-keyboard tap arrives as an ordinary text message on the same
  // webhook, so it flows through normalize → extractIntent → handleDiscovery exactly
  // like typed or transcribed speech. Never Telegram's inline_keyboard (rule #10 — no
  // IVR-style menu trees); free text/voice remain fully first-class alongside this.
  sendChoices(userId: string, text: string, choices: string[]): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
}

export { NormalizedMessage, IChannelAdapter };