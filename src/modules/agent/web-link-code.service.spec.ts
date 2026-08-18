// web-link-code.service.spec.ts: the short /s/<code> links sent in chat — the code is the
// credential, so the tests that matter are "it works once" and "it stops working after".
import { NotFoundException } from '@nestjs/common';
import { WebLinkCodeService } from './web-link-code.service';
import { WebLinkController } from './web-link.controller';

const DESTINATION = 'https://asegura-app.vercel.app/texto.html?token=signed-token-abc';

describe('WebLinkCodeService', () => {
  it('mints a short code that does not leak any part of the destination token', () => {
    const code = new WebLinkCodeService().mint(DESTINATION);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    // Ambiguous glyphs are excluded so a code read off a screen can't be retyped into a
    // DIFFERENT valid code.
    expect(code).not.toMatch(/[01OIL]/);
    expect(DESTINATION).not.toContain(code);
  });

  it('redeems once and never again — the whole point of the short link', () => {
    const service = new WebLinkCodeService();
    const code = service.mint(DESTINATION);
    expect(service.redeem(code)).toBe(DESTINATION);
    // A forwarded screenshot of the chat is now worthless.
    expect(service.redeem(code)).toBeNull();
  });

  it('returns null for a code that was never issued', () => {
    expect(new WebLinkCodeService().redeem('ZZZZZZZZ')).toBeNull();
  });

  it('refuses an expired code even though it was never used', () => {
    jest.useFakeTimers();
    try {
      const service = new WebLinkCodeService();
      const code = service.mint(DESTINATION);
      jest.advanceTimersByTime(15 * 60 * 1000 + 1);
      expect(service.redeem(code)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives every session its own code', () => {
    const service = new WebLinkCodeService();
    expect(service.mint(DESTINATION)).not.toBe(service.mint(DESTINATION));
  });
});

describe('WebLinkController', () => {
  const makeRes = () => ({ redirect: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() }) as any;

  it('redirects to the real AseguraWeb URL', () => {
    const codes = new WebLinkCodeService();
    const res = makeRes();
    new WebLinkController(codes).redeem(codes.mint(DESTINATION), res);
    expect(res.redirect).toHaveBeenCalledWith(302, DESTINATION);
  });

  it('tells the person how to recover instead of showing a bare 404 on a spent code', () => {
    const codes = new WebLinkCodeService();
    const code = codes.mint(DESTINATION);
    const controller = new WebLinkController(codes);
    controller.redeem(code, makeRes());
    expect(() => controller.redeem(code, makeRes())).toThrow(NotFoundException);
    expect(() => controller.redeem(code, makeRes())).toThrow(/te enviamos uno nuevo/i);
  });

  // A chat client building a preview card must never spend the person's one use.
  it('answers HEAD without consuming the code', () => {
    const codes = new WebLinkCodeService();
    const code = codes.mint(DESTINATION);
    const controller = new WebLinkController(codes);
    controller.head(makeRes());
    const res = makeRes();
    controller.redeem(code, res);
    expect(res.redirect).toHaveBeenCalledWith(302, DESTINATION);
  });
});
