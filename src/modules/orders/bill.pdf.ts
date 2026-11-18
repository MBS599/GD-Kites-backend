import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { orderCode, type FullOrder } from '../../common/serializers';

/** Shop details printed at the top of every bill. */
export interface BillShop {
  /** Contact number, e.g. "+91 89833 93542"; null when none is linked. */
  phone: string | null;
}

const SHOP_NAME = 'GD Kite Center';
const SHOP_LINE = 'Wholesale kites & kite supplies · Kondhwa Budruk, Pune 411046';
const INK = '#1c1e1b';
const MUTED = '#5f655e';
const BLUE = '#0b4f7a';
const LINE = '#d9ddd6';

/** The GD Kites logo (backend/assets), read once; the bill falls back to the name without it. */
const LOGO = (() => {
  const file = join(__dirname, '..', '..', '..', 'assets', 'bill-logo.png');
  return existsSync(file) ? readFileSync(file) : null;
})();

const num = (v: { toString(): string } | number | null | undefined) => Number(v?.toString() ?? 0);
/** "Rs 1,234.50" (the PDF's built-in fonts have no ₹ sign). */
export const billMoney = (v: number) =>
  'Rs ' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** The rows under the items, in order; zero amounts are left out. */
export function billTotals(o: FullOrder) {
  const rows: { label: string; amount: number }[] = [{ label: 'Goods', amount: num(o.subtotal) }];
  if (num(o.discount) > 0) rows.push({ label: `Offer${o.offerTitle ? ` · ${o.offerTitle}` : ''}`, amount: -num(o.discount) });
  if (o.deliveryMode === 'COURIER') {
    if (num(o.packingCharge) > 0) rows.push({ label: 'Packing charge (courier)', amount: num(o.packingCharge) });
  } else {
    rows.push({ label: `Delivery charge · ${o.distanceKm.toFixed(1)} km`, amount: num(o.deliveryCharge) });
  }
  if (num(o.deliveryTax) > 0) rows.push({ label: 'GST on delivery charge', amount: num(o.deliveryTax) });
  if (num(o.paymentFee) > 0) rows.push({ label: 'Online payment fee', amount: num(o.paymentFee) });
  const total = num(o.total);
  const paidOnline = num(o.paidOnline);
  return { rows, total, paidOnline, cash: Math.max(0, Math.round((total - paidOnline) * 100) / 100) };
}

/** The customer's bill for a delivered order, as an A4 PDF. */
export function renderBill(o: FullOrder, shop: BillShop): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: `Bill ${orderCode(o.number)}`, Author: SHOP_NAME, Subject: `Bill for order ${orderCode(o.number)}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // Header: logo and shop on the left, bill number and date on the right.
  if (LOGO) {
    doc.image(LOGO, left, 40, { height: 46 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(SHOP_NAME, left, 92);
  } else {
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(22).text(SHOP_NAME, left, 48);
  }
  doc.fillColor(MUTED).font('Helvetica').fontSize(9.5).text(SHOP_LINE, left, doc.y + 2);
  if (shop.phone) doc.text(`WhatsApp / call: ${shop.phone}`);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text('BILL', left, 48, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  doc.text(`Bill no. ${orderCode(o.number)}`, left, doc.y + 4, { width, align: 'right' });
  doc.text(`Ordered ${date(o.placedAt)}`, { width, align: 'right' });
  if (o.deliveredAt) doc.text(`Delivered ${date(o.deliveredAt)}`, { width, align: 'right' });

  let y = Math.max(doc.y, 130) + 14;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 14;

  // Bill to.
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8.5).text('BILL TO', left, y, { characterSpacing: 1 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(o.contactName, left, doc.y + 3);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  doc.text(o.contactPhone);
  const place = [o.addrLine, o.addrArea, [o.addrCity, o.addrPincode].filter(Boolean).join(' ')].filter((p) => p && p.trim()).join(', ');
  doc.text(o.deliveryMode === 'COURIER' ? `Sent by courier${o.courierName ? ` via ${o.courierName}` : ''} · ${place}` : place, {
    width: width * 0.65,
  });
  y = doc.y + 18;

  // Items table.
  const col = { no: left, item: left + 24, qty: left + width * 0.58, rate: left + width * 0.7, amount: left + width * 0.83 };
  const colW = { item: col.qty - col.item - 10, qty: col.rate - col.qty - 8, rate: col.amount - col.rate - 8, amount: right - col.amount };
  const header = () => {
    doc.rect(left, y, width, 22).fill('#f1f5f8');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8.5);
    doc.text('#', col.no + 6, y + 7);
    doc.text('ITEM', col.item, y + 7);
    doc.text('QTY', col.qty, y + 7, { width: colW.qty, align: 'right' });
    doc.text('RATE', col.rate, y + 7, { width: colW.rate, align: 'right' });
    doc.text('AMOUNT', col.amount, y + 7, { width: colW.amount, align: 'right' });
    y += 28;
  };
  header();
  o.items.forEach((it, i) => {
    doc.font('Helvetica').fontSize(10);
    const nameH = doc.heightOfString(it.productName, { width: colW.item });
    const extra = it.contents ? doc.fontSize(8.5).heightOfString(`Contains: ${it.contents}`, { width: colW.item }) + 2 : 0;
    const rowH = Math.max(nameH + extra, 14) + 8;
    if (y + rowH > doc.page.height - doc.page.margins.bottom - 150) {
      doc.addPage();
      y = doc.page.margins.top;
      header();
    }
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5).text(String(i + 1), col.no + 6, y);
    doc.fillColor(INK).fontSize(10).text(it.productName, col.item, y, { width: colW.item });
    if (it.contents) doc.fillColor(MUTED).fontSize(8.5).text(`Contains: ${it.contents}`, col.item, doc.y + 2, { width: colW.item });
    doc.fillColor(INK).fontSize(10);
    doc.text(`${it.qty.toLocaleString('en-IN')} ${it.unit}${it.qty === 1 ? '' : 's'}`, col.qty, y, { width: colW.qty, align: 'right' });
    doc.text(billMoney(num(it.unitPrice)), col.rate, y, { width: colW.rate, align: 'right' });
    doc.font('Helvetica-Bold').text(billMoney(num(it.lineTotal)), col.amount, y, { width: colW.amount, align: 'right' });
    y += rowH;
    doc.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.5).strokeColor(LINE).stroke();
  });

  // Totals, right-aligned under the table.
  const t = billTotals(o);
  y += 8;
  const labelX = left + width * 0.45;
  const labelW = col.amount - labelX - 8;
  const row = (label: string, amount: string, bold = false, color = INK) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? INK : MUTED);
    doc.text(label, labelX, y, { width: labelW, align: 'right' });
    doc.fillColor(color).text(amount, col.amount, y, { width: colW.amount, align: 'right' });
    y = doc.y + 6;
  };
  t.rows.forEach((r) => row(r.label, (r.amount < 0 ? '- ' : '') + billMoney(Math.abs(r.amount))));
  doc.moveTo(labelX, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
  y += 8;
  row('Total', billMoney(t.total), true, BLUE);
  if (t.paidOnline > 0) row('Paid online', billMoney(t.paidOnline));
  row(o.status === 'DELIVERED' ? 'Paid in cash on delivery' : 'To pay in cash on delivery', billMoney(t.cash));

  // Footer.
  y = Math.max(y + 24, doc.y + 24);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
  doc.text('Thank you for your order! Prices are our fixed wholesale rates. This is a computer-generated bill and needs no signature.', left, y, {
    width,
  });
  doc.end();
  return done;
}
