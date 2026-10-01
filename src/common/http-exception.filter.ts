import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  422: 'unprocessable',
  429: 'too_many_requests',
};

/**
 * Every error leaves the API as `{ error: { code, message, details? } }`.
 * `message` is always safe to show to end users.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, message, details, code } = this.describe(exception);
    res.status(status).json({ error: { code: code ?? CODES[status] ?? 'error', message, details } });
  }

  private describe(e: unknown): { status: number; message: string; details?: unknown; code?: string } {
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const body = e.getResponse();
      if (typeof body === 'object' && body !== null) {
        const msg = (body as { message?: unknown }).message;
        if (Array.isArray(msg)) {
          // class-validator: first message for users, full list as details.
          return { status, message: String(msg[0] ?? 'Invalid request.'), details: msg };
        }
        // Services may attach a machine-readable `code` (e.g. name_required) and `details`.
        const { code, details } = body as { code?: unknown; details?: unknown };
        if (typeof msg === 'string') {
          return { status, message: msg, details, code: typeof code === 'string' ? code : undefined };
        }
      }
      return { status, message: e.message };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2025') return { status: 404, message: 'Resource not found.' };
      if (e.code === 'P2002') return { status: 409, message: 'A record with these details already exists.' };
      if (e.code === 'P2003') return { status: 409, message: 'This record is referenced by other data.' };
    }
    this.logger.error(e instanceof Error ? e.stack : String(e));
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Something went wrong. Please try again.' };
  }
}
