// downloads.controller.ts: serves the ephemeral buffers DocumentCacheService holds — how
// an AseguraWeb session reaches a PDF this app generates in memory, since a browser cannot
// receive a chat attachment. Unauthenticated: the random token is the credential.
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
