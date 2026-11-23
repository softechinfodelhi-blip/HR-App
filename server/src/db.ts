import { Prisma, PrismaClient } from '@prisma/client';
import { env } from './env';

// Prisma's default interactive transaction timeout (5 s) is too short when the database is far away
// (each query is a full network round trip), so a multi-step write like adding an employee can expire.
export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  transactionOptions: { timeout: 20_000, maxWait: 10_000 },
});

/** Either the client or a transaction. Services take this so they can run inside a caller's transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;
export { Prisma };
