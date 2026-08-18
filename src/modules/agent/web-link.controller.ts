// web-link.controller.ts: redeems the short /s/<code> links sent in chat. Unauthenticated
// on purpose — the random code is the credential, same trust model as DownloadsController.
import { Controller, Get, Head, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { WebLinkCodeService } from './web-link-code.service';

// Same palette as texto.html/voz.html. Inlined because the backend renders this, and it
// must still work when the static site is unreachable.
const EXPIRED_PAGE = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enlace vencido · Asegura</title>
<style>
  :root{--amarillo:#ffd000;--azul:#0067b1;--gris:#575756;--fondo:#fafafa;--blanco:#fff;
        --sombra:0 6px 26px rgba(0,40,70,.10),0 1px 3px rgba(0,40,70,.06)}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       padding:24px;background:var(--fondo);color:var(--gris);
       font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .carta{background:var(--blanco);border-radius:18px;box-shadow:var(--sombra);
         padding:36px 28px;max-width:420px;width:100%;text-align:center}
  .marca{font-weight:800;font-size:15px;letter-spacing:.14em;text-transform:uppercase;
         color:var(--azul);margin-bottom:22px}
  .sello{width:74px;height:74px;margin:0 auto 20px;border-radius:50%;
         background:var(--amarillo);display:flex;align-items:center;justify-content:center;
         font-size:34px;line-height:1}
  h1{margin:0 0 12px;font-size:21px;color:#000}
  p{margin:0 0 8px;font-size:16px;line-height:1.55}
  .nota{margin-top:20px;font-size:14px;color:#8a8a89}
  @media (prefers-color-scheme:dark){
    body{background:#14171a;color:#d8dade}
    .carta{background:#1d2126}
    h1{color:#fff}
    .nota{color:#9aa0a6}
  }
</style></head>
<body>
  <main class="carta">
    <div class="marca">Asegura</div>
    <div class="sello" role="img" aria-label="Enlace vencido">🔒</div>
    <h1>Este enlace ya se usó</h1>
    <p>Por tu seguridad cada enlace sirve una sola vez y dura 15 minutos.</p>
    <p><strong>Vuelve al chat y pídeme uno nuevo</strong> — te lo mando al instante.</p>
    <p class="nota">Tu conversación sigue guardada. No perdiste nada.</p>
  </main>
</body></html>`;

@Controller('s')
export class WebLinkController {
  constructor(private readonly codes: WebLinkCodeService) {}

  // Chat clients fetch links to build previews; a preview must never spend the one use.
  @Head(':code')
  head(@Res() res: Response): void {
    res.status(204).send();
  }

  @Get(':code')
  redeem(@Param('code') code: string, @Res() res: Response): void {
    const url = this.codes.redeem(code);
    // Nest's default 404 is JSON, which reads as a crash to someone who just tapped a link.
    // This is a real screen mid-sale, so it gets the product's face. 404 kept for crawlers.
    if (!url) {
      res.status(404).type('html').send(EXPIRED_PAGE);
      return;
    }
    res.redirect(302, url);
  }
}
