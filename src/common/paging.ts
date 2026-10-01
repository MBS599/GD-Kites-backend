import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Keyset ("load more") pagination. Pass `limit` to page; pass the previous
 * response's `nextCursor` as `cursor` for the next page. Stable while new rows
 * arrive, unlike offsets.
 */
export class PageQuery {
  /** Id of the last item of the previous page. */
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** Prisma args for one page: fetch one extra row to know whether more exist. */
export function pageArgs(q: PageQuery, defaultLimit?: number) {
  const limit = q.limit ?? defaultLimit;
  if (limit === undefined) return { limit: undefined, args: {} };
  return {
    limit,
    args: { take: limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) },
  };
}

export function toPage<T extends { id: string }>(rows: T[], limit: number | undefined) {
  if (limit === undefined || rows.length <= limit) return { items: rows, nextCursor: null as string | null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: items[items.length - 1].id };
}
