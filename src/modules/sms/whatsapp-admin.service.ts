import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SMS_EVENTS } from './sms.templates';
import { templateCreatePayload, WA_TEMPLATES } from './whatsapp.templates';

/**
 * WhatsApp setup and delivery reports:
 * - lists / creates the app's message templates in the WhatsApp Business Account
 * - verifies and applies Meta webhooks (sent / delivered / read / failed)
 */
@Injectable()
export class WhatsAppAdminService {
  private readonly logger = new Logger(WhatsAppAdminService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  private graph(path: string) {
    return `https://graph.facebook.com/${this.config.get('WHATSAPP_API_VERSION')}/${path}`;
  }

  private requireSetup() {
    const token = this.config.get('WHATSAPP_TOKEN');
    const waba = this.config.get('WHATSAPP_BUSINESS_ACCOUNT_ID');
    if (!token || !waba) {
      throw new ServiceUnavailableException('Set WHATSAPP_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID on the server first.');
    }
    return { token, waba };
  }

  /** Every app message with its template name and Meta approval status. */
  async templates() {
    const { token, waba } = this.requireSetup();
    const res = await fetch(`${this.graph(`${waba}/message_templates`)}?fields=name,status,category,language&limit=200`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { data?: { name: string; status: string; language: string }[]; error?: { message: string } };
    if (!res.ok) throw new BadRequestException(`WhatsApp: ${json.error?.message ?? res.status}`);
    const lang = this.config.get('WHATSAPP_LANG');
    const byName = new Map((json.data ?? []).filter((t) => t.language === lang).map((t) => [t.name, t.status]));
    return SMS_EVENTS.map((event) => ({
      event,
      name: WA_TEMPLATES[event].name,
      category: WA_TEMPLATES[event].category,
      status: (byName.get(WA_TEMPLATES[event].name) ?? 'MISSING').toLowerCase(),
    }));
  }

  /** Submits any missing templates for Meta approval (usually minutes). */
  async createMissing() {
    const { token, waba } = this.requireSetup();
    const current = await this.templates();
    const results: { event: string; name: string; result: string }[] = [];
    for (const t of current) {
      if (t.status !== 'missing') {
        results.push({ event: t.event, name: t.name, result: `already ${t.status}` });
        continue;
      }
      const payload = templateCreatePayload(WA_TEMPLATES[t.event], this.config.get('WHATSAPP_LANG'));
      const res = await fetch(this.graph(`${waba}/message_templates`), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as { status?: string; error?: { error_user_msg?: string; message?: string } };
      results.push({
        event: t.event,
        name: t.name,
        result: res.ok ? `submitted (${(json.status ?? 'pending').toLowerCase()})` : `failed: ${json.error?.error_user_msg ?? json.error?.message ?? res.status}`,
      });
    }
    return results;
  }

  /** Meta webhook subscription handshake. */
  verifySubscription(mode?: string, token?: string, challenge?: string) {
    const expected = this.config.get('WHATSAPP_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && token === expected && challenge) return challenge;
    throw new BadRequestException('Webhook verification failed.');
  }

  /** Rejects callbacks not signed with the app secret (X-Hub-Signature-256). */
  checkSignature(raw: Buffer | undefined, signature: string | undefined) {
    const secret = this.config.get('WHATSAPP_APP_SECRET');
    if (!secret) throw new BadRequestException('WHATSAPP_APP_SECRET is not configured.');
    if (!raw || !signature?.startsWith('sha256=')) throw new BadRequestException('Missing signature.');
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new BadRequestException('Bad signature.');
  }

  /** Stores delivery status updates on the matching logged messages. */
  async applyStatuses(body: unknown) {
    const entries = (body as { entry?: { changes?: { value?: { statuses?: WaStatus[] } }[] }[] })?.entry ?? [];
    let updated = 0;
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        for (const s of change.value?.statuses ?? []) {
          const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
          const error = s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title ?? s.errors[0].message ?? ''}`.slice(0, 300) : undefined;
          const r = await this.prisma.smsMessage.updateMany({
            // Never go back from "read" to "delivered" if callbacks arrive out of order.
            // (explicit null check: SQL NOT on a NULL column matches nothing)
            where: { providerRef: s.id, OR: [{ deliveryStatus: null }, { deliveryStatus: { not: 'read' } }] },
            data: {
              deliveryStatus: s.status,
              statusAt: at,
              ...(s.status === 'failed' ? { status: 'FAILED', error } : {}),
            },
          });
          updated += r.count;
        }
      }
    }
    if (updated) this.logger.debug(`WhatsApp statuses applied: ${updated}`);
    return updated;
  }
}

interface WaStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp?: string;
  errors?: { code: number; title?: string; message?: string }[];
}
