import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit, diff } from '../lib/audit';
import { parse } from '../lib/validate';
import { actorOf, requireAdmin, requireAuth } from '../middleware/auth';
import { getSettings, saveSettings } from '../services/settings';

const zQuota = z.coerce.number().min(0, 'A quota cannot be negative.').max(365).multipleOf(0.5, 'Use whole or half days.');
const zPatch = z.object({
  companyName: z.string().trim().min(1, 'Company name cannot be empty.').max(120).optional(),
  defaultClQuota: zQuota.optional(),
  defaultPlQuota: zQuota.optional(),
  plCarryMax: z.coerce.number().min(0).max(365).optional(),
  escalateAfterWorkingDays: z.coerce.number().int().min(1, 'Use at least 1 working day.').max(30).optional(),
  // leaveYearStart is fixed at January. It is stored and shown, not editable.
}).strict();

export function settingsRoutes(): Router {
  const r = Router();

  /** GET /settings  Everyone signed in may read these (company name on payslips, default quotas on the add form). */
  r.get('/', requireAuth, async (_req, res) => { res.json(await getSettings(prisma)); });

  /** PATCH /settings  Admin only. */
  r.patch('/', requireAdmin, async (req, res) => {
    const a = actorOf(req);
    const patch = parse(zPatch, req.body);
    const out = await prisma.$transaction(async tx => {
      const before = await getSettings(tx);
      const d = diff(before as unknown as Record<string, unknown>, patch);
      if (d.changed.length) {
        await saveSettings(tx, d.new);
        await audit(tx, a, { action: 'Settings changed', entity: 'settings', detail: d.changed.map(k => `${k}: ${String(d.new[k])}`).join(', '), old: d.old, new: d.new });
      }
      return getSettings(tx);
    });
    res.json(out);
  });

  return r;
}
