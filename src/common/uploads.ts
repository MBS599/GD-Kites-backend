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
  ['image/gif', '.gif'],
]);

/** JPG/PNG/WEBP/GIF only, max 5 MB, random file names (never the client's). */
export const imageUpload: MulterOptions = {
  storage: diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${ALLOWED.get(file.mimetype) ?? ''}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new BadRequestException('Only JPG, PNG, WEBP or GIF images are allowed.'), false);
  },
};

const VIDEO_TYPES = new Map([
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
]);

/** Product videos: MP4/WEBM/MOV, max 50 MB (keep them short: a few seconds to a minute). */
export const VIDEO_MAX_MB = 50;
export const videoUpload: MulterOptions = {
  storage: diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${VIDEO_TYPES.get(file.mimetype) ?? ''}`),
  }),
  limits: { fileSize: VIDEO_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (VIDEO_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new BadRequestException('Only MP4, WEBM or MOV videos are allowed.'), false);
  },
};

export const publicUrl = (base: string, filename: string) => `${base.replace(/\/$/, '')}/uploads/${filename}`;
