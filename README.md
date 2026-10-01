# GD Kite Center API

NestJS 11 · Prisma 6 · PostgreSQL · Socket.IO. REST base: `/api/v1`. Swagger UI: `/api/docs` (JSON: `/api/docs-json`).

## Run locally

```bash
docker compose up -d                 # Postgres 16 on localhost:5433
cp .env.example .env                 # fill JWT_ACCESS_SECRET / JWT_REFRESH_SECRET (≥32 chars, different)
npm install
npx prisma migrate deploy
npm run db:seed                      # wipes + recreates sample data (refuses NODE_ENV=production)
npm run dev                          # http://localhost:3000/api/v1
```

## Architecture

```
src/
  main.ts, bootstrap.ts        global prefix, helmet, CORS, ValidationPipe (whitelist + forbid unknown), Swagger, /uploads static
  app.module.ts                global guards: Throttler → JwtAuthGuard → RolesGuard; global error filter
  config/                      zod-validated env (fails fast; refuses dev-login in production)
  prisma/                      PrismaService (+ tx helper)
  common/                      auth decorators/guards, error envelope, serializers (API contract), pricing, uploads
  domain/                      pure rules: order state machine, pricing, geo (unit-tested)
  modules/
    auth/        Google ID-token sign-in, mobile OTP sign-in, refresh rotation, logout, dev-login
    users/       profile
    addresses/   saved addresses + delivery quote
    catalog/     categories, products, inventory (atomic adjustments + audit log), image uploads
    cart/        server-side cart
    orders/      checkout, listing (role-scoped), tracking, confirm/assign/reject/cancel
    drivers/     driver dashboard, availability, location; admin driver management; Socket.IO gateway
    deliveries/  driver workflow: start, proof photo upload, complete
    admin/       dashboard stats, reports
```

## Database

Normalized schema in `prisma/schema.prisma`: User, RefreshToken, Address, Category, Product, InventoryMovement, Cart, CartItem, Order, OrderItem, OrderStatusHistory, DriverProfile, Delivery.

- Money is `DECIMAL` (whole rupees enforced by validation today).
- Order items snapshot product name, unit, unit price and line total; orders snapshot the delivery address.
- CHECK constraints (in the init migration): non-negative stock, positive price/MOQ/qty, slab pair consistency, `total = subtotal + deliveryCharge`, non-negative fares.
- Products are soft-deleted; addresses are soft-deleted.

## Service areas (geofencing)

Admins control where the business delivers — e.g. launch in **Pune**, later switch on **Ahilyanagar**.

- A `ServiceArea` is a circle (centre + radius km) plus its own **dispatch hub**. Delivery distance, delivery charge and driver fare are measured from the hub of the area serving the address.
- `POST addresses` accepts only points inside an **active** area (422 otherwise, message lists live areas). `GET addresses/quote` returns `serviceable: false` + `servedAreas` instead of a price.
- Checkout re-checks the geofence, so pausing an area immediately stops new orders there; orders already placed continue.
- `GET addresses` re-evaluates every saved address (`serviceable`, `serviceArea`) against current areas.
- Drivers belong to one area; assigning a driver from another area is rejected (409). `PATCH drivers/:id/service-area` moves a driver.
- Overlapping circles: the area with the nearest centre wins.
- Seed: Pune (live, 25 km) and Ahilyanagar (configured, **paused**).

### Charges & fares (admin-set)

- Customer delivery charge (per service area) = `deliveryBaseCharge + deliveryPerKm × km` (defaults ₹60 + ₹30/km).
- Driver fare (per driver) = `baseFare + perKm × km` of the driver's **vehicle type** (`/vehicle-types`, admin CRUD; seeded Bike ₹40 + ₹13/km, Auto rickshaw ₹70 + ₹18/km, Tempo ₹150 + ₹25/km). A driver can have a custom fare (`PATCH /drivers/:id` with `customBaseFare` + `customPerKm`, both or neither; `null` for both clears it) which overrides the vehicle rate. Driver responses include `fare { baseFare, perKm, source: custom|vehicle|default }`.
- Re-assigning an order to another driver recalculates the fare with the new driver's rate.
- `km` is road distance from the area's hub; result rounded to the nearest rupee. Rates accept up to 2 decimals.
- The charge is fixed on the order at checkout and the fare on the delivery at assignment — changing rates later never rewrites existing orders.

