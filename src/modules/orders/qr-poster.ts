import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { create } from 'qrcode';

const INK = '#1c1e1b';
const MUTED = '#565c55';
const BLUE = '#0b4f7a';
const SKY = '#a9ddf5';
const SUN = '#ffcb2e';
const RED = '#e8452c';
const PAPER = '#fffcf2';
const WHATSAPP = '#1e8b57';

const LOGO = (() => {
  const file = join(__dirname, '..', '..', '..', 'assets', 'bill-logo.png');
  return existsSync(file) ? readFileSync(file) : null;
})();

/** A small diamond kite with a wavy tail, for decoration. */
function kite(doc: PDFKit.PDFDocument, x: number, y: number, s: number, color: string, tilt: number) {
  doc.save().translate(x, y).rotate(tilt);
  doc.polygon([0, -s], [s * 0.72, 0], [0, s * 1.25], [-s * 0.72, 0]).fill(color);
  doc.moveTo(0, -s).lineTo(0, s * 1.25).moveTo(-s * 0.72, 0).lineTo(s * 0.72, 0).lineWidth(0.8).strokeColor('#ffffff').strokeOpacity(0.7).stroke();
  doc.strokeOpacity(1);
  doc
    .moveTo(0, s * 1.25)
    .bezierCurveTo(s * 0.5, s * 1.7, -s * 0.5, s * 2.1, 0, s * 2.6)
    .bezierCurveTo(s * 0.5, s * 3.1, -s * 0.3, s * 3.4, s * 0.1, s * 3.9)
    .lineWidth(1.2)
    .strokeColor(color)
    .stroke();
  for (const [ty, c] of [
    [1.9, SUN],
    [3.0, RED],
  ] as const) {
    doc.polygon([0, s * ty], [s * 0.22, s * (ty + 0.16)], [0, s * (ty + 0.32)], [-s * 0.22, s * (ty + 0.16)]).fill(c === color ? BLUE : c);
  }
  doc.restore();
}

/** The shop QR as a ready-to-print A4 poster for the counter: the code is drawn as vectors, so
 * it stays sharp at any print size. */
export function renderQrPoster(url: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'GD Kite Center · Scan to order', Author: 'GD Kite Center' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = doc.page.width;
  const H = doc.page.height;
  const cx = W / 2;

  // Paper background and a blue header band.
  doc.rect(0, 0, W, H).fill(PAPER);
  doc.rect(0, 0, W, 160).fill(BLUE);
  doc.circle(W - 40, 30, 90).fillOpacity(0.12).fill(SKY).fillOpacity(1);
  doc.circle(30, 160, 60).fillOpacity(0.1).fill(SKY).fillOpacity(1);

  // Logo on a white pill, the shop name under it.
  const logoW = 200;
  const logoH = logoW * (137 / 420);
  doc.roundedRect(cx - logoW / 2 - 18, 26, logoW + 36, logoH + 16, (logoH + 16) / 2).fill('#ffffff');
  if (LOGO) doc.image(LOGO, cx - logoW / 2, 34, { width: logoW });
  else doc.font('Helvetica-Bold').fontSize(26).fillColor(BLUE).text('GD Kite Center', 0, 44, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(12.5).fillColor('#ffffff').text('Wholesale kites & kite supplies  ·  Kondhwa Budruk, Pune', 0, 120, { width: W, align: 'center' });

  // Headline.
  doc.font('Helvetica-Bold').fontSize(46).fillColor(INK).text('Scan & order here', 0, 186, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(15).fillColor(MUTED).text('Order on your phone. Pay cash at the counter.', 0, 238, { width: W, align: 'center' });

  // The QR on a white card with a thick yellow frame.
  const qr = create(url, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size;
  const box = 280;
  const quiet = 3;
  const cell = box / (n + quiet * 2);
  const cardX = cx - box / 2 - 16;
  const cardY = 284;
  const card = box + 32;
  doc.roundedRect(cardX - 9, cardY - 9, card + 18, card + 18, 30).fill(SUN);
  doc.roundedRect(cardX, cardY, card, card, 22).fill('#ffffff');
  const qx = cx - box / 2 + quiet * cell;
  const qy = cardY + 16 + quiet * cell;
  // Dark modules joined into runs per row, so no hairline gaps show between them when printed.
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c)) continue;
      let end = c;
      while (end + 1 < n && qr.modules.get(r, end + 1)) end++;
      doc.rect(qx + c * cell, qy + r * cell, (end - c + 1) * cell, cell + 0.3);
      c = end;
    }
  }
  doc.fill(INK);
  // "SCAN ME" tag over the top edge.
  const tagW = 120;
  doc.roundedRect(cx - tagW / 2, cardY - 22, tagW, 30, 15).fill(RED);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text('SCAN ME', cx - tagW / 2, cardY - 14, { width: tagW, align: 'center', characterSpacing: 2 });

  // Kites flying beside the card.
  kite(doc, 70, 330, 26, RED, -14);
  kite(doc, W - 72, 400, 22, BLUE, 12);
  kite(doc, 64, 520, 16, SUN, 8);
  kite(doc, W - 60, 290, 14, SUN, -10);

  // Three steps.
  const steps = [
    ['Scan', 'Open your phone camera and scan the code'],
    ['Choose', 'Enter your name & WhatsApp number, pick products'],
    ['Pay & get bill', 'Pay cash at the counter. Bill comes on WhatsApp'],
  ];
  const top = cardY + card + 34;
  const colW = (W - 80) / 3;
  steps.forEach(([title, text], i) => {
    const x = 40 + i * colW;
    const mid = x + colW / 2;
    doc.circle(mid, top + 18, 18).fill(i === 2 ? WHATSAPP : BLUE);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text(String(i + 1), mid - 18, top + 9, { width: 36, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(title, x + 6, top + 46, { width: colW - 12, align: 'center' });
    doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(text, x + 10, top + 66, { width: colW - 20, align: 'center', lineGap: 1.5 });
    if (i < 2) {
      doc
        .moveTo(mid + 30, top + 18)
        .lineTo(mid + colW - 30, top + 18)
        .dash(3, { space: 4 })
        .lineWidth(1.5)
        .strokeColor(SKY)
        .stroke()
        .undash();
    }
  });

  // Footer band.
  doc.rect(0, H - 92, W, 92).fill(BLUE);
  doc.rect(0, H - 92, W, 5).fill(SUN);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff').text('No app needed  ·  No delivery charge  ·  Same shop prices', 0, H - 66, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(12).fillColor(SKY).text(url.replace(/^https?:\/\//, '').replace(/\/$/, ''), 0, H - 40, { width: W, align: 'center' });

  doc.end();
  return done;
}
