import argon2 from 'argon2';

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

// Verified when the email is unknown, so a wrong email takes as long as a wrong password.
let dummy: Promise<string> | null = null;

export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash) {
    dummy ??= hashPassword('not-a-real-password');
    await argon2.verify(await dummy, password).catch(() => false);
    return false;
  }
  return argon2.verify(hash, password).catch(() => false);
}
