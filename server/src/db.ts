import { Prisma, PrismaClient } from '@prisma/client';
import { env } from './env';

export const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });

/** Either the client or a transaction. Services take this so they can run inside a caller's transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;
export { Prisma };
