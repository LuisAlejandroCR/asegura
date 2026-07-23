// pdf.service.ts: generates a policy PDF using pdfkit
import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

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
}

@Injectable()
export class PdfService {
  generate(data: PolicyPdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.writeContent(doc, data);
      doc.end();
    });
  }

  private writeContent(doc: InstanceType<typeof PDFDocument>, data: PolicyPdfData): void {
    const pageWidth = doc.page.width - 100;

    // Header
    doc.fontSize(22).font('Helvetica-Bold').text('COLSUBSIDIO SEGUROS', { align: 'center' });
    doc.fontSize(12).font('Helvetica').text('Powered by Asegura', { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).stroke();
    doc.moveDown(1);

    // Policy ID
    doc.fontSize(10).fillColor('#666666').text(`Póliza N.° ${data.policyId.toUpperCase()}`, { align: 'right' });
    doc.fontSize(10).text(`Fecha de emisión: ${data.issuedAt.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' })}`, { align: 'right' });
    doc.fillColor('#000000');
    doc.moveDown(1);

    // Product
    doc.fontSize(16).font('Helvetica-Bold').text(data.productName);
    doc.fontSize(12).font('Helvetica').text(`Aseguradora: ${data.insurer}`);
    doc.moveDown(0.5);

    // Premium
    doc.fontSize(14).font('Helvetica-Bold')
      .fillColor('#1a5276')
      .text(`Prima mensual: $${data.monthlyPremium.toLocaleString('es-CO')} COP`)
      .fillColor('#000000');
    doc.moveDown(1);

    // Holder
    doc.fontSize(13).font('Helvetica-Bold').text('Datos del asegurado');
    doc.fontSize(11).font('Helvetica');
    doc.text(`Nombre: ${data.nombre}`);
    doc.text(`Cédula: ${data.cedula}`);
    if (data.email) doc.text(`Correo: ${data.email}`);
    doc.moveDown(1);

    // Coverages
    doc.fontSize(13).font('Helvetica-Bold').text('Coberturas incluidas');
    doc.fontSize(11).font('Helvetica');
    for (const cov of data.coverages) {
      doc.text(`• ${cov}`);
    }
    doc.moveDown(1.5);

    // Footer
    doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(8).fillColor('#666666')
      .text(
        'Este documento es emitido bajo autorización del titular conforme a la Ley 1581 de 2012 ' +
        '(Protección de Datos Personales). Los datos aquí consignados fueron suministrados voluntariamente ' +
        'por el asegurado. Colsubsidio actúa como intermediario de seguros.',
        { align: 'justify' },
      );
  }
}
