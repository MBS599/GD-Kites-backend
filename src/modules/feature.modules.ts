import { Global, Module } from '@nestjs/common';
import { AddressesController } from './addresses/addresses.controller';
import { AdminController } from './admin/admin.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { GoogleVerifier } from './auth/google-verifier.service';
import { PhoneOtpService } from './auth/phone-otp.service';
import { CartController } from './cart/cart.controller';
import { CartService } from './cart/cart.service';
import { CategoriesController } from './catalog/categories.controller';
import { InventoryController } from './catalog/inventory.controller';
import { ProductsController } from './catalog/products.controller';
import { ProductsService } from './catalog/products.service';
import { DeliveriesController } from './deliveries/deliveries.controller';
import { DeliveriesService } from './deliveries/deliveries.service';
import { DriversController } from './drivers/drivers.controller';
import { DriversService } from './drivers/drivers.service';
import { VehicleTypesController } from './drivers/vehicle-types.controller';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { DispatchController } from './orders/dispatch.controller';
import { DispatchService } from './orders/dispatch.service';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RealtimeService } from './realtime/realtime.service';
import { ReportsController } from './reports/reports.controller';
import { UploadsController } from './uploads/uploads.controller';
import { ServiceAreasController } from './service-areas/service-areas.controller';
import { ServiceAreasService } from './service-areas/service-areas.service';
import { SettingsController, SettingsService } from './settings/settings.controller';
import { PaymentsController, RazorpayWebhookController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { RazorpayClient } from './payments/razorpay.client';
import { UsersController } from './users/users.controller';
import { GeoController } from './geo/geo.controller';
import { RoutingService } from './routing/routing.service';
import { GeoService } from './geo/geo.service';
import { SmsController } from './sms/sms.controller';
import { SmsService } from './sms/sms.service';
import { OtpGenerator } from './sms/otp';
import { PushService } from './sms/push.service';
import { WhatsAppAdminService } from './sms/whatsapp-admin.service';
import {
  NotificationsController,
  WhatsAppSetupController,
  WhatsAppWebController,
  WhatsAppWebhookController,
} from './sms/notifications.controller';
import { WhatsAppWebSession } from './sms/whatsapp-web.session';

@Global()
@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}

/** Customer/driver/admin messaging: WhatsApp or SMS gateways, push notifications, OTP codes. */
@Global()
@Module({
  controllers: [SmsController, NotificationsController, WhatsAppSetupController, WhatsAppWebhookController, WhatsAppWebController],
  providers: [SmsService, OtpGenerator, PushService, WhatsAppAdminService, WhatsAppWebSession],
  exports: [SmsService, OtpGenerator, PushService],
})
export class SmsModule {}

/** Admin-managed geofences; the resolver is used by addresses and checkout. */
@Global()
@Module({
  controllers: [ServiceAreasController, SettingsController],
  providers: [ServiceAreasService, SettingsService],
  exports: [ServiceAreasService, SettingsService],
})
export class ServiceAreasModule {}

@Module({ controllers: [AuthController], providers: [AuthService, GoogleVerifier, PhoneOtpService] })
export class AuthModule {}

@Module({ controllers: [UsersController] })
export class UsersModule {}

/** Reverse geocoding (coordinates → address). */
@Module({ controllers: [GeoController], providers: [GeoService] })
export class GeoModule {}

@Module({ controllers: [AddressesController] })
export class AddressesModule {}

/** Categories, products, inventory and product image uploads. */
@Module({
  controllers: [CategoriesController, ProductsController, InventoryController, UploadsController],
  providers: [ProductsService],
})
export class CatalogModule {}

@Module({ controllers: [CartController], providers: [CartService] })
export class CartModule {}

/** Orders, checkout and tracking. */
@Module({
  controllers: [OrdersController, DispatchController, PaymentsController, RazorpayWebhookController],
  providers: [OrdersService, DispatchService, RoutingService, PaymentsService, RazorpayClient],
})
export class OrdersModule {}

/** Driver profiles plus the Socket.IO gateway (which handles driver location). */
@Module({
  controllers: [DriversController, VehicleTypesController],
  providers: [DriversService, RealtimeGateway],
  exports: [DriversService],
})
export class DriversModule {}

@Module({ controllers: [DeliveriesController], providers: [DeliveriesService, RoutingService] })
export class DeliveriesModule {}

/** Admin dashboard and reports. */
@Module({ controllers: [AdminController, ReportsController] })
export class AdminModule {}
