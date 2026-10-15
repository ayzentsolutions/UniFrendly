import { z } from 'zod';
export const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().datetime().optional() });
export function cursorFrom(query: { cursor?: string }) {
  if (!query.cursor) return null;
  const parsed = new Date(query.cursor);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
export function nextCursor(rows: Array<{ created_at: Date | string }>, limit: number) {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  return last ? new Date(last.created_at).toISOString() : null;
}
