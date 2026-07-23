// pdf.service.ts: generates a branded policy PDF using pdfkit + a Celo audit QR
import { Injectable, Logger } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import * as path from 'path';

interface PolicyPdfData {
  policyId: string;
  productName: string;
  insurer: string;
  coverages: string[];
  nombre: string;
  cedula: string;
  email?: string;
  monthlyPremium: number;
  issuedAt: Date;
  // Real Celoscan tx URL, known only after payment + on-chain registration.
  // Before that, the QR falls back to the deterministic referenceURI.
  celoscanUrl?: string;
  // Number of pets covered — mascotas products are priced per pet (monthlyPremium is
  // the per-unit price); when set and > 1, the premium box shows the multiplied total.
  petCount?: number | null;
  // Per-pet identity (name, age, breed) — shown as a table when present, matching how
  // real pet-insurance certificates name each covered animal individually.
  pets?: { name: string; age: string; breed: string }[];
}

// Colsubsidio brand palette (Pantone 109 C / 2196 C / Cool Gray 11 C)
const BRAND = {
  yellow: '#ffd000',
  blue: '#0067b1',
  gray: '#575756',
  lightGray: '#f2f2f2',
  black: '#000000',
  white: '#ffffff',
};

// Static brand assets — referenced relative to the project root (not __dirname) because
// nest-cli.json doesn't copy non-.ts assets into dist/, and the server runs `node dist/main`
// from the project root, so `src/images/` is reachable at runtime via process.cwd().
const IMAGES_DIR = path.join(process.cwd(), 'src', 'images');
const LOGO_WHITE = path.join(IMAGES_DIR, 'Logov2.png'); // white wordmark, for the blue header
const LOGO_YELLOW = path.join(IMAGES_DIR, 'LogoV1.png'); // yellow wordmark, for the white footer