### Max radius (admin setting)

`GET/PATCH settings { maxServiceRadiusKm }` — default **100 km**, allowed 1–1000. Creating an area, or changing an area's radius, above the max is rejected (400). Lowering the max doesn't shrink existing areas.

| Endpoint | Role |
|---|---|
| `GET service-areas` (`?all=true` for admins incl. paused) | any |
| `GET/PATCH settings` | admin |
| `GET geo/reverse?lat&lng` → `{ place: { label, full, area, city, pincode, state } }` | any signed-in |

Reverse geocoding: Google Geocoding when `GOOGLE_MAPS_API_KEY` is set, otherwise OpenStreetMap Nominatim (1 req/s, identifying User-Agent). Results are cached per ~11 m cell for 7 days; provider outages return 503 and the app falls back to showing coordinates. For production volume use Google or a self-hosted Nominatim.
| `GET/POST service-areas`, `PATCH service-areas/:id` (edit / `isActive`) | admin |
| `GET orders?serviceAreaId=`, `GET drivers?serviceAreaId=` | admin |

## Driver route optimisation

`GET /deliveries/route` (driver) returns the driver's open deliveries in the **best visiting order on real roads**:

- Start = driver's live position if updated in the last 30 min, else their service area's hub.
- Deliveries already **out for delivery** stay first; the remaining ones are optimised after them.
- Solved by the OSRM `trip` service (`ROUTING_PROVIDER=osrm`, `OSRM_URL`): road-following polyline, per-stop road distance and drive time, cumulative arrival minutes, total km/time and total fare.
- Cached 60 s per identical input; if OSRM is unreachable a nearest-neighbour fallback is returned with `optimized: false`.
- The public OSRM demo server is for development only — self-host OSRM (India extract) or switch to Google Routes for production. The provider sits behind `RoutePlanner` (`src/modules/routing`), so screens don't change.

## Messaging: WhatsApp + push notifications

Messages go out on **WhatsApp** — from a linked phone via whatsapp-web.js (chosen, free, unofficial) or the official Meta Cloud API — and as **Firebase push notifications (free)**. There is no SMS gateway and no DLT registration.

**WhatsApp from a linked phone — whatsapp-web.js** (`MESSAGING_PROVIDER=wwebjs`, the chosen setup; free):
1. Set `MESSAGING_PROVIDER=wwebjs` and restart. The server starts WhatsApp Web in headless Chromium (installed with the `puppeteer` dependency).
2. Admin → Settings → WhatsApp & notifications shows a **QR code**. On the business phone: WhatsApp → Settings → Linked devices → Link a device → scan. The login is saved in `WWEBJS_SESSION_DIR` (default `.wwebjs_auth`, git-ignored), so restarts don't need a new scan. Keep the phone online.
3. Messages are plain text (the WhatsApp wording from `whatsapp.templates.ts`), sent one at a time at least `WWEBJS_MIN_GAP_MS` apart (default 3 s, plus random jitter), only to numbers that are on WhatsApp. Delivered / read ticks come back from the phone and show in the admin log. "Unlink phone" / "Reconnect" are on the same screen.
4. **Unofficial**: automating WhatsApp Web is against WhatsApp's terms and the number can be banned without notice. Use a dedicated number. Server needs ~300 MB RAM for Chromium; on Linux, Chromium's system libraries must be installed.

