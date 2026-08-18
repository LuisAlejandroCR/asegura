// document-cache.service.ts: short-lived buffer→URL registry so a channel that needs a
// fetchable URL to send a document (Twilio's WhatsApp API — unlike Telegram's sendDocument,
// which accepts a raw multipart upload) can turn an in-memory PDF Buffer into one.
import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';

interface CachedDocument {
  buffer: Buffer;
  filename: string;
  contentType: string;
  expiresAt: number;
}

// A public, unauthenticated URL by necessity (Twilio's servers fetch it): keep it short-lived.
const TTL_MS = 10 * 60_000;

@Injectable()
export class DocumentCacheService {
  private readonly store = new Map<string, CachedDocument>();

  put(buffer: Buffer, filename: string, contentType = 'application/pdf'): string {
    const token = randomUUID();
    this.store.set(token, { buffer, filename, contentType, expiresAt: Date.now() + TTL_MS });
    return token;
  }

  // Not deleted on first read — Twilio may retry the fetch, and a 404 would drop the document.
  get(token: string): CachedDocument | null {
    const entry = this.store.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(token);
      return null;
    }
    return entry;
  }
}
