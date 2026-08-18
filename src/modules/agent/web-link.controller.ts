// web-link.controller.ts: redeems the short /s/<code> links the agent sends in chat and
// redirects to the real AseguraWeb URL. Deliberately unauthenticated — the random code is
// the credential, same trust model as DownloadsController.
import { Controller, Get, Head, Param, NotFoundException, Res } from '@nestjs/common';
import { Response } from 'express';
import { WebLinkCodeService } from './web-link-code.service';

@Controller('s')
export class WebLinkController {
  constructor(private readonly codes: WebLinkCodeService) {}

  // Chat clients fetch links to build preview cards. A preview fetch must never spend the
  // person's one use — Telegram messages are sent with previews disabled for this reason,
  // and HEAD is answered without touching the store as a second line of defence.
  @Head(':code')
  head(@Res() res: Response): void {
    res.status(204).send();
  }

  @Get(':code')
  redeem(@Param('code') code: string, @Res() res: Response): void {
    const url = this.codes.redeem(code);
    // A used or expired code is a dead end by design. The person is still in the chat, so
    // recovery costs one message — say that instead of showing a bare 404.
    if (!url) throw new NotFoundException('Este enlace ya se usó o expiró. Escríbele a Asegura y te enviamos uno nuevo.');
    res.redirect(302, url);
  }
}