**Official WhatsApp Cloud API** (alternative, `MESSAGING_PROVIDER=whatsapp`; default `log` only writes messages to the server log):
1. business.facebook.com → Meta Business account → add a WhatsApp Business account with a dedicated number (not already on the WhatsApp app). Submit business verification (GST) to lift the ~250 new contacts/day limit.
2. developers.facebook.com → your app → WhatsApp → API setup: copy the **Phone number ID** and **WhatsApp Business Account ID**; create a **permanent token** (Business settings → System users → generate token with `whatsapp_business_messaging` + `whatsapp_business_management`).
3. `.env`: `MESSAGING_PROVIDER=whatsapp`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` (optional `WHATSAPP_LANG=en`, `WHATSAPP_API_VERSION`). Restart.
4. Admin → Settings → WhatsApp & notifications → **Submit templates to Meta** — creates all 14 templates (`src/modules/sms/whatsapp.templates.ts`; sign-in code as an AUTHENTICATION template with a copy-code button). Approval usually takes minutes.
5. Delivery/read receipts (optional): in the Meta app → WhatsApp → Configuration, webhook URL `https://<your-api>/api/v1/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`; set `WHATSAPP_APP_SECRET` (App settings → Basic) — callbacks are signature-checked. The admin log then shows delivered / read / failed.

Cost: Meta's per-message rate for utility and authentication messages in India (≈ ₹0.115 + GST); no monthly fee when using the Cloud API directly.

**Push notifications** (`FIREBASE_SERVICE_ACCOUNT` = path to, or JSON of, a Firebase service-account key): every customer / driver / admin event is also pushed to the user's app installs (`DeviceToken`, registered by the app via `POST /notifications/devices`, removed on sign-out and when Firebase reports the token gone). Push ignores the "WhatsApp updates" switch — it is free and controlled by the phone's notification settings. Sign-in codes are never pushed.

**Who gets what** (WhatsApp, plus push in the app):

| To | When |
|----|------|
| Customer | order placed, confirmed, driver assigned (name + phone), out for delivery (with the **delivery code**), delivered, cancelled / rejected (reason); delivery code again on request; **sign-in code** (WhatsApp only) |
| Driver | added as driver (sign-in instructions), new delivery assigned, delivery taken away (re-assigned / cancelled) |
| Admins | new order, product dropped to low stock |

- Customers get WhatsApp on the delivery contact number from checkout; anyone can turn WhatsApp updates off in Account settings (`smsEnabled`). Numbers are normalised to Indian mobiles (`91XXXXXXXXXX`); landlines/invalid numbers are skipped.
- Sending never blocks or fails an order action. Retries twice on network / 5xx / rate-limit errors; the same text to the same number for the same order within 10 minutes is sent once. Every attempt is stored in `SmsMessage` (Admin → WhatsApp & notifications, `GET /sms/messages`) with one-time codes masked; `POST /sms/test` sends the test template.
- The queue is in-process: messages still queued when the server stops are not resent. For high volume move it to a job queue (BullMQ/Redis).

## Security

- **Mobile OTP sign-in**: `POST /auth/otp/request {phone}` sends a 6-digit code on WhatsApp (valid 5 min; one request per 30 s and 5 per hour per number; the endpoint is also IP-throttled). `POST /auth/otp/verify {phone, code, name?}` allows 5 wrong tries per code and each code works once. Only an HMAC of the code is stored (`OtpChallenge`) and the message log masks it. An unknown number becomes a `CUSTOMER` (the API answers `422 name_required` until a name is sent); a number already on a customer/driver account signs into that account; **admins must use Google**. A number proven by OTP is kept in `phoneVerified`; OTP-only accounts cannot change their number from the profile. Disabled in production unless WhatsApp is configured (`GET /auth/config` → `otpLogin`).
- **Delivery OTP**: starting a delivery creates a 4-digit handover code, sent to the customer in the out-for-delivery WhatsApp message and push notification and shown in their order screen (`GET /orders/:id` → `deliveryOtp`, customer and admin only — never drivers, never in realtime payloads). `POST /deliveries/:id/complete` needs `otp`; 5 wrong codes lock it (`429 otp_locked`) until the customer resends (`POST /orders/:id/delivery-otp/resend`, 60 s cooldown, max 4 sends), which then issues a fresh code.

