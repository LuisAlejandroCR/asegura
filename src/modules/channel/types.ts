// channel/types.ts: the channel abstraction — NormalizedMessage (what every channel must
// reduce an inbound message to) and the IChannelAdapter that Telegram and WhatsApp both
// implement.

interface NormalizedMessage {
  channelId: string;
  channel: 'telegram' | 'whatsapp';
  userId: string;
  // Telegram's @handle — frequently absent, so it is only ever shown to a human picking up
  // an escalated conversation, never used for matching.
  username?: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  // Media we cannot process. AgentService answers "I can't read that" instead of going silent.
  unsupportedInput?: 'image' | 'audio_too_long';
  // Set only when the contact is self-attested: Telegram's contact.user_id matches the
  // sender, guaranteed for a request_contact tap but not for a forwarded contact card.
  contact?: { phoneNumber: string; firstName: string };
  // A photo is a valid answer during the selfie step, so it is not unsupportedInput.
  // Dimensions only, to catch an icon-shaped file — never any pixel analysis.
  photo?: { width: number; height: number };
  // The channel-native id — needed to react to a SPECIFIC message rather than send a new one.
  messageId?: number;
}

interface IChannelAdapter {
  normalize(raw: unknown): Promise<NormalizedMessage>;
  sendText(userId: string, text: string): Promise<void>;
  sendDocument(userId: string, file: Buffer, filename: string): Promise<void>;
  // A short video from a local file path — heavier than a reaction, used only where asked.
  sendAnimation(userId: string, filePath: string): Promise<void>;
  sendContactRequest(userId: string, text: string): Promise<void>;
  // Emoji reaction on a prior message (Telegram's setMessageReaction) — no asset to host.
  reactToMessage(userId: string, messageId: number, emoji: string, isBig?: boolean): Promise<void>;
  // A reply-keyboard tap arrives as an ordinary text message on the same webhook, so it
  // flows through normalize → extractIntent like typed speech. Never inline_keyboard (rule #10).
  sendChoices(userId: string, text: string, choices: string[]): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
}

export { NormalizedMessage, IChannelAdapter };
