/**
 * Writes the bill PDF of one order to a file, for checking the layout.
 *   npx ts-node scripts/render-bill.ts <orderId> <out.pdf>
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { orderInclude, type FullOrder } from '../src/common/serializers';
import { renderBill } from '../src/modules/orders/bill.pdf';

async function main() {
  const [orderId, out] = process.argv.slice(2);
  if (!orderId || !out) throw new Error('Usage: render-bill.ts <orderId> <out.pdf>');
  const prisma = new PrismaClient();
  try {
    const o = (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude })) as FullOrder;
    const s = await prisma.appSettings.findUnique({ where: { id: 1 } });
    const n = s?.whatsappNumber;
    writeFileSync(out, await renderBill(o, { phone: n ? `+${n.slice(0, 2)} ${n.slice(2, 7)} ${n.slice(7)}` : null }));
    console.log(`Wrote ${out}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
