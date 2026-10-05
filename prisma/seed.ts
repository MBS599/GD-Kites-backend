/**
 * Development sample data. Wipes and recreates everything — never run against production.
 *
 * Accounts (used by the e2e tests and the Flutter API integration test):
 *   admin@gdkitecenter.in        ADMIN
 *   rahul.patil@gdkitecenter.in  DRIVER (GD)
 *   amit.jadhav@gmail.com        DRIVER (External)
 *   suresh.more@gdkitecenter.in  DRIVER (GD)
 *   mayur.traders@gmail.com      CUSTOMER
 */
import { Prisma, PrismaClient, type DeliveryStatus, type OrderStatus } from '@prisma/client';
import { lineTotal, unitPrice } from '../src/common/pricing';
import { roadDistanceKm } from '../src/domain/geo';
import { deliveryTariffOf, driverTariffOf } from '../src/common/rates';
import { deliveryChargeFor, driverFareFor } from '../src/domain/pricing';

const prisma = new PrismaClient();
const HUB = { lat: Number(process.env.HUB_LAT ?? 18.444112), lng: Number(process.env.HUB_LNG ?? 73.874016) };
const D = (n: number) => new Prisma.Decimal(n);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database.');

  await prisma.$transaction([
    prisma.smsMessage.deleteMany(),
    prisma.otpChallenge.deleteMany(),
    prisma.orderStatusHistory.deleteMany(),
    prisma.delivery.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.cartItem.deleteMany(),
    prisma.cart.deleteMany(),
    prisma.address.deleteMany(),
    prisma.driverProfile.deleteMany(),
    prisma.vehicleType.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.comboItem.deleteMany(),
    prisma.product.deleteMany(),
    prisma.size.deleteMany({ where: { name: { notIn: ['Small', 'Medium', 'Big'] } } }),
    prisma.category.deleteMany(),
    prisma.user.deleteMany(),
    prisma.serviceArea.deleteMany(),
  ]);

  // ---- Service areas (geofences) --------------------------------------------------
  // Launch city is live; the next city is configured but switched off until the admin enables it.
  const pune = await prisma.serviceArea.create({
    data: {
      name: 'Pune', city: 'Pune', centerLat: HUB.lat, centerLng: HUB.lng, radiusKm: 100,
      hubName: 'GD Kite Center', hubLat: HUB.lat, hubLng: HUB.lng, isActive: true,
    },
  });
  await prisma.serviceArea.create({
    data: {
      name: 'Ahilyanagar', city: 'Ahilyanagar', centerLat: 19.0948, centerLng: 74.748, radiusKm: 15,
      hubName: 'Ahilyanagar hub', hubLat: 19.0948, hubLng: 74.748, isActive: false,
    },
  });
  await prisma.appSettings.upsert({
    where: { id: 1 },
    create: { id: 1, maxServiceRadiusKm: 100 },
    update: { maxServiceRadiusKm: 100 },
  });

  // ---- Categories -------------------------------------------------------------
  const cat = Object.fromEntries(
    await Promise.all(
      [
        ['fighterKites', 'Fighter Kites'],
        ['designerKites', 'Designer Kites'],
        ['manjha', 'Manjha'],
        ['accessories', 'Accessories'],
      ].map(async ([slug, name], i) => [slug, await prisma.category.create({ data: { slug, name, sortOrder: i } })]),
    ),
  ) as Record<string, { id: string }>;

  // ---- Sizes (also created by the migration) -------------------------------------
  const sizes = Object.fromEntries(
    await Promise.all(
      (['Small', 'Medium', 'Big'] as const).map(async (name, i) => [
        name,
        await prisma.size.upsert({ where: { name }, create: { name, sortOrder: i }, update: { sortOrder: i, isActive: true } }),
      ]),
    ),
  ) as Record<'Small' | 'Medium' | 'Big', { id: string }>;

  // ---- Products -----------------------------------------------------------------
  const mkProduct = (
    data: Omit<Prisma.ProductUncheckedCreateInput, 'price' | 'slabPrice' | 'categoryId' | 'sizeId'> & {
      category: string;
      price: number;
      slabPrice?: number;
      size?: 'Small' | 'Medium' | 'Big';
    },
  ) => {
    const { category, price, slabPrice, size, ...rest } = data;
    return prisma.product.create({
      data: {
        ...rest,
        categoryId: cat[category].id,
        sizeId: size ? sizes[size].id : null,
        price: D(price),
        slabPrice: slabPrice == null ? null : D(slabPrice),
      },
    });
  };

  const p = {
    fighter: await mkProduct({
      name: 'Premium Fighter Kite', category: 'fighterKites', price: 25,
      material: 'Kite paper + bamboo', size: 'Medium', slabQty: 500, slabPrice: 23,
      rating: 4.6, buyerCount: 128, description: 'Balanced fighter kite with seasoned bamboo spine.',
    }),
    designer: await mkProduct({
      name: 'Designer Kite — Printed', category: 'designerKites', price: 40,
      material: 'Printed kite paper', size: 'Medium', slabQty: 1000, slabPrice: 37,
      rating: 4.4, buyerCount: 86, description: 'Colour-printed festival designs, assorted patterns.',
    }),
    manjha: await mkProduct({
      name: 'Bareilly Manjha 9 Cord', category: 'manjha', price: 180, unit: 'reel',
      material: 'Cotton, glass coated', rating: 4.7, buyerCount: 64,
      description: 'Traditional Bareilly manjha, 9 cord strength.',
    }),
    charkha: await mkProduct({
      name: 'Wooden Charkha 12 in.', category: 'accessories', price: 120,
      material: 'Sheesham wood', rating: 4.3, buyerCount: 41,
      description: 'Hand-turned wooden spool with steel axle.',
    }),
    paperLarge: await mkProduct({
      name: 'Paper Fighter Kite — Large', category: 'fighterKites', price: 32,
      material: 'Kite paper + bamboo', size: 'Big', rating: 4.5, buyerCount: 52,
      description: 'Large size fighter kite in kite paper with seasoned bamboo spine.',
    }),
    tukkal: await mkProduct({
      name: 'Tukkal Kite', category: 'designerKites', price: 55,
      material: 'Kite paper + bamboo', size: 'Big', rating: 4.2, buyerCount: 23,
      description: 'Traditional tailed tukkal kite for steady flying.',
    }),
    cottonManjha: await mkProduct({
      name: 'Cotton Manjha 6 Cord', category: 'manjha', price: 120, unit: 'reel', inStock: false,
      material: 'Cotton', rating: 4.1, buyerCount: 30,
      description: 'Everyday cotton manjha, 6 cord.',
    }),
    seconds: await mkProduct({
      name: 'Fighter Kite — Seconds', category: 'fighterKites', price: 12, size: 'Medium', isDamaged: true,
      damageNote: 'Small tears and faded colours; flies fine.', material: 'Kite paper + bamboo', buyerCount: 9,
      description: 'Damaged stock at a low price.',
    }),
    tape: await mkProduct({
      name: 'Kite Repair Tape', category: 'accessories', price: 15, unit: 'roll',
      rating: 4.0, buyerCount: 18,
      description: 'Transparent tape for quick kite repairs.',
    }),
  };

  // A combo: several products at one lower price (worth ₹2,980 bought separately).
  const starter = await mkProduct({
    name: 'Festival Starter Combo', category: 'fighterKites', price: 2600, unit: 'combo', isCombo: true,
    buyerCount: 12, description: '100 fighter kites, 2 reels of Bareilly manjha and a wooden charkha.',
  });
  await prisma.comboItem.createMany({
    data: [
      { comboId: starter.id, productId: p.fighter.id, qty: 100, sortOrder: 0 },
      { comboId: starter.id, productId: p.manjha.id, qty: 2, sortOrder: 1 },
      { comboId: starter.id, productId: p.charkha.id, qty: 1, sortOrder: 2 },
    ],
  });

  // ---- Users & drivers ------------------------------------------------------------
  await prisma.user.create({
    data: { email: 'admin@gdkitecenter.in', name: 'GD Kite Center', phone: '+91 20 2426 0000', role: 'ADMIN' },
  });

  // Vehicle categories: the driver fare depends on the vehicle (or a custom per-driver rate).
  const bike = await prisma.vehicleType.create({ data: { name: 'Bike', baseFare: D(40), perKm: D(13), sortOrder: 0 } });
  const auto = await prisma.vehicleType.create({ data: { name: 'Auto rickshaw', baseFare: D(70), perKm: D(18), sortOrder: 1 } });
  const tempo = await prisma.vehicleType.create({ data: { name: 'Tempo', baseFare: D(150), perKm: D(25), sortOrder: 2 } });
  // Customer delivery charge = the Tempo rate (most deliveries go by tempo).
  await prisma.appSettings.update({ where: { id: 1 }, data: { deliveryVehicleTypeId: tempo.id } });

  const mkDriver = (email: string, name: string, phone: string, type: 'GD' | 'EXTERNAL', vehicle: string,
    vehicleType: typeof bike, availability: 'AVAILABLE' | 'ON_DELIVERY' = 'AVAILABLE',
    custom?: { base: number; perKm: number }) =>
    prisma.driverProfile.create({
      data: {
        type, vehicleNumber: vehicle, availability, hub: pune.hubName,
        serviceArea: { connect: { id: pune.id } },
        vehicleType: { connect: { id: vehicleType.id } },
        customBaseFare: custom ? D(custom.base) : null,
        customPerKm: custom ? D(custom.perKm) : null,
        user: { create: { email, name, phone, role: 'DRIVER' } },
      },
      include: { vehicleType: true },
    });
  const rahul = await mkDriver('rahul.patil@gdkitecenter.in', 'Rahul Patil', '+91 98220 11122', 'GD', 'MH12 KP 4471', bike);
  // External driver with a negotiated rate that overrides the Auto rickshaw fare.
  const amit = await mkDriver('amit.jadhav@gmail.com', 'Amit Jadhav', '+91 98600 33344', 'EXTERNAL', 'MH12 JR 2290', auto,
    'ON_DELIVERY', { base: 60, perKm: 16 });
  const suresh = await mkDriver('suresh.more@gdkitecenter.in', 'Suresh More', '+91 97660 55566', 'GD', 'MH12 LM 8812', tempo);

  const mkCustomer = (email: string, name: string, businessName: string, phone: string) =>
    prisma.user.create({ data: { email, name, businessName, phone, role: 'CUSTOMER', cart: { create: {} } } });
  const mayur = await mkCustomer('mayur.traders@gmail.com', 'Mayur Kulkarni', 'Mayur Traders', '+91 98220 45118');
  const ganesh = await mkCustomer('shreeganesh.traders@gmail.com', 'Ganesh Kale', 'Shree Ganesh Traders', '+91 98901 22110');
  const patil = await mkCustomer('patilkitehouse@gmail.com', 'Sagar Patil', 'Patil Kite House', '+91 99220 77881');
  const bazaar = await mkCustomer('kitebazaar.hadapsar@gmail.com', 'Imran Shaikh', 'Kite Bazaar', '+91 90110 44556');

  const mkAddress = (userId: string, label: string, area: string, line: string, pincode: string,
    lat: number, lng: number, contactName: string, contactPhone: string) =>
    prisma.address.create({
      data: {
        userId, label, area, line, city: 'Pune', pincode, lat, lng, contactName, contactPhone,
        serviceAreaId: pune.id,
        distanceKm: roadDistanceKm(HUB.lat, HUB.lng, lat, lng),
      },
    });

  const mayurShop = await mkAddress(mayur.id, 'Mayur Traders', 'Katraj', 'Shop 14, Katraj Chowk, near Katraj Dairy', '411046', 18.4529, 73.8652, 'Mayur Traders', mayur.phone!);
  await mkAddress(mayur.id, 'Godown', 'Ambegaon', 'Gat 21, Ambegaon Bk, near Datta Nagar', '411046', 18.4541, 73.8446, 'Mayur Traders', mayur.phone!);
  await mkAddress(mayur.id, 'Home', 'Dhankawadi', 'Flat 6, Sai Residency, Dhankawadi', '411043', 18.4637, 73.8533, 'Mayur Kulkarni', mayur.phone!);
  const ganeshShop = await mkAddress(ganesh.id, 'Shop', 'Bibwewadi', 'Shop 3, Bibwewadi Main Road', '411037', 18.4697, 73.8687, 'Shree Ganesh Traders', ganesh.phone!);
  const patilShop = await mkAddress(patil.id, 'Shop', 'Swargate', '12, Shankarshet Road, Swargate', '411042', 18.5018, 73.8636, 'Patil Kite House', patil.phone!);
  const bazaarShop = await mkAddress(bazaar.id, 'Shop', 'Hadapsar', 'Magarpatta Road, Hadapsar Gaon', '411028', 18.5089, 73.926, 'Kite Bazaar', bazaar.phone!);

  // ---- Orders -----------------------------------------------------------------------
  type P = (typeof p)[keyof typeof p];
  const timeline: Record<OrderStatus, OrderStatus[]> = {
    AWAITING_PAYMENT: ['AWAITING_PAYMENT'],
    PENDING: ['PENDING'],
    CONFIRMED: ['PENDING', 'CONFIRMED'],
    ASSIGNED: ['PENDING', 'CONFIRMED', 'ASSIGNED'],
    OUT_FOR_DELIVERY: ['PENDING', 'CONFIRMED', 'ASSIGNED', 'OUT_FOR_DELIVERY'],
    DELIVERED: ['PENDING', 'CONFIRMED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED'],
    CANCELLED: ['PENDING', 'CANCELLED'],
  };
  const deliveryStatus: Partial<Record<OrderStatus, DeliveryStatus>> = {
    ASSIGNED: 'ASSIGNED',
    OUT_FOR_DELIVERY: 'IN_TRANSIT',
    DELIVERED: 'DELIVERED',
  };

  const mkOrder = async (number: number, customer: typeof mayur, address: typeof mayurShop,
    lines: { product: P; qty: number }[], status: OrderStatus, placedAt: Date, driver?: typeof rahul) => {
    const subtotal = lines.reduce((s, l) => s.add(lineTotal(l.product, l.qty)), D(0));
    const deliveryCharge = D(deliveryChargeFor(address.distanceKm, deliveryTariffOf(tempo)));
    const step = (i: number) => new Date(placedAt.getTime() + i * 25 * 60_000);
    const steps = timeline[status];
    const deliveredAt = status === 'DELIVERED' ? step(steps.length - 1) : null;
    const ds = deliveryStatus[status];
    const order = await prisma.order.create({
      data: {
        number, customerId: customer.id, addressId: address.id, serviceAreaId: pune.id, status, subtotal, deliveryCharge,
        total: subtotal.add(deliveryCharge),
        addrLabel: address.label, addrArea: address.area, addrLine: address.line, addrCity: address.city,
        addrPincode: address.pincode, addrLat: address.lat, addrLng: address.lng, distanceKm: address.distanceKm,
        contactName: address.contactName!, contactPhone: address.contactPhone!,
        rejectionReason: status === 'CANCELLED' ? 'Out of stock for requested design' : null,
        placedAt, deliveredAt,
        items: {
          create: lines.map((l) => ({
            productId: l.product.id, productName: l.product.name, unit: l.product.unit, qty: l.qty,
            unitPrice: unitPrice(l.product, l.qty), lineTotal: lineTotal(l.product, l.qty),
          })),
        },
        history: {
          create: steps.map((s, i) => ({
            status: s, createdAt: step(i),
            note: s === 'CONFIRMED' ? 'by GD Kite Center' : s === 'ASSIGNED' ? 'Assigned driver' : null,
          })),
        },
        ...(driver && ds
          ? {
              delivery: {
                create: {
                  driverId: driver.id, status: ds, fare: D(driverFareFor(address.distanceKm, driverTariffOf(driver).tariff)),
                  assignedAt: step(2),
                  startedAt: ds !== 'ASSIGNED' ? step(3) : null,
                  completedAt: deliveredAt,
                  customerReceived: ds === 'DELIVERED' ? true : null,
                  cashCollected: ds === 'DELIVERED' ? true : null,
                },
              },
            }
          : {}),
      },
    });
    return order;
  };

  await mkOrder(1018, mayur, mayurShop, [{ product: p.fighter, qty: 100 }, { product: p.designer, qty: 100 }], 'DELIVERED', daysAgo(20), suresh);
  await mkOrder(1019, ganesh, ganeshShop, [{ product: p.manjha, qty: 20 }], 'CANCELLED', daysAgo(15));
  await mkOrder(1021, mayur, mayurShop, [{ product: p.fighter, qty: 200 }, { product: p.designer, qty: 100 }, { product: p.charkha, qty: 10 }], 'DELIVERED', daysAgo(10), rahul);
  await mkOrder(1022, bazaar, bazaarShop, [{ product: p.tukkal, qty: 50 }, { product: p.tape, qty: 25 }], 'CONFIRMED', minutesAgo(200));
  await mkOrder(1023, patil, patilShop, [{ product: p.fighter, qty: 100 }, { product: p.charkha, qty: 10 }], 'DELIVERED', minutesAgo(240), suresh);
  await mkOrder(1024, ganesh, ganeshShop, [{ product: p.designer, qty: 200 }], 'OUT_FOR_DELIVERY', minutesAgo(150), amit);
  await mkOrder(1025, mayur, mayurShop, [{ product: p.fighter, qty: 200 }], 'PENDING', minutesAgo(45));
  await mkOrder(1026, ganesh, ganeshShop, [{ product: p.fighter, qty: 100 }, { product: p.cottonManjha, qty: 20 }], 'ASSIGNED', minutesAgo(130), rahul);
  await mkOrder(1027, patil, patilShop, [{ product: p.paperLarge, qty: 100 }], 'ASSIGNED', minutesAgo(120), rahul);
  await mkOrder(1028, bazaar, bazaarShop, [{ product: p.fighter, qty: 150 }, { product: p.manjha, qty: 20 }], 'PENDING', minutesAgo(20));

  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('"Order"', 'number'), (SELECT MAX("number") FROM "Order"))`,
  );
  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