// LogoV1.png is a 1200x1200 canvas with the visible wordmark occupying only a thin
// horizontal band — measured once via a raw PNG alpha-channel scan (colorType 6, 8-bit RGBA).
const LOGO_YELLOW_CANVAS = { w: 1200, h: 1200 };
const LOGO_YELLOW_CROP = { x: 29, y: 486, w: 1141, h: 217 };

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  async generate(data: PolicyPdfData): Promise<Buffer> {
    const auditUrl = this.resolveAuditUrl(data.policyId, data.celoscanUrl);
    const qrBuffer = await this.generateQr(auditUrl);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.writeContent(doc, data, auditUrl, qrBuffer);
      doc.end();
    });
  }

  // The real Celo tx isn't known until after payment, but the PDF is generated before
  // that. referenceURI is the SAME deterministic URI later registered on-chain
  // (see agent.service.ts handlePayment), so it's a stable audit anchor either way.
  private resolveAuditUrl(policyId: string, celoscanUrl?: string): string {
    return celoscanUrl || `https://asegura.co/poliza/${policyId}`;
  }

  private async generateQr(url: string): Promise<Buffer | null> {
    try {
      return await QRCode.toBuffer(url, { type: 'png', width: 240, margin: 1 });
    } catch (err) {
      this.logger.warn(`QR generation failed, PDF will omit it: ${String(err)}`);
      return null;
    }
  }

  private writeContent(
    doc: InstanceType<typeof PDFDocument>,
    data: PolicyPdfData,
    auditUrl: string,
    qrBuffer: Buffer | null,
  ): void {
    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - 100;

    this.drawHeader(doc, pageWidth);
    this.drawTitle(doc, data);
    this.drawInfoColumns(doc, data, contentWidth);
    this.drawPetsTable(doc, data, contentWidth);
    this.drawCoverages(doc, data, contentWidth);
    this.drawAuditBox(doc, contentWidth, auditUrl, qrBuffer);
    this.drawFooter(doc, contentWidth);
  }

  // ── Header banner ────────────────────────────────────────────────────────────

  private drawHeader(doc: InstanceType<typeof PDFDocument>, pageWidth: number): void {
    const bannerHeight = 100;
    doc.rect(0, 0, pageWidth, bannerHeight).fill(BRAND.blue);

    try {
      // Logov2.png is already tightly cropped (776x148 visible content) — fits directly.
      doc.image(LOGO_WHITE, 50, 32, { width: 150 });
    } catch (err) {
      this.logger.warn(`Header logo failed to load: ${String(err)}`);
    }

    doc.fillColor(BRAND.white)
      .fontSize(18).font('Helvetica-Bold')
      .text('PÓLIZA DE SEGURO', 0, 40, { width: pageWidth - 50, align: 'right' });
    doc.fontSize(10).font('Helvetica')
      .text('Asegura · Colsubsidio', 0, 62, { width: pageWidth - 50, align: 'right' });

    doc.fillColor(BRAND.black);
    doc.y = bannerHeight + 20;
  }

  // ── Title ─────────────────────────────────────────────────────────────────────

  private drawTitle(doc: InstanceType<typeof PDFDocument>, data: PolicyPdfData): void {
    doc.fontSize(20).font('Helvetica-Bold').fillColor(BRAND.black)
      .text('CERTIFICADO DE PÓLIZA', { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor(BRAND.gray)
      .text(data.productName, { align: 'center' });
    doc.fillColor(BRAND.black);
    doc.moveDown(1);
  }

  // ── Two-column info: holder details (left) + premium box (right) ─────────────

  private drawInfoColumns(doc: InstanceType<typeof PDFDocument>, data: PolicyPdfData, contentWidth: number): void {
    const startY = doc.y;
    const leftX = 50;
    const leftWidth = contentWidth * 0.55;
    const rightX = leftX + leftWidth + 20;
    const rightWidth = contentWidth - leftWidth - 20;

    // Left column — holder details
    doc.fontSize(11).font('Helvetica-Bold').text('Datos del asegurado', leftX, startY);
    doc.fontSize(10).font('Helvetica');
    const lines = [
      `Nombre: ${data.nombre}`,
      `Cédula: ${data.cedula}`,
      ...(data.email ? [`Correo: ${data.email}`] : []),
      `Aseguradora: ${data.insurer}`,
      `Fecha de emisión: ${data.issuedAt.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    ];
    let lineY = startY + 18;
    for (const line of lines) {
      doc.text(line, leftX, lineY, { width: leftWidth });
      lineY = doc.y + 2;
    }

    // Right column — premium box
    const { primary, total } = this.buildPremiumLines(data.monthlyPremium, data.petCount);
    const boxHeight = total ? 112 : 95;
    doc.roundedRect(rightX, startY, rightWidth, boxHeight, 6).fill(BRAND.blue);
    doc.fillColor(BRAND.white).fontSize(9).font('Helvetica-Bold')
      .text('PRIMA MENSUAL', rightX + 12, startY + 12, { width: rightWidth - 24 });
    doc.fontSize(total ? 15 : 20)
      .text(primary, rightX + 12, startY + 28, { width: rightWidth - 24 });

    let y = startY + (total ? 48 : 52);
    if (total) {
      doc.fontSize(9).font('Helvetica-Bold').text(total, rightX + 12, y, { width: rightWidth - 24 });
      y += 18;
    }
    doc.fontSize(8).font('Helvetica').text('COP / mes', rightX + 12, y, { width: rightWidth - 24 });
    y += 14;
    doc.fontSize(8).text(`N.° Póliza: ${data.policyId.toUpperCase()}`, rightX + 12, y, { width: rightWidth - 24 });

    doc.fillColor(BRAND.black);
    doc.y = Math.max(lineY, startY + boxHeight) + 20;
  }

  // Mirrors formatQuote()'s chat pricing display so the PDF and the chat quote always
  // agree: monthlyPremium is the per-unit (per-pet) price; the total is derived here.
  private buildPremiumLines(monthlyPremium: number, petCount?: number | null): { primary: string; total: string | null } {
    const amount = `$${monthlyPremium.toLocaleString('es-CO')}`;
    if (petCount && petCount > 1) {
      const totalAmount = monthlyPremium * petCount;
      return {
        primary: `${amount} por mascota`,
        total: `Total para ${petCount} mascotas: $${totalAmount.toLocaleString('es-CO')}`,
      };
    }
    return { primary: amount, total: null };
  }

  // ── Coverages box ──────────────────────────────────────────────────────────────

  private drawCoverages(doc: InstanceType<typeof PDFDocument>, data: PolicyPdfData, contentWidth: number): void {
    const startY = doc.y;
    const x = 50;
    const padding = 12;
    const lineHeight = 14;
    const boxHeight = padding * 2 + 18 + data.coverages.length * lineHeight;

    doc.roundedRect(x, startY, contentWidth, boxHeight, 6)
      .lineWidth(1).stroke(BRAND.blue);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND.blue)
      .text('Coberturas incluidas', x + padding, startY + padding, { width: contentWidth - padding * 2 });
    doc.fontSize(10).font('Helvetica').fillColor(BRAND.black);
    let lineY = startY + padding + 18;
    for (const cov of data.coverages) {
      // Helvetica's WinAnsi encoding has no ✓ glyph (renders as a stray apostrophe) — use •.
      doc.text(`• ${cov}`, x + padding, lineY, { width: contentWidth - padding * 2 });
      lineY += lineHeight;
    }

    doc.y = startY + boxHeight + 20;
  }

  // ── Blockchain audit QR ────────────────────────────────────────────────────────

  private drawAuditBox(
    doc: InstanceType<typeof PDFDocument>,
    contentWidth: number,
    auditUrl: string,
    qrBuffer: Buffer | null,
  ): void {
    const x = 50;
    const startY = doc.y;
    const boxHeight = 100;
    const qrSize = 76;

    doc.roundedRect(x, startY, contentWidth, boxHeight, 6).fill(BRAND.lightGray);

    if (qrBuffer) {
      try {
        doc.image(qrBuffer, x + 14, startY + 12, { width: qrSize, height: qrSize });
      } catch (err) {
        this.logger.warn(`Audit QR failed to render: ${String(err)}`);
      }
    }

    const textX = x + 14 + qrSize + 16;
    const textWidth = contentWidth - qrSize - 44;
    doc.fillColor(BRAND.blue).fontSize(11).font('Helvetica-Bold')
      .text('Verificación blockchain (Celo)', textX, startY + 14, { width: textWidth });
    doc.fillColor(BRAND.gray).fontSize(9).font('Helvetica')
      .text(
        'Escanea el código para consultar el registro público de auditoría de esta póliza en la red Celo.',
        textX, startY + 34, { width: textWidth },
      );
    doc.fontSize(7).font('Helvetica').fillColor(BRAND.gray)
      .text(auditUrl, textX, startY + 74, { width: textWidth });

    doc.fillColor(BRAND.black);
    doc.y = startY + boxHeight + 20;
  }

  // ── Footer ──────────────────────────────────────────────────────────────────

  private drawFooter(doc: InstanceType<typeof PDFDocument>, contentWidth: number): void {
    doc.moveTo(50, doc.y).lineTo(50 + contentWidth, doc.y).stroke(BRAND.gray);
    doc.moveDown(0.8);

    doc.fontSize(8).fillColor(BRAND.gray).font('Helvetica')
      .text(
        'Este documento es emitido bajo autorización del titular conforme a la Ley 1581 de 2012 ' +
        '(Protección de Datos Personales). Los datos aquí consignados fueron suministrados voluntariamente ' +
        'por el asegurado. Colsubsidio actúa como intermediario de seguros.',
        { align: 'justify' },
      );
    doc.moveDown(0.8);

    const footerY = doc.y;
    try {
      this.drawCroppedImage(doc, LOGO_YELLOW, LOGO_YELLOW_CROP, LOGO_YELLOW_CANVAS, 50, footerY, 90);
    } catch (err) {
      this.logger.warn(`Footer logo failed to load: ${String(err)}`);
    }
  }

  // Renders only a sub-region (crop) of a source image, scaled to a destination width,
  // via a clip path — pdfkit has no built-in image cropping, only whole-image placement.
  private drawCroppedImage(
    doc: InstanceType<typeof PDFDocument>,
    imagePath: string,
    crop: { x: number; y: number; w: number; h: number },
    canvas: { w: number; h: number },
    destX: number,
    destY: number,
    destWidth: number,
  ): void {
    const scale = destWidth / crop.w;
    const destHeight = crop.h * scale;
    const offsetX = destX - crop.x * scale;
    const offsetY = destY - crop.y * scale;

    doc.save();
    doc.rect(destX, destY, destWidth, destHeight).clip();
    doc.image(imagePath, offsetX, offsetY, { width: canvas.w * scale, height: canvas.h * scale });
    doc.restore();
  }
}

export { PolicyPdfData };
