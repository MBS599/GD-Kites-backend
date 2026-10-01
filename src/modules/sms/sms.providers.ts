import type { SmsEvent } from './sms.templates';
import { WA_TEMPLATES } from './whatsapp.templates';
import { NotOnWhatsAppError, WebNotReadyError, type WhatsAppWebSession } from './whatsapp-web.session';

/** One message to one person. */
export interface SmsRequest {
  /** Which message this is (WhatsApp picks the approved template by event). */
  event: SmsEvent;
  /** 12-digit Indian number without "+", e.g. 919822011122. */
  to: string;
  vars: string[];
  /** Rendered text (development log / audit log). */
  text: string;
}

/** A messaging channel: WhatsApp in production, the server log in development. */
export interface SmsProvider {
  readonly name: string;
  send(req: SmsRequest): Promise<{ ref?: string }>;
}

export class SmsProviderError extends Error {
  constructor(
    message: string,
    /** Worth retrying (network / 5xx / rate limit), vs. a permanent rejection. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 10_000;

/** Development / tests: nothing leaves the server; the text is only logged. */
export class LogSmsProvider implements SmsProvider {
  readonly name = 'log';
  constructor(private readonly log: (line: string) => void) {}
  async send(req: SmsRequest) {
    this.log(`Message to ${req.to}: ${req.text}`);
    return {};
  }
}

/**
 * WhatsApp Cloud API (Meta, direct — no reseller fee). Sends the event's
 * approved template with its parameters. Authentication templates (sign-in
 * code) also carry the code for the "Copy code" button.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 */
export class WhatsAppProvider implements SmsProvider {
  readonly name = 'whatsapp';
  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
    private readonly language = 'en',
    private readonly apiVersion = 'v22.0',
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  async send(req: SmsRequest) {
    const t = WA_TEMPLATES[req.event];
    const params = t.params(req.vars);
    const components: unknown[] = [];
    if (params.length) components.push({ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) });
    if (t.category === 'AUTHENTICATION') {
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: params[0] }] });
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${this.apiVersion}/${this.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: req.to,
          type: 'template',
          template: { name: t.name, language: { code: this.language }, components },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new SmsProviderError(`network: ${String(e)}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number };
    };
    if (!res.ok || json.error) {
      const code = json.error?.code;
      throw new SmsProviderError(
        `whatsapp ${res.status}${code ? ` (${code})` : ''}: ${json.error?.message ?? 'rejected'}`,
        // 130429 = throughput limit, 131000 = unknown/temporary.
        res.status >= 500 || res.status === 429 || code === 130429 || code === 131000,
      );
    }
    return { ref: json.messages?.[0]?.id };
  }
}

/**
 * WhatsApp through a phone linked to whatsapp-web.js (unofficial, free).
 * Sends the plain message text; no Meta templates needed.
 */
export class WhatsAppWebProvider implements SmsProvider {
  readonly name = 'wwebjs';
  constructor(private readonly session: WhatsAppWebSession) {}

  async send(req: SmsRequest) {
    try {
      return { ref: await this.session.send(req.to, req.text) };
    } catch (e) {
      // Not linked / not on WhatsApp: retrying won't help. Anything else (browser hiccup) might.
      const permanent = e instanceof WebNotReadyError || e instanceof NotOnWhatsAppError;
      throw new SmsProviderError(`whatsapp-web: ${e instanceof Error ? e.message : String(e)}`, !permanent);
    }
  }
}
