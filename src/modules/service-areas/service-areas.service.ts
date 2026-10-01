import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { ServiceArea } from '@prisma/client';
import { distanceFromHub, findServiceArea } from '../../domain/geofence';
import { PrismaService, type Tx } from '../../prisma/prisma.service';

export interface Coverage {
  area: ServiceArea;
  distanceKm: number;
}

@Injectable()
export class ServiceAreasService {
  constructor(private readonly prisma: PrismaService) {}

  active(db: PrismaService | Tx = this.prisma) {
    return db.serviceArea.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  /** Active area serving a point, with road distance from that area's hub; null if not covered. */
  async resolve(lat: number, lng: number, db: PrismaService | Tx = this.prisma): Promise<Coverage | null> {
    const area = findServiceArea(await this.active(db), lat, lng);
    return area ? { area, distanceKm: distanceFromHub(area, lat, lng) } : null;
  }

  /** Like [resolve] but throws a user-facing 422 listing where we deliver. */
  async require(lat: number, lng: number, db: PrismaService | Tx = this.prisma): Promise<Coverage> {
    const hit = await this.resolve(lat, lng, db);
    if (hit) return hit;
    const names = (await this.active(db)).map((a) => a.name);
    throw new UnprocessableEntityException(
      names.length
        ? `Sorry, we don't deliver to this location yet. We currently serve: ${names.join(', ')}.`
        : 'Sorry, deliveries are paused right now.',
    );
  }

  async get(id: string) {
    const a = await this.prisma.serviceArea.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Service area not found.');
    return a;
  }
}