- **Google Sign-In**: `POST /auth/google {idToken}` — signature, expiry, audience (`GOOGLE_CLIENT_ID`, comma-separated) and verified email are checked. New accounts are always `CUSTOMER`; `ADMIN` only via `BOOTSTRAP_ADMIN_EMAILS` or seed; `DRIVER` only when an admin registers the driver's email.
- **Tokens**: JWT access token (`JWT_ACCESS_TTL`, default 15 min) + opaque refresh token (30 days) stored as SHA-256 hash. Each refresh rotates the token; replaying a rotated token revokes the whole token family. Logout revokes the family.
- Every request reloads the user, so deactivation/role changes apply immediately.
- Drivers only see and act on orders currently assigned to them (404 otherwise). Customers only see their own orders.
- Status changes go through `domain/orderStateMachine.ts` plus conditional updates (optimistic concurrency).
- Prices, totals, delivery charge and driver fare are always computed on the server.
- Rate limiting (300 req/min/IP; stricter on auth routes). Uploads: JPG/PNG/WEBP only, ≤ 5 MB, random filenames.

## Endpoints (all under `/api/v1`)

| Area | Endpoints | Role |
|---|---|---|
| Auth | `POST auth/google`, `POST auth/refresh`, `POST auth/logout`, `GET auth/me`, `GET auth/config`, `POST auth/dev-login` (dev only) | public / any |
| Users | `GET/PATCH users/me` | any |
| Addresses | `GET/POST addresses`, `DELETE addresses/:id`, `GET addresses/quote?lat&lng` | customer |
| Catalogue | `GET categories`, `GET products?q&category`, `GET products/:id` | any |
| Catalogue admin | `POST/PATCH categories`, `POST/PATCH/DELETE products`, `POST uploads` | admin |
| Inventory | `GET inventory?lowOnly`, `POST inventory/:productId/adjust`, `GET inventory/:productId/movements` | admin |
| Cart | `GET cart`, `POST cart/items`, `PATCH cart/items/:productId`, `DELETE cart/items/:productId`, `DELETE cart` | customer |
| Orders | `GET orders?status&q`, `GET orders/:id`, `GET orders/:id/tracking` | scoped by role |
| Checkout | `POST orders {addressId}`, `POST orders/:id/cancel` | customer |
| Order admin | `POST orders/:id/confirm`, `POST orders/:id/assign {driverId}`, `POST orders/:id/reject {reason}` | admin |
| Driver | `GET drivers/me`, `PATCH drivers/me/availability`, `POST drivers/me/location` | driver |
| Deliveries | `GET deliveries?scope`, `GET deliveries/:orderId`, `POST deliveries/:orderId/start`, `POST deliveries/:orderId/proof` (multipart `file`), `POST deliveries/:orderId/complete` | driver |
| Driver admin | `GET drivers`, `GET drivers/:id`, `POST drivers` | admin |
| Dashboard | `GET admin/dashboard` | admin |
| Reports | `GET reports/sales`, `GET reports/products`, `GET reports/drivers` (`from`, `to`, `limit`) | admin |

Errors: `{ "error": { "code", "message", "details?" } }` — `message` is user-safe.

## Realtime

Socket.IO at the server root, `auth: { token: <accessToken> }`. Rooms `user:<id>`, `driver:<driverProfileId>`, `admins`.
Events: `order:updated`, `order:revoked`, `catalog:updated`, `driver:updated`, `driver:location`. Drivers emit `driver:location {lat,lng}`.

## Tests

```bash
npm run typecheck
npm test                 # domain unit tests
npm run test:e2e         # 33 API tests against an isolated `gdkite_test` database (migrated + seeded automatically)
```

## Production checklist

`NODE_ENV=production`, strong distinct JWT secrets, `ALLOW_DEV_LOGIN=false`, real `GOOGLE_CLIENT_ID`s, restricted `CORS_ORIGINS`, HTTPS in front, `npx prisma migrate deploy` on release, uploads moved to object storage (S3/GCS) for multi-instance deployments.
