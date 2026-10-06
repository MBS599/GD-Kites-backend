import { randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import sharp from 'sharp';

/** Widths the apps may ask for (keeps the resize cache small and predictable). */
export const RESIZE_WIDTHS = [200, 400, 800, 1200] as const;

/** Upload names are always `<uuid>.<ext>` (see uploads.ts); anything else is left to the static handler. */
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/**
 * `GET /uploads/<file>?w=400` → the photo scaled down to 400 px wide (WebP),
 * made once and kept in `<uploads>/.resized/`. Lists and grids load these
 * instead of the original phone photo (often several MB), so scrolling stays
 * smooth. Without `w` (or with an unsupported width) the original is served.
 */
export function resizedUploads(uploadDir: string) {
  const cacheDir = join(uploadDir, '.resized');
  return async (req: Request, res: Response, next: NextFunction) => {
    const width = Number(req.query.w);
    const name = req.path.replace(/^\//, '');
    if (!(RESIZE_WIDTHS as readonly number[]).includes(width) || !NAME.test(name)) return next();

    const source = join(uploadDir, name);
    const target = join(cacheDir, `${name}-${width}.webp`);
    try {
      await stat(target);
    } catch {
      try {
        await stat(source);
      } catch {
        return next(); // no such upload → the static handler answers 404
      }
      // Unique temp file, then rename: two requests at once never serve a half-written image.
      const tmp = `${target}.${randomUUID()}.tmp`;
      try {
        await mkdir(cacheDir, { recursive: true });
        await sharp(source)
          .rotate() // respect the phone's EXIF orientation
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 78 })
          .toFile(tmp);
        await rename(tmp, target);
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        return next(e);
      }
    }
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.type('image/webp');
    // The cache folder starts with a dot, which sendFile refuses by default; the path is ours, not the client's.
    res.sendFile(target, { dotfiles: 'allow' });
  };
}
