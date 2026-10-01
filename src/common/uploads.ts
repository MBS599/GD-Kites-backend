import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { diskStorage } from 'multer';

export const UPLOAD_DIR = resolve(__dirname, '..', '..', 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

/** JPG/PNG/WEBP only, max 5 MB, random file names (never the client's). */
export const imageUpload: MulterOptions = {
  storage: diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${ALLOWED.get(file.mimetype) ?? ''}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new BadRequestException('Only JPG, PNG or WEBP images are allowed.'), false);
  },
};

export const publicUrl = (base: string, filename: string) => `${base.replace(/\/$/, '')}/uploads/${filename}`;
