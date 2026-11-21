import { z } from 'zod';
import { isValidYmd } from './time';

/** Parses a body or query with a zod schema. A failure is turned into a 422 by the error handler. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export const zYmd = z.string().refine(isValidYmd, 'Enter a valid date.');
export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter a valid month.');
export const zHhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.');
export const zUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'This id is not valid.');
export const zEmail = z.string().trim().toLowerCase().max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.');
export const zPassword = z.string().min(8, 'Use at least 8 characters.').max(200, 'Use at most 200 characters.');

/** Filters every list endpoint accepts. Each route adds its own on top. */
export const zListQuery = z.object({
  office: z.string().max(60).optional(),
  month: zMonth.optional(),
  status: z.string().max(30).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListQuery = z.infer<typeof zListQuery>;

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number; }
export function pageOf<T>(items: T[], total: number, q: { page: number; pageSize: number }): Page<T> {
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export const skipTake = (q: { page: number; pageSize: number }) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
