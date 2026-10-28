import PDFDocument from 'pdfkit';
import type { InvoiceView } from '../shared/types.ts';
import { formatPaisa } from '../shared/domain.ts';

function decodeDataUrlImage(dataUrl: string | null): Buffer | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
}

/**
 * Generates an authoritative, multi-page vector PDF invoice document from saved InvoiceView data.
 * Complies with Sections 29, 30, and 58:
 * 1. Top yellow brand line on Page 1
 * 2. Official uploaded BRB logo immediately below (or clearly marked placeholder if unconfigured)
 * 3. Large business title: "BRB Cattle Feed & Oil Mills"
 * 4. Complete customer, account, invoice number/date, line items, and grand total with repeated headers on page breaks.
 */
export async function generateInvoicePdfBuffer(invoice: InvoiceView): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 36, bottom: 48, left: 42, right: 42 },
        bufferPages: true,
        info: {
          Title: `Invoice #${invoice.invoiceNumber} - ${invoice.brandingSnapshot.invoiceHeading}`,
          Author: invoice.brandingSnapshot.invoiceHeading,
          Subject: `Customer Invoice for ${invoice.customerName} (${invoice.customerAccountNumber})`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width; // 595.28
      const leftX = 42;
      const rightX = pageWidth - 42;
      const contentWidth = rightX - leftX;
      const accentHex = /^#[0-9A-Fa-f]{6}$/.test(invoice.brandingSnapshot.accentColor)
        ? invoice.brandingSnapshot.accentColor
        : '#EAB308';

      // 1. Top Yellow Line (First Page Requirement #1)
      doc.save();
      doc.rect(0, 0, pageWidth, 12).fill(accentHex);
      doc.restore();

      let cursorY = 26;

      // 2. Immediately below yellow line: BRB Logo (First Page Requirement #2)
      const logoBuf = decodeDataUrlImage(invoice.brandingSnapshot.logoDataUrl);
      if (logoBuf) {
        try {
          doc.image(logoBuf, leftX, cursorY, { fit: [64, 52] });
        } catch {
          drawPlaceholderEmblem(doc, leftX, cursorY, accentHex);
        }
      } else {
        drawPlaceholderEmblem(doc, leftX, cursorY, accentHex);
      }

      // Invoice badge on top right
      doc.save();
      doc.roundedRect(rightX - 165, cursorY, 165, 52, 6).fill('#0F172A');
      doc
        .fillColor(accentHex)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text('OFFICIAL TAX / SALES INVOICE', rightX - 155, cursorY + 10, {
          width: 145,
          align: 'right',
        });
      doc
        .fillColor('#FFFFFF')
        .font('Helvetica-Bold')
        .fontSize(16)
        .text(`INV #${invoice.invoiceNumber}`, rightX - 155, cursorY + 25, {
          width: 145,
          align: 'right',
        });
      doc.restore();

      cursorY += 64;

      // 3. Large Business Title: "BRB Cattle Feed & Oil Mills" (First Page Requirement #3)
      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(22)
        .text(invoice.brandingSnapshot.invoiceHeading || 'BRB Cattle Feed & Oil Mills', leftX, cursorY, {
          width: contentWidth,
        });

      cursorY = doc.y + 4;

      const subDetails: string[] = [];
      if (invoice.brandingSnapshot.businessAddress?.trim()) {
        subDetails.push(invoice.brandingSnapshot.businessAddress.trim());
      }
      if (invoice.brandingSnapshot.businessPhone?.trim()) {
        subDetails.push(`Contact: ${invoice.brandingSnapshot.businessPhone.trim()}`);
      }
      if (subDetails.length > 0) {
        doc
          .fillColor('#475569')
          .font('Helvetica')
          .fontSize(9.5)
          .text(subDetails.join('  •  '), leftX, cursorY, { width: contentWidth });
        cursorY = doc.y + 8;
      } else {
        cursorY += 6;
      }

      // Accent divider
      doc.save();
      doc.moveTo(leftX, cursorY).lineTo(rightX, cursorY).lineWidth(1.5).strokeColor('#E2E8F0').stroke();
      doc.restore();
      cursorY += 14;

      // Customer & Invoice Metadata Two-Column Box
      const metaBoxHeight = 76;
      doc.save();
      doc.roundedRect(leftX, cursorY, contentWidth, metaBoxHeight, 6).fill('#F8FAFC');
      doc.roundedRect(leftX, cursorY, contentWidth, metaBoxHeight, 6).lineWidth(0.75).strokeColor('#CBD5E1').stroke();
      doc.restore();

      // Left column: Billed To
      doc
        .fillColor('#64748B')
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .text('BILLED TO CUSTOMER', leftX + 14, cursorY + 11);
      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(13)
        .text(invoice.customerName, leftX + 14, cursorY + 25, { width: 250, ellipsis: true });
      doc
        .fillColor('#334155')
        .font('Helvetica')
        .fontSize(10)
        .text(`Account No: ${invoice.customerAccountNumber}`, leftX + 14, cursorY + 45);

      // Right column: Invoice Metadata
      const rightColX = leftX + 290;
      doc
        .fillColor('#64748B')
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .text('INVOICE DETAILS', rightColX, cursorY + 11);
      doc
        .fillColor('#0F172A')
        .font('Helvetica')
        .fontSize(10)
        .text(`Invoice Number:  ${invoice.invoiceNumber}`, rightColX, cursorY + 26)
        .text(`Invoice Date:       ${invoice.invoiceDate}`, rightColX, cursorY + 41)
        .text(
          invoice.sourceOrderNumber
            ? `Linked Order:       ${invoice.sourceOrderNumber}`
            : 'Sale Channel:      Direct / Independent',
          rightColX,
          cursorY + 56
        );

      cursorY += metaBoxHeight + 18;

      // Table column geometry
      const colSnoX = leftX;
      const colSnoW = 32;
      const colProdX = colSnoX + colSnoW;
      const colProdW = 235;
      const colQtyX = colProdX + colProdW;
      const colQtyW = 62;
      const colRateX = colQtyX + colQtyW;
      const colRateW = 86;
      const colTotalX = colRateX + colRateW;
      const colTotalW = contentWidth - (colSnoW + colProdW + colQtyW + colRateW);

      const drawTableHeader = (y: number): number => {
        doc.save();
        doc.rect(leftX, y, contentWidth, 26).fill('#0F172A');
        doc.rect(leftX, y, contentWidth, 3).fill(accentHex);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
        doc.text('#', colSnoX + 6, y + 9, { width: colSnoW - 8 });
        doc.text('PRODUCT & PACKING', colProdX + 6, y + 9, { width: colProdW - 10 });
        doc.text('QTY', colQtyX, y + 9, { width: colQtyW - 6, align: 'right' });
        doc.text(`RATE (${invoice.currencySymbol})`, colRateX, y + 9, { width: colRateW - 6, align: 'right' });
        doc.text(`TOTAL (${invoice.currencySymbol})`, colTotalX, y + 9, { width: colTotalW - 8, align: 'right' });
        doc.restore();
        return y + 26;
      };

      cursorY = drawTableHeader(cursorY);

      const pageBottomLimit = doc.page.height - 95;

      invoice.items.forEach((item, index) => {
        const productTitle = item.packingWeight
          ? `${item.productName} (${item.packingWeight})`
          : item.productName;

        doc.font('Helvetica').fontSize(9.5);
        const textHeight = doc.heightOfString(productTitle, { width: colProdW - 12 });
        const rowHeight = Math.max(26, Math.ceil(textHeight) + 12);

        if (cursorY + rowHeight > pageBottomLimit) {
          doc.addPage();
          // Subtle continuation top accent bar on subsequent pages
          doc.save();
          doc.rect(0, 0, pageWidth, 6).fill(accentHex);
          doc.fillColor('#475569').font('Helvetica-Bold').fontSize(9);
          doc.text(
            `${invoice.brandingSnapshot.invoiceHeading} — Invoice #${invoice.invoiceNumber} (Continued)`,
            leftX,
            18,
            { width: contentWidth }
          );
          doc.restore();
          cursorY = drawTableHeader(36);
        }

        if (index % 2 === 1) {
          doc.save();
          doc.rect(leftX, cursorY, contentWidth, rowHeight).fill('#F8FAFC');
          doc.restore();
        }

        doc.save();
        doc
          .moveTo(leftX, cursorY + rowHeight)
          .lineTo(rightX, cursorY + rowHeight)
          .lineWidth(0.5)
          .strokeColor('#E2E8F0')
          .stroke();

        doc.fillColor('#334155').font('Helvetica').fontSize(9.5);
        doc.text(String(index + 1), colSnoX + 6, cursorY + 8, { width: colSnoW - 8 });
        doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9.5);
        doc.text(productTitle, colProdX + 6, cursorY + 8, { width: colProdW - 12 });

        doc.fillColor('#0F172A').font('Helvetica').fontSize(9.5);
        doc.text(String(item.quantity), colQtyX, cursorY + 8, { width: colQtyW - 6, align: 'right' });
        doc.text(formatPaisa(item.ratePaisa, '').trim(), colRateX, cursorY + 8, {
          width: colRateW - 6,
          align: 'right',
        });
        doc.font('Helvetica-Bold');
        doc.text(formatPaisa(item.lineTotalPaisa, '').trim(), colTotalX, cursorY + 8, {
          width: colTotalW - 8,
          align: 'right',
        });
        doc.restore();

        cursorY += rowHeight;
      });

      // Totals section
      if (cursorY + 90 > pageBottomLimit) {
        doc.addPage();
        cursorY = 42;
      }

      cursorY += 12;
      const totalBoxWidth = 230;
      const totalBoxX = rightX - totalBoxWidth;

      doc.save();
      doc.roundedRect(totalBoxX, cursorY, totalBoxWidth, 44, 6).fill('#0F172A');
      doc.rect(totalBoxX, cursorY, 6, 44).fill(accentHex);
      doc
        .fillColor('#CBD5E1')
        .font('Helvetica-Bold')
        .fontSize(9)
        .text('GRAND TOTAL', totalBoxX + 16, cursorY + 10);
      doc
        .fillColor(accentHex)
        .font('Helvetica-Bold')
        .fontSize(15)
        .text(invoice.grandTotalFormatted, totalBoxX + 16, cursorY + 22, {
          width: totalBoxWidth - 26,
          align: 'right',
        });
      doc.restore();

      if (invoice.notes?.trim()) {
        doc
          .fillColor('#475569')
          .font('Helvetica')
          .fontSize(9)
          .text(`Remarks: ${invoice.notes.trim()}`, leftX, cursorY + 6, {
            width: contentWidth - totalBoxWidth - 16,
          });
      }

      cursorY += 58;
      if (invoice.brandingSnapshot.footerNote?.trim()) {
        doc
          .fillColor('#64748B')
          .font('Helvetica')
          .fontSize(8.5)
          .text(invoice.brandingSnapshot.footerNote.trim(), leftX, cursorY, { width: contentWidth });
      }

      // Page numbers across all buffered pages
      const pageRange = doc.bufferedPageRange();
      for (let i = 0; i < pageRange.count; i++) {
        doc.switchToPage(pageRange.start + i);
        const footerY = doc.page.height - 32;
        doc.save();
        doc.moveTo(leftX, footerY - 6).lineTo(rightX, footerY - 6).lineWidth(0.5).strokeColor('#CBD5E1').stroke();
        doc
          .fillColor('#64748B')
          .font('Helvetica')
          .fontSize(8)
          .text(
            `${invoice.brandingSnapshot.invoiceHeading} • Computer-Generated Ledger Invoice #${invoice.invoiceNumber}`,
            leftX,
            footerY,
            { width: contentWidth * 0.7, lineBreak: false }
          );
        doc.text(`Page ${i + 1} of ${pageRange.count}`, leftX, footerY, {
          width: contentWidth,
          align: 'right',
          lineBreak: false,
        });
        doc.restore();
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawPlaceholderEmblem(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  accentHex: string
): void {
  doc.save();
  doc.roundedRect(x, y, 128, 48, 5).fill('#FEF9C3');
  doc.roundedRect(x, y, 128, 48, 5).lineWidth(1.2).strokeColor(accentHex).stroke();
  doc
    .fillColor('#0F172A')
    .font('Helvetica-Bold')
    .fontSize(13)
    .text('BRB FEED', x + 10, y + 10, { width: 108, align: 'center' });
  doc
    .fillColor('#64748B')
    .font('Helvetica')
    .fontSize(7)
    .text('LOGO PLACEHOLDER', x + 10, y + 29, { width: 108, align: 'center' });
  doc.restore();
}
