import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AuthService } from '../src/modules/auth/auth.service';
import { PhoneOtpService } from '../src/modules/auth/phone-otp.service';
import { GoogleVerifier } from '../src/modules/auth/google-verifier.service';
import { GeoService } from '../src/modules/geo/geo.service';
import { OtpGenerator } from '../src/modules/sms/otp';
import { SmsService } from '../src/modules/sms/sms.service';
import { PushService } from '../src/modules/sms/push.service';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { RazorpayClient, type RzpPayment } from '../src/modules/payments/razorpay.client';

const API = '/api/v1';

type Session = { accessToken: string; refreshToken: string; user: { id: string; role: string; driverId: string | null } };

describe('GD Kite Center API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let baseUrl: string;
  let customer: Session;
  let admin: Session;
  let driver: Session;
  let otherDriver: Session;

  // The API has no password-less sign-in: sessions for seeded accounts are started in-process.
  const login = async (email: string): Promise<Session> => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { driverProfile: true } });
    const { refreshTokenId: _, ...session } = await app.get(AuthService).startSession(user);
    return session;
  };
  const auth = (s: Session) => ({ Authorization: `Bearer ${s.accessToken}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Google itself is not reachable in tests; the verifier is the only stub.
      .overrideProvider(GoogleVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token !== 'valid-google-token-new-user') throw new (await import('@nestjs/common')).UnauthorizedException('bad');
          return { sub: 'google-sub-123', email: 'new.shop@example.com', name: 'New Shop' };
        },
      })
      // External geocoder stubbed: e2e tests must not depend on the internet.
      .overrideProvider(GeoService)
      .useValue({
        reverse: async () => ({
          label: 'Marketyard, Mukund Nagar, Pune',
          full: 'Marketyard, Mukund Nagar, Pune, Maharashtra, 411001, India',
          area: 'Mukund Nagar',
          city: 'Pune',
          pincode: '411001',
          state: 'Maharashtra',
        }),
      })
      // Predictable one-time codes: login OTP 123456, delivery OTP 1234.
      .overrideProvider(OtpGenerator)
      .useValue({ code: (digits: number) => '123456'.slice(0, digits) })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    configureApp(app);
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);

    customer = await login('mayur.traders@gmail.com');
    admin = await login('admin@gdkitecenter.in');
    driver = await login('rahul.patil@gdkitecenter.in');
    otherDriver = await login('suresh.more@gdkitecenter.in');
    // Most tests place small orders; the minimum order value has its own test.
    await prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1, minOrderValue: 0 }, update: { minOrderValue: 0 } });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('authentication', () => {
    it('rejects requests without a token', async () => {
      const res = await http.get(`${API}/orders`).expect(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('Google sign-in creates a CUSTOMER — never an elevated role', async () => {
      const res = await http.post(`${API}/auth/google`).send({ idToken: 'valid-google-token-new-user' }).expect(200);
      expect(res.body.user.role).toBe('customer');
      expect(res.body.refreshToken).toBeTruthy();
      await http.post(`${API}/auth/google`).send({ idToken: 'forged-token-xyz' }).expect(401);
    });

    it('shows a shop contact number only while a phone is linked to WhatsApp', async () => {
      // Tests run with MESSAGING_PROVIDER=log: no linked phone, so no number — even if one was saved earlier.
      await prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1, whatsappNumber: '919000000001' }, update: { whatsappNumber: '919000000001' } });
      expect((await http.get(`${API}/auth/config`).expect(200)).body.supportPhone).toBeNull();
      await prisma.appSettings.update({ where: { id: 1 }, data: { whatsappNumber: null } });
    });

    it('mobile OTP sign-in: new number becomes a CUSTOMER; code is single-use and never logged', async () => {
      const cfg = (await http.get(`${API}/auth/config`).expect(200)).body;
      expect(cfg.otpLogin).toBe(true);
      await http.post(`${API}/auth/otp/request`).send({ phone: '12345' }).expect(400);

      const phone = '+91 91234 56789';
      const req = (await http.post(`${API}/auth/otp/request`).send({ phone }).expect(200)).body;
      expect(req).toMatchObject({ sentTo: '+91 91234 56789', expiresInSec: 300, resendAfterSec: 30 });
      const again = await http.post(`${API}/auth/otp/request`).send({ phone }).expect(429);
      expect(again.body.error.details.retryAfterSec).toBeGreaterThan(0);

      const wrong = await http.post(`${API}/auth/otp/verify`).send({ phone, code: '000000' }).expect(400);
      expect(wrong.body.error.message).toContain('4 attempts left');
      const needName = await http.post(`${API}/auth/otp/verify`).send({ phone, code: '123456' }).expect(422);
      expect(needName.body.error.code).toBe('name_required');
      const s = (await http.post(`${API}/auth/otp/verify`).send({ phone: '9123456789', code: '123456', name: 'Sai Kites' }).expect(200)).body;
      expect(s.user).toMatchObject({ role: 'customer', name: 'Sai Kites', phone: '+91 91234 56789', email: null });
      expect(s.refreshToken).toBeTruthy();
      // Single use.
      await http.post(`${API}/auth/otp/verify`).send({ phone, code: '123456', name: 'X Y' }).expect(400);
      // The SMS log never holds the code.
      const logged = await prisma.smsMessage.findFirstOrThrow({ where: { event: 'loginOtp', to: '919123456789' } });
      expect(logged.body).not.toContain('123456');
      expect(logged.body).toContain('••••');
      // Their number is their sign-in: they can't drop it from the profile.
      await http.patch(`${API}/users/me`).set({ Authorization: `Bearer ${s.accessToken}` }).send({ phone: '9876543210' }).expect(409);
    });

    it('mobile OTP signs drivers into their account; admins must use Google', async () => {
      await prisma.otpChallenge.deleteMany({});
      await http.post(`${API}/auth/otp/request`).send({ phone: '98220 11122' }).expect(200); // Rahul (driver)
      const s = (await http.post(`${API}/auth/otp/verify`).send({ phone: '9822011122', code: '123456' }).expect(200)).body;
      expect(s.user).toMatchObject({ role: 'driver', name: 'Rahul Patil' });

      await prisma.user.update({ where: { email: 'admin@gdkitecenter.in' }, data: { phone: '+91 90000 00001' } });
      try {
        await http.post(`${API}/auth/otp/request`).send({ phone: '9000000001' }).expect(200);
        const res = await http.post(`${API}/auth/otp/verify`).send({ phone: '9000000001', code: '123456' }).expect(403);
        expect(res.body.error.message).toContain('Google');
      } finally {
        await prisma.user.update({ where: { email: 'admin@gdkitecenter.in' }, data: { phone: '+91 20 2426 0000' } });
      }
    });

    it('Google customers add a mobile number, confirmed by code', async () => {
      // Google doesn't share a phone number; the new customer from the Google test has none.
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'new.shop@example.com' }, include: { driverProfile: true } });
      expect(user.phone).toBeNull();
      const { refreshTokenId: _, ...s } = await app.get(AuthService).startSession(user);
      const otp = app.get(PhoneOtpService); // in-process: the HTTP request limit is used up above
      await prisma.otpChallenge.deleteMany({});

      // Already confirmed on another account (Sai Kites, from the OTP test).
      await otp.request('9123456789');
      const taken = await http.post(`${API}/auth/phone/verify`).set(auth(s)).send({ phone: '9123456789', code: '123456' }).expect(409);
      expect(taken.body.error.message).toContain('another');

      await otp.request('98111 22233');
      await http.post(`${API}/auth/phone/verify`).set(auth(s)).send({ phone: '9811122233', code: '000000' }).expect(400);
      const ok = (await http.post(`${API}/auth/phone/verify`).set(auth(s)).send({ phone: '9811122233', code: '123456' }).expect(200)).body;
      expect(ok.user).toMatchObject({ phone: '+91 98111 22233', phoneVerified: true, role: 'customer' });
      // Single use.
      await http.post(`${API}/auth/phone/verify`).set(auth(s)).send({ phone: '9811122233', code: '123456' }).expect(400);
      // Order updates now reach that number.
      expect((await http.get(`${API}/auth/me`).set(auth(s)).expect(200)).body.user.phone).toBe('+91 98111 22233');
    });

    it('rotates refresh tokens and revokes the family on reuse', async () => {
      const s = await login('patilkitehouse@gmail.com');
      const r1 = await http.post(`${API}/auth/refresh`).send({ refreshToken: s.refreshToken }).expect(200);
      expect(r1.body.refreshToken).not.toBe(s.refreshToken);
      // Reusing the old token is treated as theft…
      await http.post(`${API}/auth/refresh`).send({ refreshToken: s.refreshToken }).expect(401);
      // …and kills the rotated token too.
      await http.post(`${API}/auth/refresh`).send({ refreshToken: r1.body.refreshToken }).expect(401);
    });

    it('logout revokes the refresh token', async () => {
      const s = await login('kitebazaar.hadapsar@gmail.com');
      await http.post(`${API}/auth/logout`).set(auth(s)).send({ refreshToken: s.refreshToken }).expect(204);
      await http.post(`${API}/auth/refresh`).send({ refreshToken: s.refreshToken }).expect(401);
    });

    it('validates payloads and rejects unknown fields', async () => {
      const res = await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: 'x', qty: 1, price: 1 }).expect(400);
      expect(res.body.error.code).toBe('bad_request');
    });
  });

  describe('role-based access', () => {
    it.each([
      ['get', '/admin/dashboard'],
      ['get', '/reports/sales'],
      ['get', '/drivers'],
      ['post', '/sizes'],
      ['post', '/products'],
      ['get', '/deliveries'],
    ])('customer cannot %s %s', async (method, path) => {
      await (http as any)[method](`${API}${path}`).set(auth(customer)).send({}).expect(403);
    });

    it('driver cannot use admin or customer APIs', async () => {
      await http.get(`${API}/admin/dashboard`).set(auth(driver)).expect(403);
      await http.get(`${API}/cart`).set(auth(driver)).expect(403);
    });
  });

  describe('catalogue & cart', () => {
    it('lists products with search and category filter', async () => {
      const all = await http.get(`${API}/products`).set(auth(customer)).expect(200);
      expect(all.body.products.length).toBe(9);
      const manjha = await http.get(`${API}/products?category=manjha`).set(auth(customer)).expect(200);
      expect(manjha.body.products.every((p: any) => p.category === 'manjha')).toBe(true);
      const q = await http.get(`${API}/products?q=tukkal`).set(auth(customer)).expect(200);
      expect(q.body.products).toHaveLength(1);
      const cats = await http.get(`${API}/categories`).set(auth(customer)).expect(200);
      expect(cats.body.categories.map((c: any) => c.slug)).toEqual(['fighterKites', 'designerKites', 'manjha', 'accessories']);
    });

    it('takes any quantity of in-stock products and prices them on the server', async () => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      expect(kite).toMatchObject({ inStock: true, size: { name: 'Medium' }, displayName: 'Premium Fighter Kite (Medium)' });
      await http.delete(`${API}/cart`).set(auth(customer)).expect(200);
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 0 }).expect(400);
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 3 }).expect(201); // no per-product minimum
      await http.patch(`${API}/cart/items/${kite.id}`).set(auth(customer)).send({ qty: 300 }).expect(200);
      const cart = await http.patch(`${API}/cart/items/${kite.id}`).set(auth(customer)).send({ qty: 600 }).expect(200);
      expect(cart.body.cart.items[0].unitPrice).toBe(23); // slab above 500
      expect(cart.body.cart.subtotal).toBe(600 * 23);
      const removed = await http.delete(`${API}/cart/items/${kite.id}`).set(auth(customer)).expect(200);
      expect(removed.body.cart.itemCount).toBe(0);
    });

    it('out-of-stock products can be seen but not added or ordered', async () => {
      const manjha = (await http.get(`${API}/products?q=Cotton%20Manjha`).set(auth(customer))).body.products[0];
      expect(manjha.inStock).toBe(false);
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: manjha.id, qty: 5 }).expect(400);

      // Switched off while it sits in a cart: the cart says so and checkout refuses.
      const tape = (await http.get(`${API}/products?q=tape`).set(auth(customer))).body.products[0];
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: tape.id, qty: 5 }).expect(201);
      await http.patch(`${API}/products/${tape.id}`).set(auth(customer)).send({ inStock: false }).expect(403);
      await http.patch(`${API}/products/${tape.id}`).set(auth(admin)).send({ inStock: false }).expect(200);
      try {
        const cart = (await http.get(`${API}/cart`).set(auth(customer)).expect(200)).body.cart;
        expect(cart.items[0].outOfStock).toBe(true);
        expect(cart.isValid).toBe(false);
        const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
        const res = await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id }).expect(409);
        expect(res.body.error.message).toContain('out of stock');
        const outOnly = (await http.get(`${API}/products`).set(auth(admin)).query({ outOfStock: true }).expect(200)).body.products;
        expect(outOnly.map((p: any) => p.id)).toEqual(expect.arrayContaining([manjha.id, tape.id]));
        expect(outOnly.every((p: any) => !p.inStock)).toBe(true);
      } finally {
        await http.patch(`${API}/products/${tape.id}`).set(auth(admin)).send({ inStock: true }).expect(200);
        await http.delete(`${API}/cart`).set(auth(customer)).expect(200);
      }
    });

    it('damaged products have their own section with a note', async () => {
      const damaged = (await http.get(`${API}/products`).set(auth(customer)).query({ damaged: true }).expect(200)).body.products;
      expect(damaged.length).toBeGreaterThan(0);
      expect(damaged.every((p: any) => p.isDamaged)).toBe(true);
      expect(damaged[0].damageNote).toBeTruthy();
      const regular = (await http.get(`${API}/products`).set(auth(customer)).query({ damaged: false, limit: 100 }).expect(200)).body.products;
      expect(regular.some((p: any) => p.isDamaged)).toBe(false);
    });

    it('admins manage the size master; the size shows in the product and order name', async () => {
      const sizes = (await http.get(`${API}/sizes`).set(auth(customer)).expect(200)).body.sizes;
      expect(sizes.map((x: any) => x.name)).toEqual(['Small', 'Medium', 'Big']);
      await http.post(`${API}/sizes`).set(auth(customer)).send({ name: 'Jumbo' }).expect(403);
      const jumbo = (await http.post(`${API}/sizes`).set(auth(admin)).send({ name: 'Jumbo' }).expect(201)).body.size;
      expect(jumbo.sortOrder).toBe(3);
      await http.post(`${API}/sizes`).set(auth(admin)).send({ name: 'Jumbo' }).expect(409);
      await http.patch(`${API}/sizes/${jumbo.id}`).set(auth(admin)).send({ isActive: false }).expect(200);
      expect((await http.get(`${API}/sizes`).set(auth(customer))).body.sizes.map((x: any) => x.name)).not.toContain('Jumbo');
      expect((await http.get(`${API}/sizes`).set(auth(admin)).query({ all: true })).body.sizes.map((x: any) => x.name)).toContain('Jumbo');
      // Hidden sizes can't be given to products.
      await http
        .post(`${API}/products`)
        .set(auth(admin))
        .send({ name: 'Jumbo Kite', category: 'fighterKites', price: 50, sizeId: jumbo.id })
        .expect(400);
    });
  });

  describe('full order lifecycle across roles', () => {
    let orderId: string;
    let kiteId: string;
    let socket: Socket;
    const events: string[] = [];

    beforeAll(async () => {
      socket = io(baseUrl, { transports: ['websocket'], auth: { token: customer.accessToken } });
      await new Promise<void>((r) => socket.on('connect', () => r()));
      socket.on('order:updated', (e: any) => events.push(e.order.status));
    });
    afterAll(() => socket.close());

    it('refuses carts below the minimum order value set by the admin', async () => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer)).expect(200)).body.addresses;
      await http.patch(`${API}/settings`).set(auth(customer)).send({ minOrderValue: 1 }).expect(403);
      const set = (await http.patch(`${API}/settings`).set(auth(admin)).send({ minOrderValue: 1_000_000 }).expect(200)).body;
      expect(set.settings.minOrderValue).toBe(1_000_000);
      expect((await http.get(`${API}/auth/config`).expect(200)).body.minOrderValue).toBe(1_000_000);
      try {
        await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 100 }).expect(201);
        const res = await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id }).expect(422);
        expect(res.body.error.code).toBe('below_minimum_order');
        expect(res.body.error.details.shortBy).toBeGreaterThan(0);
      } finally {
        await http.delete(`${API}/cart/items/${kite.id}`).set(auth(customer));
        await http.patch(`${API}/settings`).set(auth(admin)).send({ minOrderValue: 0 }).expect(200);
      }
    });

    it('places an order from the cart in one transaction', async () => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      kiteId = kite.id;
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer)).expect(200)).body.addresses;
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kiteId, qty: 100 }).expect(201);

      const res = await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id }).expect(201);
      const order = res.body.order;
      orderId = order.id;
      expect(order.status).toBe('pending');
      expect(order.subtotal).toBe(2500);
      expect(order.total).toBe(order.subtotal + order.deliveryCharge);

      // Order lines carry the name with its size.
      expect(order.items[0].name).toBe('Premium Fighter Kite (Medium)');
      const cart = (await http.get(`${API}/cart`).set(auth(customer))).body.cart;
      expect(cart.itemCount).toBe(0);
    });

    it('rejects an empty-cart checkout', async () => {
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id }).expect(400);
    });

    it('enforces the status machine and driver scoping', async () => {
      await http.get(`${API}/orders/${orderId}`).set(auth(driver)).expect(404);
      await http.post(`${API}/orders/${orderId}/assign`).set(auth(admin)).send({ driverId: driver.user.driverId }).expect(409);
      await http.post(`${API}/orders/${orderId}/confirm`).set(auth(admin)).expect(200);
      await http.post(`${API}/orders/${orderId}/confirm`).set(auth(admin)).expect(409);
      const assigned = await http
        .post(`${API}/orders/${orderId}/assign`)
        .set(auth(admin))
        .send({ driverId: driver.user.driverId })
        .expect(200);
      expect(assigned.body.order.driver.name).toBe('Rahul Patil');
      expect(assigned.body.order.driverFare).toBeGreaterThan(0);

      await http.get(`${API}/deliveries/${orderId}`).set(auth(driver)).expect(200);
      await http.get(`${API}/deliveries/${orderId}`).set(auth(otherDriver)).expect(404);
      await http.post(`${API}/deliveries/${orderId}/start`).set(auth(otherDriver)).expect(404);
    });

    it('driver starts, uploads proof and completes the delivery', async () => {
      await http
        .post(`${API}/deliveries/${orderId}/complete`)
        .set(auth(driver))
        .send({ customerReceived: true, cashCollected: true })
        .expect(400); // no proof yet
      await http.post(`${API}/deliveries/${orderId}/start`).set(auth(driver)).expect(200);

      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      await http
        .post(`${API}/deliveries/${orderId}/proof`)
        .set(auth(driver))
        .attach('file', Buffer.from('not an image'), { filename: 'x.txt', contentType: 'text/plain' })
        .expect(400);
      const up = await http
        .post(`${API}/deliveries/${orderId}/proof`)
        .set(auth(driver))
        .attach('file', png, { filename: 'proof.png', contentType: 'image/png' })
        .expect(201);
      expect(up.body.photoUrls).toHaveLength(1);

      const me = (await http.get(`${API}/drivers/me`).set(auth(driver)).expect(200)).body;
      expect(me.driver.availability).toBe('onDelivery');

      // Delivery OTP: customer (and admin) see it; the driver never does.
      const mine = (await http.get(`${API}/orders/${orderId}`).set(auth(customer)).expect(200)).body;
      expect(mine.deliveryOtp).toBe('1234');
      expect((await http.get(`${API}/orders/${orderId}`).set(auth(admin))).body.deliveryOtp).toBe('1234');
      expect((await http.get(`${API}/orders/${orderId}`).set(auth(driver))).body.deliveryOtp).toBeNull();
      expect(JSON.stringify((await http.get(`${API}/deliveries/${orderId}`).set(auth(driver))).body)).not.toContain('1234');

      await http
        .post(`${API}/deliveries/${orderId}/complete`)
        .set(auth(driver))
        .send({ customerReceived: true, cashCollected: true })
        .expect(400); // OTP missing
      const wrong = await http
        .post(`${API}/deliveries/${orderId}/complete`)
        .set(auth(driver))
        .send({ customerReceived: true, cashCollected: true, otp: '9999' })
        .expect(400);
      expect(wrong.body.error).toMatchObject({ code: 'otp_invalid', message: expect.stringContaining('4 attempts left') });

      const done = await http
        .post(`${API}/deliveries/${orderId}/complete`)
        .set(auth(driver))
        .send({ customerReceived: true, cashCollected: true, otp: '1234' })
        .expect(200);
      expect(done.body.order.status).toBe('delivered');
      expect(done.body.order.proof.photoUrls).toHaveLength(1);
      expect(done.body.order.history.map((h: any) => h.status)).toEqual([
        'pending',
        'confirmed',
        'assigned',
        'outForDelivery',
        'delivered',
      ]);
    });

    it('pushed every status change to the customer in realtime', async () => {
      await new Promise((r) => setTimeout(r, 300));
      expect(events).toEqual(['pending', 'confirmed', 'assigned', 'outForDelivery', 'delivered']);
    });

    it('tracking endpoint is scoped to the owner', async () => {
      const t = await http.get(`${API}/orders/${orderId}/tracking`).set(auth(customer)).expect(200);
      expect(t.body.status).toBe('delivered');
      const other = await login('shreeganesh.traders@gmail.com');
      await http.get(`${API}/orders/${orderId}/tracking`).set(auth(other)).expect(404);
    });
  });

  describe('SMS notifications', () => {
    const smsFor = async (orderId: string) => {
      await app.get(SmsService).drain();
      return prisma.smsMessage.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
    };

    it('texts customer, driver and admins through the order lifecycle (log provider)', async () => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id }).expect(201)).body.order;
      await http.post(`${API}/orders/${order.id}/confirm`).set(auth(admin)).expect(200);
      await http.post(`${API}/orders/${order.id}/assign`).set(auth(admin)).send({ driverId: otherDriver.user.driverId }).expect(200);
      await http.post(`${API}/orders/${order.id}/assign`).set(auth(admin)).send({ driverId: driver.user.driverId }).expect(200);
      await http.post(`${API}/deliveries/${order.id}/start`).set(auth(driver)).expect(200);

      const sms = await smsFor(order.id);
      const events = sms.map((m) => m.event);
      expect(events).toEqual(
        expect.arrayContaining(['orderPlaced', 'adminNewOrder', 'orderConfirmed', 'driverAssigned', 'deliveryAssigned', 'deliveryRemoved', 'outForDelivery']),
      );
      const placed = sms.find((m) => m.event === 'orderPlaced')!;
      expect(placed.status).toBe('LOGGED');
      expect(placed.to).toMatch(/^91[6-9]\d{9}$/);
      expect(placed.body).toContain(order.code);
      // Admin's seeded phone is a landline: recorded as skipped, never sent.
      expect(sms.find((m) => m.event === 'adminNewOrder')).toMatchObject({ status: 'SKIPPED' });
      // Removed driver hears about it, the new one gets the job.
      const rahul = await prisma.user.findUniqueOrThrow({ where: { email: 'rahul.patil@gdkitecenter.in' } });
      expect(sms.find((m) => m.event === 'deliveryAssigned' && m.userId === rahul.id)).toBeTruthy();

      // Confirming again is refused, and a duplicate text is never sent.
      expect(sms.filter((m) => m.event === 'orderConfirmed')).toHaveLength(1);
    });

    it('delivery OTP: locks after 5 wrong codes; customer resend issues a fresh code', async () => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id })).body.order;
      await http.post(`${API}/orders/${order.id}/confirm`).set(auth(admin)).expect(200);
      await http.post(`${API}/orders/${order.id}/assign`).set(auth(admin)).send({ driverId: driver.user.driverId }).expect(200);
      await http.post(`${API}/deliveries/${order.id}/start`).set(auth(driver)).expect(200);
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      await http.post(`${API}/deliveries/${order.id}/proof`).set(auth(driver)).attach('file', png, { filename: 'p.png', contentType: 'image/png' }).expect(201);

      // Out-for-delivery SMS carries the code, the stored copy does not.
      const sms = await smsFor(order.id);
      expect(sms.find((m) => m.event === 'outForDelivery')!.body).toContain('Share OTP ••••');

      // Resend too soon.
      await http.post(`${API}/orders/${order.id}/delivery-otp/resend`).set(auth(customer)).expect(429);
      await http.post(`${API}/orders/${order.id}/delivery-otp/resend`).set(auth(driver)).expect(403);

      const complete = (otp: string) =>
        http.post(`${API}/deliveries/${order.id}/complete`).set(auth(driver)).send({ customerReceived: true, cashCollected: true, otp });
      for (let i = 0; i < 4; i++) await complete('0000').expect(400);
      expect((await complete('0000').expect(429)).body.error.code).toBe('otp_locked');
      expect((await complete('1234').expect(429)).body.error.code).toBe('otp_locked'); // right code no longer accepted

      await prisma.delivery.update({ where: { orderId: order.id }, data: { otpLastSentAt: new Date(Date.now() - 120_000) } });
      const re = (await http.post(`${API}/orders/${order.id}/delivery-otp/resend`).set(auth(customer)).expect(200)).body;
      expect(re).toMatchObject({ deliveryOtp: '1234', newCode: true });
      expect((await smsFor(order.id)).some((m) => m.event === 'deliveryOtp')).toBe(true);
      await complete('1234').expect(200);
      expect((await http.get(`${API}/orders/${order.id}`).set(auth(customer))).body.deliveryOtp).toBeNull();
    });

    it('push: devices register per user; every milestone is pushed, even with messages turned off', async () => {
      const token = `fcm-token-${Date.now()}-abcdefghijklmnopqrstuvwxyz`;
      await http.post(`${API}/notifications/devices`).set(auth(customer)).send({ token, platform: 'android' }).expect(204);
      await http.post(`${API}/notifications/devices`).set(auth(customer)).send({ token: 'short', platform: 'android' }).expect(400);
      expect(await prisma.deviceToken.count({ where: { token } })).toBe(1);

      const push = app.get(PushService);
      const sent: { userId: string; type: string; body: string }[] = [];
      const spy = jest.spyOn(push, 'notifyUser').mockImplementation((userId, m) => {
        if (m) sent.push({ userId, type: m.data.type, body: m.body });
      });
      try {
        await http.patch(`${API}/users/me`).set(auth(customer)).send({ smsEnabled: false }).expect(200);
        const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
        const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
        await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
        const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id })).body.order;
        await http.post(`${API}/orders/${order.id}/confirm`).set(auth(admin)).expect(200);
        await http.post(`${API}/orders/${order.id}/assign`).set(auth(admin)).send({ driverId: driver.user.driverId }).expect(200);
        await http.post(`${API}/deliveries/${order.id}/start`).set(auth(driver)).expect(200);
        await app.get(SmsService).drain();

        const mine = sent.filter((s) => s.userId === customer.user.id).map((s) => s.type);
        expect(mine).toEqual(expect.arrayContaining(['orderPlaced', 'orderConfirmed', 'driverAssigned', 'outForDelivery']));
        expect(sent.find((s) => s.type === 'outForDelivery')!.body).toContain('Delivery code: 1234');
        expect(sent.some((s) => s.type === 'deliveryAssigned' && s.userId === driver.user.id)).toBe(true);
        expect(sent.some((s) => s.type === 'adminNewOrder' && s.userId === admin.user.id)).toBe(true);
        // …while no WhatsApp/SMS went to the customer who turned messages off.
        const msgs = await smsFor(order.id);
        expect(msgs.filter((m) => m.userId === customer.user.id)).toHaveLength(0);
      } finally {
        spy.mockRestore();
        await http.patch(`${API}/users/me`).set(auth(customer)).send({ smsEnabled: true }).expect(200);
      }

      await http.delete(`${API}/notifications/devices`).set(auth(customer)).send({ token }).expect(204);
      expect(await prisma.deviceToken.count({ where: { token } })).toBe(0);
    });

    it('WhatsApp webhook: verifies Meta, rejects bad signatures, records delivery/read receipts', async () => {
      const challenge = await http
        .get(`${API}/webhooks/whatsapp`)
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '12345' })
        .expect(200);
      expect(challenge.text).toBe('12345');
      await http.get(`${API}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(400);

      const m = await prisma.smsMessage.create({
        data: { event: 'test', to: '919822011122', body: 'x', status: 'SENT', provider: 'whatsapp', providerRef: 'wamid.TEST1' },
      });
      const payload = JSON.stringify({
        entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.TEST1', status: 'read', timestamp: '1790000000' }] } }] }],
      });
      const sig = (body: string, secret = 'test-app-secret') =>
        'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
      await http.post(`${API}/webhooks/whatsapp`).set('content-type', 'application/json').set('x-hub-signature-256', sig(payload, 'nope')).send(payload).expect(400);
      await http.post(`${API}/webhooks/whatsapp`).set('content-type', 'application/json').set('x-hub-signature-256', sig(payload)).send(payload).expect(200);
      const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id: m.id } });
      expect(after.deliveryStatus).toBe('read');

      // Template setup needs WhatsApp credentials on the server.
      await http.get(`${API}/sms/whatsapp/templates`).set(auth(admin)).expect(503);
      await http.get(`${API}/sms/whatsapp/templates`).set(auth(customer)).expect(403);
    });

    it('customers can turn SMS off', async () => {
      const me = (await http.patch(`${API}/users/me`).set(auth(customer)).send({ smsEnabled: false }).expect(200)).body.user;
      expect(me.smsEnabled).toBe(false);
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id })).body.order;
      await http.post(`${API}/orders/${order.id}/cancel`).set(auth(customer)).expect(200);
      const events = (await smsFor(order.id)).map((m) => m.event);
      expect(events).not.toContain('orderPlaced');
      expect(events).not.toContain('orderCancelled');
      expect(events).toContain('adminNewOrder');
      await http.patch(`${API}/users/me`).set(auth(customer)).send({ smsEnabled: true }).expect(200);
    });

    it('admin sees status, the log and can send a test; others cannot', async () => {
      const status = (await http.get(`${API}/sms/status`).set(auth(admin)).expect(200)).body;
      expect(status.provider).toBe('log');
      expect(status).toMatchObject({ channel: 'whatsapp', pushEnabled: false });
      expect(status.events.find((e: any) => e.event === 'orderPlaced')).toMatchObject({ whatsappTemplate: 'gdk_order_placed', text: expect.stringContaining('GD1037') });
      const test = (await http.post(`${API}/sms/test`).set(auth(admin)).send({ phone: '98220 11122' }).expect(200)).body;
      expect(test).toMatchObject({ status: 'logged', to: '919822011122' });
      const bad = (await http.post(`${API}/sms/test`).set(auth(admin)).send({ phone: '12345' }).expect(200)).body;
      expect(bad.status).toBe('skipped');
      const page = (await http.get(`${API}/sms/messages`).set(auth(admin)).query({ limit: 2 }).expect(200)).body;
      expect(page.messages).toHaveLength(2);
      expect(page.nextCursor).toBe(page.messages[1].id);
      await http.get(`${API}/sms/messages`).set(auth(customer)).expect(403);
      await http.post(`${API}/sms/test`).set(auth(driver)).send({}).expect(403);
    });
  });

  describe('dispatch planning', () => {
    /** Places + confirms an order for `who` at their address in `area`. */
    const confirmedOrderAt = async (who: Session, area: string) => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(who))).body.products[0];
      const addr = (await http.get(`${API}/addresses`).set(auth(who))).body.addresses.find((a: any) => a.area === area);
      await http.post(`${API}/cart/items`).set(auth(who)).send({ productId: kite.id, qty: 50 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(who)).send({ addressId: addr.id }).expect(201)).body.order;
      await http.post(`${API}/orders/${order.id}/confirm`).set(auth(admin)).expect(200);
      return order.id as string;
    };

    it('groups orders around the oldest one and assigns the whole group to one driver', async () => {
      const ganesh = await login('shreeganesh.traders@gmail.com');
      const bazaar = await login('kitebazaar.hadapsar@gmail.com');
      const katraj = await confirmedOrderAt(customer, 'Katraj');
      const hadapsar = await confirmedOrderAt(bazaar, 'Hadapsar');
      const bibwewadi = await confirmedOrderAt(ganesh, 'Bibwewadi');
      const dhankawadi = await confirmedOrderAt(customer, 'Dhankawadi');
      // Make the Katraj order the oldest waiting one, so it starts the first group.
      await prisma.order.updateMany({
        where: { status: 'CONFIRMED', id: { notIn: [katraj, hadapsar, bibwewadi, dhankawadi] } },
        data: { placedAt: new Date(Date.now() + 86_400_000) },
      });
      await prisma.order.update({ where: { id: katraj }, data: { placedAt: new Date(Date.now() - 3_600_000) } });

      // The group radius is an admin setting: a wide one pulls Hadapsar (≈7 km) into the Katraj group.
      await http.patch(`${API}/settings`).set(auth(admin)).send({ dispatchRadiusKm: 20, dispatchMaxOrders: 40 }).expect(200);
      const wide = (await http.get(`${API}/dispatch/plan`).set(auth(admin)).expect(200)).body;
      expect(wide).toMatchObject({ radiusKm: 20, maxPerDriver: 40 });
      const wideKatraj = wide.groups.find((g: any) => g.orders.some((o: any) => o.id === katraj));
      expect(wideKatraj.orders.map((o: any) => o.id)).toEqual(expect.arrayContaining([katraj, hadapsar, bibwewadi, dhankawadi]));
      await http.patch(`${API}/settings`).set(auth(admin)).send({ dispatchRadiusKm: 4, dispatchMaxOrders: 8 }).expect(200);

      const plan = (await http.get(`${API}/dispatch/plan`).set(auth(admin)).query({ radiusKm: 4 }).expect(200)).body;
      const groupOf = (id: string) => plan.groups.find((g: any) => g.orders.some((o: any) => o.id === id));
      const katrajGroup = groupOf(katraj);
      const ids = katrajGroup.orders.map((o: any) => o.id);
      expect(ids).toEqual(expect.arrayContaining([katraj, bibwewadi, dhankawadi]));
      expect(ids).not.toContain(hadapsar); // ≈7 km away: its own group
      expect(groupOf(hadapsar)).not.toBe(katrajGroup);
      expect(katrajGroup.route.distanceKm).toBeGreaterThan(0);
      expect(katrajGroup.suggestedDriver).toMatchObject({ id: expect.any(String), reason: expect.any(String) });
      expect(katrajGroup.suggestedDriver.fareTotal).toBeGreaterThan(0);
      // Each driver is suggested for at most one group.
      const suggested = plan.groups.map((g: any) => g.suggestedDriver?.id).filter(Boolean);
      expect(new Set(suggested).size).toBe(suggested.length);

      // One tap: the whole group to one driver.
      const res = (
        await http.post(`${API}/dispatch/assign`).set(auth(admin)).send({ driverId: katrajGroup.suggestedDriver.id, orderIds: ids }).expect(200)
      ).body;
      expect(res.assigned).toBe(ids.length);
      const assigned = await prisma.delivery.findMany({ where: { orderId: { in: ids } } });
      expect(new Set(assigned.map((d) => d.driverId))).toEqual(new Set([katrajGroup.suggestedDriver.id]));

      // For a single order, drivers already working nearby are ranked first.
      const ranked = (await http.get(`${API}/orders/${hadapsar}/driver-suggestions`).set(auth(admin)).expect(200)).body.drivers;
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0]).toMatchObject({ driverId: expect.any(String), reason: expect.any(String) });

      await http.get(`${API}/dispatch/plan`).set(auth(customer)).expect(403);
    });
  });

  describe('online payment of the delivery charge (Razorpay)', () => {
    const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex');
    const rzpPayments = new Map<string, RzpPayment>();
    let rzpOrders = 0;
    let rzp: RazorpayClient;
    let restore: jest.SpyInstance[] = [];

    beforeAll(() => {
      rzp = app.get(RazorpayClient);
      const payments = app.get(PaymentsService);
      restore = [
        jest.spyOn(payments, 'enabled', 'get').mockReturnValue(true),
        jest.spyOn(rzp, 'createOrder').mockImplementation(async (amount) => ({
          id: `order_E2E${++rzpOrders}`,
          amount,
          currency: 'INR',
          status: 'created',
        })),
        jest.spyOn(rzp, 'fetchPayment').mockImplementation(async (id) => {
          const p = rzpPayments.get(id);
          if (!p) throw new Error('no such payment');
          return p;
        }),
        jest.spyOn(rzp, 'capture').mockImplementation(async (id) => {
          const p = { ...rzpPayments.get(id)!, status: 'captured' as const };
          rzpPayments.set(id, p);
          return p;
        }),
        jest.spyOn(rzp, 'refund').mockImplementation(async () => ({ id: `rfnd_E2E${rzpOrders}`, status: 'processed' })),
        jest.spyOn(rzp, 'orderPayments').mockResolvedValue([]),
      ];
    });
    afterAll(() => restore.forEach((r) => r.mockRestore()));

    const placeUnpaid = async () => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      const body = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id }).expect(201)).body;
      return { ...body, productId: kite.id as string };
    };

    it('customer pays only the delivery charge online; the rest is cash on delivery', async () => {
      const { order, checkout } = await placeUnpaid();
      expect(order.status).toBe('awaitingPayment');
      expect(order.paymentDueBy).toEqual(expect.any(String));
      // Amount comes from the server's order, in paise.
      // Online: delivery charge + 18% GST + Razorpay fee (2% + GST on it) passed on; items stay cash on delivery.
      const online = Math.round((order.deliveryCharge + order.deliveryTax + order.paymentFee) * 100) / 100;
      expect(order.deliveryTax).toBe(Math.round(order.deliveryCharge * 18) / 100);
      expect(order.paymentFee).toBeGreaterThan(0);
      expect(order.total).toBeCloseTo(order.subtotal + online, 2);
      expect(checkout).toMatchObject({ provider: 'razorpay', keyId: 'rzp_test_e2e', amount: Math.round(online * 100), currency: 'INR' });
      expect(checkout.orderId).toMatch(/^order_/);
      expect(checkout.prefill.contact).toBeTruthy();
      // Not visible to the admin as a real order yet.
      await http.post(`${API}/orders/${order.id}/confirm`).set(auth(admin)).expect(409);

      // Reopening checkout reuses the same Razorpay order; other customers cannot.
      const again = (await http.post(`${API}/orders/${order.id}/payment`).set(auth(customer)).expect(200)).body.checkout;
      expect(again.orderId).toBe(checkout.orderId);
      const other = await login('shreeganesh.traders@gmail.com');
      await http.post(`${API}/orders/${order.id}/payment`).set(auth(other)).expect(404);

      // A forged signature is refused.
      rzpPayments.set('pay_E2E1', { id: 'pay_E2E1', order_id: checkout.orderId, amount: checkout.amount, currency: 'INR', status: 'authorized', method: 'upi' });
      await http
        .post(`${API}/orders/${order.id}/payment/verify`)
        .set(auth(customer))
        .send({ razorpayOrderId: checkout.orderId, razorpayPaymentId: 'pay_E2E1', razorpaySignature: 'f'.repeat(64) })
        .expect(400);

      const verify = {
        razorpayOrderId: checkout.orderId,
        razorpayPaymentId: 'pay_E2E1',
        razorpaySignature: sign('rzp-test-secret', `${checkout.orderId}|pay_E2E1`),
      };
      const paid = (await http.post(`${API}/orders/${order.id}/payment/verify`).set(auth(customer)).send(verify).expect(200)).body.order;
      expect(paid.status).toBe('pending');
      expect(paid.paymentMethod).toBe('deliveryPrepaid');
      expect(paid.paidOnline).toBe(online);
      expect(paid.dueOnDelivery).toBe(order.subtotal);
      expect(paid.payment).toMatchObject({ status: 'paid', method: 'upi', reference: 'pay_E2E1', amount: online });
      expect(rzp.capture).toHaveBeenCalledWith('pay_E2E1', checkout.amount);

      // Verify + webhook both arriving is harmless.
      await http.post(`${API}/orders/${order.id}/payment/verify`).set(auth(customer)).send(verify).expect(200);
      const event = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: rzpPayments.get('pay_E2E1') } } });
      await http.post(`${API}/webhooks/razorpay`).set('Content-Type', 'application/json').set('X-Razorpay-Signature', 'bad').send(event).expect(401);
      await http
        .post(`${API}/webhooks/razorpay`)
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', sign('rzp-webhook-secret', event))
        .send(event)
        .expect(200);
      const history = (await http.get(`${API}/orders/${order.id}`).set(auth(customer)).expect(200)).body.order.history;
      expect(history.map((h: any) => h.status)).toEqual(['awaitingPayment', 'pending']);

      // Cancelling refunds the delivery charge.
      const cancelled = (await http.post(`${API}/orders/${order.id}/cancel`).set(auth(customer)).expect(200)).body.order;
      expect(cancelled.status).toBe('cancelled');
      expect(rzp.refund).toHaveBeenCalledWith('pay_E2E1', checkout.amount, expect.any(Object));
      expect(cancelled.payment.status).toBe('refunded');
      expect(cancelled.paidOnline).toBe(0);
    });

    it('the Razorpay webhook alone confirms a payment (app closed before returning)', async () => {
      const { order, checkout } = await placeUnpaid();
      rzpPayments.set('pay_E2E2', { id: 'pay_E2E2', order_id: checkout.orderId, amount: checkout.amount, currency: 'INR', status: 'captured', method: 'card' });
      const event = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: rzpPayments.get('pay_E2E2') } } });
      await http
        .post(`${API}/webhooks/razorpay`)
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', sign('rzp-webhook-secret', event))
        .send(event)
        .expect(200);
      const now = (await http.get(`${API}/orders/${order.id}`).set(auth(customer)).expect(200)).body.order;
      expect(now).toMatchObject({ status: 'pending', paidOnline: checkout.amount / 100, payment: { status: 'paid', method: 'card' } });
      // A wrong amount is never accepted.
      const { order: o2, checkout: c2 } = await placeUnpaid();
      rzpPayments.set('pay_E2E3', { id: 'pay_E2E3', order_id: c2.orderId, amount: 100, currency: 'INR', status: 'captured' });
      await http
        .post(`${API}/orders/${o2.id}/payment/verify`)
        .set(auth(customer))
        .send({ razorpayOrderId: c2.orderId, razorpayPaymentId: 'pay_E2E3', razorpaySignature: sign('rzp-test-secret', `${c2.orderId}|pay_E2E3`) })
        .expect(400);
      await http.post(`${API}/orders/${o2.id}/cancel`).set(auth(customer)).expect(200);
      await http.post(`${API}/orders/${order.id}/cancel`).set(auth(customer)).expect(200);
    });

    it('unpaid orders are cancelled after the time limit', async () => {
      const { order } = await placeUnpaid();
      await prisma.order.update({ where: { id: order.id }, data: { paymentDueBy: new Date(Date.now() - 1000) } });
      expect(await app.get(PaymentsService).expireStale()).toBeGreaterThanOrEqual(1);
      const now = (await http.get(`${API}/orders/${order.id}`).set(auth(customer)).expect(200)).body.order;
      expect(now.status).toBe('cancelled');
      expect(now.rejectionReason).toContain('Payment not completed');
      await http.post(`${API}/orders/${order.id}/payment`).set(auth(customer)).expect(409);
    });
  });

  describe('cancellation', () => {
    it('admin reject frees the driver', async () => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id })).body.order;
      await http.post(`${API}/orders/${order.id}/confirm`).set(auth(admin)).expect(200);
      await http.post(`${API}/orders/${order.id}/assign`).set(auth(admin)).send({ driverId: otherDriver.user.driverId }).expect(200);
      const rej = await http.post(`${API}/orders/${order.id}/reject`).set(auth(admin)).send({ reason: 'Customer asked' }).expect(200);
      expect(rej.body.order.status).toBe('cancelled');
      expect(rej.body.order.driver).toBeNull();
      await http.get(`${API}/deliveries/${order.id}`).set(auth(otherDriver)).expect(404);
    });

    it('customer can cancel only while pending', async () => {
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id })).body.order;
      await http.post(`${API}/orders/${order.id}/cancel`).set(auth(customer)).expect(200);
      await http.post(`${API}/orders/${order.id}/cancel`).set(auth(customer)).expect(409);
    });
  });

  describe('service areas (geofence)', () => {
    const ahmednagarShop = { lat: 19.09, lng: 74.74 };
    const addressBody = { label: 'Branch', area: 'Market', line: 'Shop 2, Main Road', pincode: '414001', ...ahmednagarShop };
    let ahilyanagarId: string;

    it('lists only active areas to customers; admins can see all', async () => {
      const cust = (await http.get(`${API}/service-areas`).set(auth(customer)).expect(200)).body.serviceAreas;
      expect(cust.map((a: any) => a.name)).toEqual(['Pune']);
      const all = (await http.get(`${API}/service-areas?all=true`).set(auth(admin)).expect(200)).body.serviceAreas;
      expect(all.map((a: any) => a.name).sort()).toEqual(['Ahilyanagar', 'Pune']);
      ahilyanagarId = all.find((a: any) => a.name === 'Ahilyanagar').id;
      await http.post(`${API}/service-areas`).set(auth(customer)).send({}).expect(403);
    });

    it('rejects addresses outside every active area', async () => {
      const quote = (await http.get(`${API}/addresses/quote?lat=${ahmednagarShop.lat}&lng=${ahmednagarShop.lng}`).set(auth(customer)).expect(200)).body;
      expect(quote).toMatchObject({ serviceable: false, servedAreas: ['Pune'] });
      const res = await http.post(`${API}/addresses`).set(auth(customer)).send(addressBody).expect(422);
      expect(res.body.error.message).toContain('Pune');
    });

    it('admin switches on a new city; charges use that city’s hub', async () => {
      await http.patch(`${API}/service-areas/${ahilyanagarId}`).set(auth(admin)).send({ isActive: true }).expect(200);
      const quote = (await http.get(`${API}/addresses/quote?lat=${ahmednagarShop.lat}&lng=${ahmednagarShop.lng}`).set(auth(customer)).expect(200)).body;
      expect(quote.serviceable).toBe(true);
      expect(quote.serviceArea.name).toBe('Ahilyanagar');
      expect(quote.distanceKm).toBeLessThan(5); // measured from the local hub, not Pune (~120 km)
      const saved = (await http.post(`${API}/addresses`).set(auth(customer)).send(addressBody).expect(201)).body.address;
      expect(saved).toMatchObject({ serviceable: true, serviceArea: { name: 'Ahilyanagar' } });
    });

    it('keeps drivers inside their own area', async () => {
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      const branch = addresses.find((a: any) => a.label === 'Branch');
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: branch.id }).expect(201)).body.order;
      expect(order.serviceArea.name).toBe('Ahilyanagar');
      await http.post(`${API}/orders/${order.id}/confirm`).set(auth(admin)).expect(200);
      const res = await http.post(`${API}/orders/${order.id}/assign`).set(auth(admin)).send({ driverId: driver.user.driverId }).expect(409);
      expect(res.body.error.message).toContain('different service area');
      const filtered = (await http.get(`${API}/orders?serviceAreaId=${order.serviceArea.id}`).set(auth(admin)).expect(200)).body.orders;
      expect(filtered.every((o: any) => o.serviceArea.name === 'Ahilyanagar')).toBe(true);
    });

    it('admin sets the max radius (default 100 km) and areas must respect it', async () => {
      await http.get(`${API}/settings`).set(auth(customer)).expect(403);
      const s = (await http.get(`${API}/settings`).set(auth(admin)).expect(200)).body.settings;
      expect(s.maxServiceRadiusKm).toBe(100);
      const body = { name: 'Nashik', city: 'Nashik', centerLat: 19.9975, centerLng: 73.7898, radiusKm: 150, isActive: false };
      const tooBig = await http.post(`${API}/service-areas`).set(auth(admin)).send(body).expect(400);
      expect(tooBig.body.error.message).toContain('100 km');
      await http.patch(`${API}/settings`).set(auth(admin)).send({ maxServiceRadiusKm: 150 }).expect(200);
      await http.post(`${API}/service-areas`).set(auth(admin)).send(body).expect(201);
      await http.patch(`${API}/settings`).set(auth(admin)).send({ maxServiceRadiusKm: 100 }).expect(200);
      await http.patch(`${API}/settings`).set(auth(admin)).send({ maxServiceRadiusKm: 5000 }).expect(400);
      // Partial updates keep the other settings.
      const kept = (await http.patch(`${API}/settings`).set(auth(admin)).send({ dispatchRadiusKm: 12.5 }).expect(200)).body.settings;
      expect(kept).toMatchObject({ maxServiceRadiusKm: 100, dispatchRadiusKm: 12.5, dispatchMaxOrders: 8, deliveryGstPercent: 18, gatewayFeePercent: 2 });
      await http.patch(`${API}/settings`).set(auth(admin)).send({ deliveryGstPercent: 30 }).expect(400);
      await http.patch(`${API}/settings`).set(auth(admin)).send({ gatewayFeePercent: 6 }).expect(400);
      await http.patch(`${API}/settings`).set(auth(admin)).send({ dispatchMaxOrders: 0 }).expect(400);
      await http.patch(`${API}/settings`).set(auth(admin)).send({ dispatchRadiusKm: 4 }).expect(200);
    });

    it('delivery charge = area rates; driver fare = the assigned driver’s vehicle/custom rates', async () => {
      const all = (await http.get(`${API}/service-areas?all=true`).set(auth(admin))).body.serviceAreas;
      const pune = all.find((a: any) => a.name === 'Pune');
      expect(pune.rates).toEqual({ deliveryBaseCharge: 60, deliveryPerKm: 30 });
      await http
        .patch(`${API}/service-areas/${pune.id}`)
        .set(auth(admin))
        .send({ deliveryBaseCharge: 100, deliveryPerKm: 10 })
        .expect(200);
      // Area-level driver rates no longer exist.
      await http.patch(`${API}/service-areas/${pune.id}`).set(auth(admin)).send({ driverBaseFare: 50 }).expect(400);

      const q = (await http.get(`${API}/addresses/quote?lat=18.4529&lng=73.8652`).set(auth(customer)).expect(200)).body;
      expect(q.deliveryCharge).toBe(Math.round(100 + 10 * q.distanceKm));

      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      const shop = addresses.find((a: any) => a.serviceArea?.name === 'Pune');
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: shop.id }).expect(201)).body.order;
      expect(order.deliveryCharge).toBe(Math.round(100 + 10 * order.address.distanceKm));
      await http.post(`${API}/orders/${order.id}/confirm`).set(auth(admin)).expect(200);
      const assigned = (
        await http.post(`${API}/orders/${order.id}/assign`).set(auth(admin)).send({ driverId: otherDriver.user.driverId }).expect(200)
      ).body.order;
      // Suresh drives a Tempo: ₹150 + ₹25/km.
      expect(assigned.driver.vehicleType.name).toBe('Tempo');
      expect(assigned.driverFare).toBe(Math.round(150 + 25 * order.address.distanceKm));

      // Re-assign to Rahul (Bike ₹40 + ₹13/km): the fare follows the driver.
      const bikeFare = (
        await http.post(`${API}/orders/${order.id}/assign`).set(auth(admin)).send({ driverId: driver.user.driverId }).expect(200)
      ).body.order.driverFare;
      expect(bikeFare).toBe(Math.round(40 + 13 * order.address.distanceKm));

      // Changing rates later never rewrites placed orders.
      await http.patch(`${API}/service-areas/${pune.id}`).set(auth(admin)).send({ deliveryBaseCharge: 60, deliveryPerKm: 30 }).expect(200);
      const types = (await http.get(`${API}/vehicle-types`).set(auth(admin)).expect(200)).body.vehicleTypes;
      const bikeType = types.find((t: any) => t.name === 'Bike');
      await http.patch(`${API}/vehicle-types/${bikeType.id}`).set(auth(admin)).send({ perKm: 99 }).expect(200);
      const again = (await http.get(`${API}/orders/${order.id}`).set(auth(admin))).body.order;
      expect(again.deliveryCharge).toBe(order.deliveryCharge);
      expect(again.driverFare).toBe(bikeFare);
      await http.patch(`${API}/vehicle-types/${bikeType.id}`).set(auth(admin)).send({ perKm: 13 }).expect(200);
      await http.post(`${API}/orders/${order.id}/reject`).set(auth(admin)).send({ reason: 'Test cleanup' }).expect(200);

      await http.patch(`${API}/service-areas/${pune.id}`).set(auth(admin)).send({ deliveryPerKm: -1 }).expect(400);
    });

    it('switching an area off blocks new checkouts there but keeps the address', async () => {
      await http.patch(`${API}/service-areas/${ahilyanagarId}`).set(auth(admin)).send({ isActive: false }).expect(200);
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      const branch = addresses.find((a: any) => a.label === 'Branch');
      expect(branch.serviceable).toBe(false);
      const kite = (await http.get(`${API}/products?q=Premium`).set(auth(customer))).body.products[0];
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: kite.id, qty: 50 }).expect(201);
      await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: branch.id }).expect(422);
      await http.delete(`${API}/cart`).set(auth(customer)).expect(200);
    });
  });

  describe('driver route', () => {
    it('returns the driver’s open deliveries in an optimised order with totals', async () => {
      await http.get(`${API}/deliveries/route`).set(auth(customer)).expect(403);
      const res = await http.get(`${API}/deliveries/route`).set(auth(driver)).expect(200);
      const r = res.body;
      expect(['driver', 'hub']).toContain(r.origin.source);
      expect(r.stops.length).toBeGreaterThan(0);
      expect(r.stops.map((s: any) => s.sequence)).toEqual(r.stops.map((_: any, i: number) => i + 1));
      expect(r.stops.every((s: any) => ['assigned', 'outForDelivery'].includes(s.order.status))).toBe(true);
      expect(r.totalFare).toBeCloseTo(r.stops.reduce((sum: number, s: any) => sum + s.order.driverFare, 0));
      expect(r.geometry.length).toBeGreaterThanOrEqual(2);
      // Arrival times are cumulative.
      for (let i = 1; i < r.stops.length; i++) expect(r.stops[i].arrivalMinutes).toBeGreaterThanOrEqual(r.stops[i - 1].arrivalMinutes);
    });
  });

  describe('vehicle types & per-driver fares', () => {
    it('only admins manage vehicle types', async () => {
      await http.get(`${API}/vehicle-types`).set(auth(customer)).expect(403);
      await http.get(`${API}/vehicle-types`).set(auth(driver)).expect(403);
      const res = await http.post(`${API}/vehicle-types`).set(auth(admin)).send({ name: 'Mini truck', baseFare: 250, perKm: 32 }).expect(201);
      expect(res.body.vehicleType).toMatchObject({ name: 'Mini truck', baseFare: 250, perKm: 32 });
      await http.post(`${API}/vehicle-types`).set(auth(admin)).send({ name: 'Bad', baseFare: -1, perKm: 2 }).expect(400);
    });

    it('custom driver fare overrides the vehicle rate and can be cleared', async () => {
      const id = driver.user.driverId;
      await http.patch(`${API}/drivers/${id}`).set(auth(admin)).send({ customBaseFare: 55 }).expect(400); // needs both
      const custom = (await http.patch(`${API}/drivers/${id}`).set(auth(admin)).send({ customBaseFare: 55, customPerKm: 11.5 }).expect(200)).body.driver;
      expect(custom.fare).toEqual({ baseFare: 55, perKm: 11.5, source: 'custom' });
      const cleared = (await http.patch(`${API}/drivers/${id}`).set(auth(admin)).send({ customBaseFare: null, customPerKm: null }).expect(200)).body.driver;
      expect(cleared.fare).toMatchObject({ baseFare: 40, perKm: 13, source: 'vehicle' });
      expect(cleared.vehicleType.name).toBe('Bike');
    });

    it('amit (external) uses his negotiated rate', async () => {
      const drivers = (await http.get(`${API}/drivers`).set(auth(admin))).body.drivers;
      const amit = drivers.find((d: any) => d.name === 'Amit Jadhav');
      expect(amit.fare).toEqual({ baseFare: 60, perKm: 16, source: 'custom' });
      expect(amit.vehicleType.name).toBe('Auto rickshaw');
    });
  });

  describe('reverse geocoding', () => {
    it('returns an address for a point; requires auth and valid coordinates', async () => {
      await http.get(`${API}/geo/reverse?lat=18.48&lng=73.86`).expect(401);
      await http.get(`${API}/geo/reverse?lat=200&lng=73.86`).set(auth(admin)).expect(400);
      const res = await http.get(`${API}/geo/reverse?lat=18.4866&lng=73.8656`).set(auth(customer)).expect(200);
      expect(res.body.place).toMatchObject({ label: 'Marketyard, Mukund Nagar, Pune', pincode: '411001' });
    });
  });

  describe('admin management', () => {
    it('creates, updates and soft-deletes a product', async () => {
      const created = await http
        .post(`${API}/products`)
        .set(auth(admin))
        .send({ name: 'Test Kite', category: 'fighterKites', price: 30, slabQty: 100, slabPrice: 28 })
        .expect(201);
      const id = created.body.product.id;
      await http.patch(`${API}/products/${id}`).set(auth(admin)).send({ slabPrice: 35 }).expect(400); // must be below price
      expect(created.body.product).toMatchObject({ inStock: true, isDamaged: false, size: null, displayName: 'Test Kite' });
      const big = (await http.get(`${API}/sizes`).set(auth(admin))).body.sizes.find((x: any) => x.name === 'Big');
      const upd = await http
        .patch(`${API}/products/${id}`)
        .set(auth(admin))
        .send({ price: 32, sizeId: big.id, isDamaged: true, damageNote: 'Bent spine' })
        .expect(200);
      expect(upd.body.product).toMatchObject({ price: 32, displayName: 'Test Kite (Big)', isDamaged: true, damageNote: 'Bent spine' });
      // Back to regular stock: the damage note goes away.
      const fixed = await http.patch(`${API}/products/${id}`).set(auth(admin)).send({ isDamaged: false }).expect(200);
      expect(fixed.body.product).toMatchObject({ isDamaged: false, damageNote: null });
      await http.delete(`${API}/products/${id}`).set(auth(admin)).expect(204);
      await http.get(`${API}/products/${id}`).set(auth(customer)).expect(404);
    });

    it('finds orders by number however it is typed or spoken, and by driver name', async () => {
      const all = (await http.get(`${API}/orders`).set(auth(admin)).query({ limit: 100 }).expect(200)).body.orders;
      const withDriver = all.find((o: any) => o.driver?.name);
      const code = all[0].code as string;
      const n = Number(code.replace(/\D/g, ''));
      for (const q of [`${n}`, `#${n}`, `GD${n}`, `GD ${n}`, `order ${n}`]) {
        const found = (await http.get(`${API}/orders`).set(auth(admin)).query({ q }).expect(200)).body.orders;
        expect(found.map((o: any) => o.code)).toContain(code);
      }
      const byDriver = (await http.get(`${API}/orders`).set(auth(admin)).query({ q: withDriver.driver.name.split(' ')[0] }).expect(200)).body.orders;
      expect(byDriver.map((o: any) => o.id)).toContain(withDriver.id);
      // Customers only ever search their own orders.
      const me = (await http.get(`${API}/auth/me`).set(auth(customer)).expect(200)).body.user.id;
      const mine = (await http.get(`${API}/orders`).set(auth(customer)).query({ q: withDriver.customerName }).expect(200)).body.orders;
      expect(mine.every((o: any) => o.customerId === me)).toBe(true);
    });

    it('pages orders, products and drivers with a stable cursor', async () => {
      const all = (await http.get(`${API}/orders`).set(auth(admin)).query({ limit: 100 }).expect(200)).body;
      expect(all.nextCursor).toBeNull();
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = (await http.get(`${API}/orders`).set(auth(admin)).query({ limit: 2, ...(cursor ? { cursor } : {}) }).expect(200)).body;
        expect(page.orders.length).toBeLessThanOrEqual(2);
        seen.push(...page.orders.map((o: any) => o.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(all.orders.map((o: any) => o.id)); // same order, no gaps or duplicates

      const p1 = (await http.get(`${API}/products`).set(auth(customer)).query({ limit: 1 }).expect(200)).body;
      expect(p1.products).toHaveLength(1);
      const p2 = (await http.get(`${API}/products`).set(auth(customer)).query({ limit: 1, cursor: p1.nextCursor }).expect(200)).body;
      expect(p2.products[0].id).not.toBe(p1.products[0].id);

      const d1 = (await http.get(`${API}/drivers`).set(auth(admin)).query({ limit: 2 }).expect(200)).body;
      expect(d1.drivers).toHaveLength(2);
      expect(d1.nextCursor).toBe(d1.drivers[1].id);
      await http.get(`${API}/orders`).set(auth(admin)).query({ limit: 500 }).expect(400);
      await http.get(`${API}/orders`).set(auth(admin)).query({ cursor: 'nope' }).expect(400);
    });

    it('driver detail: open orders + true totals; history pages by driverId', async () => {
      const rahulId = (await http.get(`${API}/drivers/me`).set(auth(driver)).expect(200)).body.driver.id;
      const d = (await http.get(`${API}/drivers/${rahulId}`).set(auth(admin)).expect(200)).body;
      expect(d.orders.every((o: any) => ['assigned', 'outForDelivery'].includes(o.status))).toBe(true);

      const history: any[] = [];
      let cursor: string | undefined;
      do {
        const page = (
          await http
            .get(`${API}/orders`)
            .set(auth(admin))
            .query({ driverId: rahulId, status: 'delivered', limit: 2, ...(cursor ? { cursor } : {}) })
            .expect(200)
        ).body;
        history.push(...page.orders);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(history.length).toBe(d.totals.completedDeliveries);
      expect(history.every((o) => o.status === 'delivered' && o.driver.id === rahulId)).toBe(true);
      expect(d.totals.totalFares).toBe(history.reduce((s, o) => s + o.driverFare, 0));
      await http.get(`${API}/orders`).set(auth(admin)).query({ driverId: 'x' }).expect(400);
    });

    it('tracks driver location only while on duty; admins see it', async () => {
      await http.patch(`${API}/drivers/me/availability`).set(auth(otherDriver)).send({ availability: 'available' }).expect(200);
      await http.post(`${API}/drivers/me/location`).set(auth(otherDriver)).send({ lat: 18.51, lng: 73.86 }).expect(200);
      const list = (await http.get(`${API}/drivers`).set(auth(admin)).expect(200)).body.drivers;
      const suresh = list.find((d: any) => d.name.startsWith('Suresh'));
      expect(suresh.lastLocation).toMatchObject({ lat: 18.51, lng: 73.86 });
      // Customers follow orders by status only: their orders never carry the driver's position.
      await http.post(`${API}/drivers/me/location`).set(auth(driver)).send({ lat: 18.5, lng: 73.85 });
      const mine = (await http.get(`${API}/orders`).set(auth(customer)).query({ limit: 100 }).expect(200)).body.orders;
      expect(mine.some((o: any) => o.driver)).toBe(true);
      expect(mine.every((o: any) => !o.driver || o.driver.lastLocation === null)).toBe(true);
      const withDriver = mine.find((o: any) => o.driver);
      expect((await http.get(`${API}/orders/${withDriver.id}`).set(auth(customer)).expect(200)).body.order.driver.lastLocation).toBeNull();

      await http.patch(`${API}/drivers/me/availability`).set(auth(otherDriver)).send({ availability: 'offline' }).expect(200);
      await http.post(`${API}/drivers/me/location`).set(auth(otherDriver)).send({ lat: 18.6, lng: 73.9 }).expect(409);
      await http.post(`${API}/drivers/me/location`).set(auth(customer)).send({ lat: 18.6, lng: 73.9 }).expect(403);
      await http.patch(`${API}/drivers/me/availability`).set(auth(otherDriver)).send({ availability: 'available' }).expect(200);
    });

    it('registers a driver who then gets the DRIVER role', async () => {
      const res = await http
        .post(`${API}/drivers`)
        .set(auth(admin))
        .send({ name: 'Vikas Shinde', email: 'vikas@example.com', phone: '+91 90000 11111', type: 'external', vehicleNumber: 'mh12 ab 1234' })
        .expect(201);
      expect(res.body.driver.vehicleNumber).toBe('MH12 AB 1234');
      const s = await login('vikas@example.com');
      expect(s.user.role).toBe('driver');
    });

    it('dashboard and reports return numbers', async () => {
      // Default period: today (IST).
      const d = (await http.get(`${API}/admin/dashboard`).set(auth(admin)).expect(200)).body.stats;
      expect(d.period.from).toBe(d.period.to);
      expect(d.completed).toBeGreaterThanOrEqual(1);
      // Custom range: the last 30 days include the older seeded deliveries.
      const day = (offset: number) => new Date(Date.now() + 330 * 60_000 - offset * 86_400_000).toISOString().slice(0, 10);
      const month = (await http.get(`${API}/admin/dashboard`).set(auth(admin)).query({ from: day(30), to: day(0) }).expect(200)).body.stats;
      expect(month.period).toEqual({ from: day(30), to: day(0) });
      expect(month.sales).toBeGreaterThanOrEqual(d.sales);
      expect(month.completed).toBeGreaterThan(d.completed);
      expect(month.deliveryEarnings).toBeCloseTo(month.deliveryCharges - month.driverFares, 2);
      // Trend: 24 hours for a day, one bar per day for a month; it adds up to the sales figure.
      expect(d.trendUnit).toBe('hour');
      expect(d.trend).toHaveLength(24);
      expect(month.trendUnit).toBe('day');
      expect(month.trend).toHaveLength(31);
      expect(month.trend[30].key).toBe(day(0));
      expect(month.trend.reduce((t: number, b: any) => t + b.sales, 0)).toBeCloseTo(month.sales, 2);
      expect(month.topProducts.length).toBeGreaterThan(0);
      expect(month.customers).toBeGreaterThan(0);
      await http.get(`${API}/admin/dashboard`).set(auth(admin)).query({ from: day(0), to: day(5) }).expect(400);
      await http.get(`${API}/admin/dashboard`).set(auth(admin)).query({ from: '04-10-2026' }).expect(400);
      const sales = (await http.get(`${API}/reports/sales`).set(auth(admin)).expect(200)).body;
      expect(sales.totals.orders).toBeGreaterThan(0);
      const top = (await http.get(`${API}/reports/products`).set(auth(admin)).expect(200)).body.products;
      expect(top[0].qty).toBeGreaterThan(0);
      const drivers = (await http.get(`${API}/reports/drivers`).set(auth(admin)).expect(200)).body.drivers;
      expect(drivers.find((x: any) => x.name === 'Rahul Patil').deliveries).toBeGreaterThanOrEqual(1);
    });
  });

  describe('prices with paise, cost price and profit', () => {
    it('stores paise, hides the cost from customers and reports profit', async () => {
      const big = (await http.get(`${API}/sizes`).set(auth(admin))).body.sizes.find((x: any) => x.name === 'Big');
      const created = (
        await http
          .post(`${API}/products`)
          .set(auth(admin))
          .send({ name: 'Pona', category: 'fighterKites', price: 9.2, costPrice: 7.5, sizeId: big.id })
          .expect(201)
      ).body.product;
      expect(created).toMatchObject({ price: 9.2, costPrice: 7.5, displayName: 'Pona (Big)' });
      await http.post(`${API}/products`).set(auth(admin)).send({ name: 'X', category: 'manjha', price: 1.234 }).expect(400);

      // Customers never see the cost.
      const seen = (await http.get(`${API}/products/${created.id}`).set(auth(customer)).expect(200)).body.product;
      expect(seen.price).toBe(9.2);
      expect(seen).not.toHaveProperty('costPrice');
      expect((await http.get(`${API}/products/${created.id}`).set(auth(admin))).body.product.costPrice).toBe(7.5);

      const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
      const before = (await http.get(`${API}/admin/dashboard`).set(auth(admin)).query({ from: day })).body.stats;
      const addresses = (await http.get(`${API}/addresses`).set(auth(customer))).body.addresses;
      await http.delete(`${API}/cart`).set(auth(customer)).expect(200);
      await http.post(`${API}/cart/items`).set(auth(customer)).send({ productId: created.id, qty: 200 }).expect(201);
      const order = (await http.post(`${API}/orders`).set(auth(customer)).send({ addressId: addresses[0].id }).expect(201)).body.order;
      expect(order.subtotal).toBe(1840);
      const after = (await http.get(`${API}/admin/dashboard`).set(auth(admin)).query({ from: day })).body.stats;
      expect(after.profit - before.profit).toBeCloseTo(200 * (9.2 - 7.5), 2);
      expect(after.costedSales - before.costedSales).toBeCloseTo(1840, 2);
      await http.post(`${API}/orders/${order.id}/cancel`).set(auth(customer)).expect(200);
      await http.delete(`${API}/products/${created.id}`).set(auth(admin)).expect(204);
    });
  });

  describe('admin team', () => {
    it('admins add and remove other admins by Google email', async () => {
      const added = (await http.post(`${API}/admin/team`).set(auth(admin)).send({ name: 'Second Admin', email: 'Second.Admin@Example.com' }).expect(201)).body;
      const second = added.admins.find((a: any) => a.email === 'second.admin@example.com');
      expect(second).toMatchObject({ name: 'Second Admin', joined: false, owner: false });
      await http.post(`${API}/admin/team`).set(auth(admin)).send({ name: 'Again', email: 'second.admin@example.com' }).expect(409);
      // Drivers and customers with orders can't be turned into admins.
      await http.post(`${API}/admin/team`).set(auth(admin)).send({ name: 'Rahul', email: 'rahul.patil@gdkitecenter.in' }).expect(409);
      await http.post(`${API}/admin/team`).set(auth(admin)).send({ name: 'Mayur', email: 'mayur.traders@gmail.com' }).expect(409);
      // Only admins manage the team; nobody removes themselves.
      await http.get(`${API}/admin/team`).set(auth(customer)).expect(403);
      const me = (await http.get(`${API}/auth/me`).set(auth(admin)).expect(200)).body.user.id;
      await http.delete(`${API}/admin/team/${me}`).set(auth(admin)).expect(400);

      // The new admin signs in, then loses access as soon as they are removed.
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'second.admin@example.com' }, include: { driverProfile: true } });
      const { refreshTokenId: _, ...s } = await app.get(AuthService).startSession(user);
      expect((await http.get(`${API}/admin/team`).set(auth(s)).expect(200)).body.admins.length).toBeGreaterThanOrEqual(2);
      await http.delete(`${API}/admin/team/${second.id}`).set(auth(admin)).expect(204);
      await http.get(`${API}/admin/team`).set(auth(s)).expect(401);
      await http.post(`${API}/auth/refresh`).send({ refreshToken: s.refreshToken }).expect(401);
    });
  });

  describe('account deletion', () => {
    it('is for customers only', async () => {
      await http.delete(`${API}/users/me`).set(auth(driver)).expect(403);
      await http.delete(`${API}/users/me`).set(auth(admin)).expect(403);
    });

    it('is refused while the customer has orders in progress', async () => {
      const open = await prisma.order.findFirstOrThrow({
        where: { status: { in: ['PENDING', 'CONFIRMED', 'ASSIGNED', 'OUT_FOR_DELIVERY'] }, customer: { email: { not: null } } },
        include: { customer: true },
      });
      const s = await login(open.customer.email!);
      await http.delete(`${API}/users/me`).set(auth(s)).expect(409);
    });

    it('erases personal data, ends every session and frees the Google identity', async () => {
      const s = (await http.post(`${API}/auth/google`).send({ idToken: 'valid-google-token-new-user' }).expect(200)).body;
      await prisma.order.updateMany({
        where: { customerId: s.user.id, status: { notIn: ['DELIVERED', 'CANCELLED'] } },
        data: { status: 'CANCELLED' },
      });

      await http.delete(`${API}/users/me`).set(auth(s)).expect(204);

      const gone = await prisma.user.findUniqueOrThrow({ where: { id: s.user.id } });
      expect(gone).toMatchObject({ name: 'Deleted user', email: null, phone: null, googleSub: null, isActive: false });
      expect(await prisma.address.count({ where: { userId: s.user.id } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: s.user.id } })).toBe(0);
      expect(await prisma.smsMessage.count({ where: { userId: s.user.id } })).toBe(0);
      await http.get(`${API}/auth/me`).set(auth(s)).expect(401);
      await http.post(`${API}/auth/refresh`).send({ refreshToken: s.refreshToken }).expect(401);

      // Signing in with the same Google account again starts a fresh customer account.
      const again = (await http.post(`${API}/auth/google`).send({ idToken: 'valid-google-token-new-user' }).expect(200)).body;
      expect(again.user.id).not.toBe(s.user.id);
      expect(again.user.role).toBe('customer');
    });
  });
});
