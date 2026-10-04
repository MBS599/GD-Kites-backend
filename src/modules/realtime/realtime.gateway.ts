import { canDrive } from '../../common/auth.decorators';
import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AccessTokenVerifier } from '../../common/auth.guards';
import type { AuthUser } from '../../common/auth.decorators';
import { DriversService } from '../drivers/drivers.service';
import { RealtimeService } from './realtime.service';

const LOCATION_MIN_INTERVAL_MS = 3000;

/** Socket.IO endpoint at the server root. Clients authenticate with `auth: { token: <accessToken> }`. */
@WebSocketGateway({ cors: { origin: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly realtime: RealtimeService,
    private readonly verifier: AccessTokenVerifier,
    private readonly drivers: DriversService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  async handleConnection(socket: Socket) {
    const raw =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace(/^Bearer /, '');
    const user = await this.verifier.verify(raw);
    if (!user) {
      socket.emit('error', { code: 'unauthorized' });
      socket.disconnect(true);
      return;
    }
    socket.data.user = user;
    await socket.join(`user:${user.id}`);
    if (user.role === 'ADMIN') await socket.join('admins');
    if (canDrive(user)) await socket.join(`driver:${user.driverProfile!.id}`);
  }

  /** Drivers publish their position; forwarded to admins and customers with an order on the road. */
  @SubscribeMessage('driver:location')
  async onDriverLocation(@ConnectedSocket() socket: Socket, @MessageBody() body: { lat?: unknown; lng?: unknown }) {
    const user = socket.data.user as AuthUser | undefined;
    if (!user || !canDrive(user)) return;
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    // At most one position per driver connection every few seconds (GPS jitter / abuse).
    const now = Date.now();
    if (now - ((socket.data.lastLocationAt as number | undefined) ?? 0) < LOCATION_MIN_INTERVAL_MS) return;
    socket.data.lastLocationAt = now;
    try {
      await this.drivers.updateLocation(user.driverProfile!.id, lat, lng);
    } catch (e) {
      this.logger.warn(`location update failed: ${String(e)}`);
    }
  }
}
