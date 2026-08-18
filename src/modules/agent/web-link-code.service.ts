// web-link-code.service.ts: trades a long signed AseguraWeb URL for a short single-use
// code, so the chat message never carries the session token in plain sight. The code IS
// the credential: burned on redemption, short TTL, in memory (a restart costs one message).
import { randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';

interface CodeEntry {
  url: string;
  expiresAt: number;
}

const CODE_TTL_MS = 15 * 60 * 1000;

// Crockford-style alphabet: no 0/O/1/I/L, so a code retyped from a screen can't become
// a different valid one.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
// 30^6 = 729M combinations, and a code is single-use with a 15-minute life — guessing one
// is not a realistic attack. Going shorter trades real margin for characters nobody reads.
const CODE_LENGTH = 6;

@Injectable()
export class WebLinkCodeService {
  private readonly logger = new Logger(WebLinkCodeService.name);
  private readonly store = new Map<string, CodeEntry>();

  // The caller builds the public /s/<code> link — this service never knows the host.
  mint(url: string): string {
    this.sweep();
    let code = this.generate();
    while (this.store.has(code)) code = this.generate();
    this.store.set(code, { url, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  // Single use: the entry is removed before the URL is handed back.
  redeem(code: string): string | null {
    const entry = this.store.get(code);
    if (!entry) return null;
    this.store.delete(code);
    if (entry.expiresAt <= Date.now()) {
      this.logger.warn(`Web link code expired before use (issued >${CODE_TTL_MS / 60000}min ago)`);
      return null;
    }
    return entry.url;
  }

  private generate(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  // Codes are only removed on redemption, so an abandoned link needs sweeping.
  private sweep(): void {
    const now = Date.now();
    for (const [code, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(code);
    }
  }
}
