/** An error with a status code and a message written for the person using the app. */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function fail(status: number, message: string): never { throw new HttpError(status, message); }
export const notFound = (what = 'This'): never => fail(404, `${what} was not found.`);
