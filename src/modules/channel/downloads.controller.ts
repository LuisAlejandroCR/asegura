// downloads.controller.ts: serves the ephemeral buffers DocumentCacheService holds —
// the only way Twilio's WhatsApp API can fetch a document/animation this app generates
// in memory (its Messages API takes a URL, never a raw upload, unlike Telegram's
// sendDocument). Deliberately unauthenticated: Twilio's servers fetch it directly, and
// the random token is the only credential — same trust model as the PDF's own
// verification QR code (rule: never invented, never a second source of truth).
import { Controller, Get, Param, NotFoundException, Res } from '@nestjs/common';
import { Response } from 'express';
import { DocumentCacheService } from './document-cache.service';

@Controller('downloads')
export class DownloadsController {
  constructor(private readonly docs: DocumentCacheService) {}

  @Get(':tokenWithExt')
  get(@Param('tokenWithExt') tokenWithExt: string, @Res() res: Response): void {
    const token = tokenWithExt.replace(/\.[^.]+$/, '');
    const entry = this.docs.get(token);
    if (!entry) throw new NotFoundException();
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${entry.filename}"`);
    res.send(entry.buffer);
  }
}
