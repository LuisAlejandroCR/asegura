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

// 10 minutes is generous for Twilio to fetch the media once (it typically does so within
// seconds of the send API call returning) while keeping the exposure window short — this
// is a public, unauthenticated URL by necessity (Twilio's servers fetch it, not the user).
const TTL_MS = 10 * 60_000;

@Injectable()
export class DocumentCacheService {
  private readonly store = new Map<string, CachedDocument>();

  put(buffer: Buffer, filename: string, contentType = 'application/pdf'): string {
    const token = randomUUID();
    this.store.set(token, { buffer, filename, contentType, expiresAt: Date.now() + TTL_MS });
    return token;
  }

  // Not deleted on first read — Twilio may retry the media fetch, and a 404 on retry
  // would silently drop the document. Expired entries are swept lazily on the next get().
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
