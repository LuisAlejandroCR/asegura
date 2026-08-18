// web-link-code.service.ts: trades a long signed AseguraWeb URL for a short, single-use
// code, so the chat message never carries the session token in plain sight. Same trust
// model and in-memory storage as DocumentCacheService: the random code IS the credential,
// so it is burned on redemption and expires quickly.
//
// In-memory on purpose (no Supabase table): a code only has to survive the seconds between
// the agent sending the link and the person tapping it. The trade-off is real and worth
// stating — a backend restart invalidates outstanding codes, and the person then has to ask
// for the link again, which costs one message.
import { randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';

interface CodeEntry {
  url: string;
  expiresAt: number;
}

// Long enough to walk from the chat to the browser, short enough that a forwarded
// screenshot is worthless well before anyone acts on it.
const CODE_TTL_MS = 15 * 60 * 1000;

// Crockford-style alphabet: no 0/O/1/I/L, so a code read aloud or retyped from a screen
// can't be mistyped into a different valid code.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

@Injectable()
export class WebLinkCodeService {
  private readonly logger = new Logger(WebLinkCodeService.name);
  private readonly store = new Map<string, CodeEntry>();

  // Returns the short code for `url`. Caller builds the public /s/<code> link — this
  // service never knows the backend's own hostname.
  mint(url: string): string {
    this.sweep();
    let code = this.generate();
    while (this.store.has(code)) code = this.generate();
    this.store.set(code, { url, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  // Single use: the entry is removed before the URL is handed back, so a second request
  // with the same code gets nothing even if it arrives microseconds later.
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

  // Codes are only ever removed on redemption, so without this an abandoned link would
  // sit in memory for the life of the process.
  private sweep(): void {
    const now = Date.now();
    for (const [code, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(code);
    }
  }
}
