import { createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../env';

/** A random token for a link or a cookie. Only its hash is stored. */
export const newToken = () => randomBytes(32).toString('base64url');
/** Hash for invite and reset tokens. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** Hash for session ids, keyed with SESSION_SECRET, so a copy of the database alone cannot be turned into a valid cookie. */
export const hashSession = (token: string) => createHmac('sha256', env.SESSION_SECRET).update(token).digest('hex');
