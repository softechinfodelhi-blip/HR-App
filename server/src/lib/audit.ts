import type { Db } from '../db';
import { Prisma } from '../db';
import type { Actor } from '../services/permissions';

export interface AuditInput {
  action: string; // short, shown as the title: 'Salary changed'
  entity: string; // table-like name: 'employee', 'salary', 'office'
  entityId?: string | null;
  officeId?: string | null;
  /** One line for the audit screen. Never put a salary amount here. */
  detail?: string;
  old?: unknown;
  new?: unknown;
  /** old/new hold salary amounts. Only the admin is shown those values. */
  sensitive?: boolean;
}

const json = (v: unknown) => (v === undefined || v === null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

/** Every mutation calls this inside its own transaction. `actor` is null for scheduled jobs. */
export async function audit(db: Db, actor: Actor | null, a: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: actor?.userId ?? null, actorName: actor?.name ?? 'System', officeId: a.officeId ?? null,
      action: a.action, entity: a.entity, entityId: a.entityId ?? null, detail: a.detail ?? '',
      oldValue: json(a.old), newValue: json(a.new), sensitive: a.sensitive ?? false,
    },
  });
}

/** The fields that differ between two flat objects, as { old, new }. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): { old: Partial<T>; new: Partial<T>; changed: string[] } {
  const o: Partial<T> = {}; const n: Partial<T> = {}; const changed: string[] = [];
  for (const k of Object.keys(after) as (keyof T)[]) {
    if (after[k] === undefined || String(before[k]) === String(after[k])) continue;
    o[k] = before[k]; n[k] = after[k]; changed.push(String(k));
  }
  return { old: o, new: n, changed };
}
