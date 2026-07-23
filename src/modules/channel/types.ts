interface NormalizedMessage {
  channelId: string;
  channel: 'telegram' | 'whatsapp';
  userId: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

interface IChannelAdapter {
  normalize(raw: unknown): NormalizedMessage;
  sendText(userId: string, text: string): Promise<void>;
  sendDocument(userId: string, file: Buffer, filename: string): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
}

export { NormalizedMessage, IChannelAdapter };