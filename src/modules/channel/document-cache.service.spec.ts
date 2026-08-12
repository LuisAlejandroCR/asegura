// document-cache.service.spec.ts: the buffer→URL registry TwilioWhatsAppAdapter needs
// since Twilio's Messages API takes a fetchable URL, never a raw upload.

import { DocumentCacheService } from './document-cache.service';

describe('DocumentCacheService', () => {
  it('returns the same buffer/filename/contentType for a token it issued', () => {
    const docs = new DocumentCacheService();
    const buffer = Buffer.from('hello');
    const token = docs.put(buffer, 'poliza.pdf', 'application/pdf');
    const entry = docs.get(token);
    expect(entry?.buffer).toBe(buffer);
    expect(entry?.filename).toBe('poliza.pdf');
    expect(entry?.contentType).toBe('application/pdf');
  });

  it('returns null for an unknown token', () => {
    const docs = new DocumentCacheService();
    expect(docs.get('does-not-exist')).toBeNull();
  });

  // Not deleted on first read — Twilio may retry the media fetch before the TTL expires.
  it('a token can be read more than once before it expires', () => {
    const docs = new DocumentCacheService();
    const token = docs.put(Buffer.from('x'), 'f.pdf');
    docs.get(token);
    expect(docs.get(token)).not.toBeNull();
  });

  it('an expired entry returns null', () => {
    const realNow = Date.now;
    Date.now = () => 0;
    const docs = new DocumentCacheService();
    const token = docs.put(Buffer.from('x'), 'f.pdf');
    Date.now = () => 11 * 60_000; // past the 10-minute TTL
    expect(docs.get(token)).toBeNull();
    Date.now = realNow;
  });
});
