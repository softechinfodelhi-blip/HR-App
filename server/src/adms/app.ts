// The terminal listener. It runs on ADMS_PORT and serves ONLY /iclock/*: plain HTTP, plain text, no cookies.
// Nothing under /api exists on this app, so the API cannot be reached through the terminals' port.
import express, { type Express, type Request, type Response } from 'express';
import { handshakeText, ingestAttlog, touchDevice } from '../services/adms';

/** Terminals are fussy about headers, so replies are written by hand: text/plain, no charset, no ETag. */
function reply(res: Response, text: string) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end(text.endsWith('\n') ? text : `${text}\n`);
}
function param(req: Request, name: string): string {
  // Firmware versions differ in the case of parameter names (SN / sn, Stamp / stamp).
  for (const [k, v] of Object.entries(req.query)) if (k.toLowerCase() === name.toLowerCase() && typeof v === 'string') return v.trim();
  return '';
}

export function createAdmsApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  const iclock = express.Router();
  // The terminal does not always send a content type, so every body is read as text.
  iclock.use(express.text({ type: () => true, limit: '5mb' }));

  iclock.all('/*splat', async (req, res) => {
    const path = req.path.toLowerCase();
    const serial = param(req, 'SN').slice(0, 64);
    try {
      const device = await touchDevice(serial, req.socket.remoteAddress);

      // 1. Handshake: the terminal asks for its push options.
      if (req.method === 'GET' && path.startsWith('/cdata')) {
        return reply(res, handshakeText(serial, device?.lastAttlogStamp ?? null));
      }
      // 2. Upload. ATTLOG is the punch table. Every other table is acknowledged and ignored.
      if (req.method === 'POST' && path.startsWith('/cdata')) {
        if (!device || param(req, 'table').toUpperCase() !== 'ATTLOG') return reply(res, 'OK');
        const stamp = param(req, 'Stamp');
        const { lines } = await ingestAttlog(device, typeof req.body === 'string' ? req.body : '', stamp || null);
        return reply(res, `OK: ${lines}`);
      }
      // 3. /getrequest (the terminal asks for commands: we have none), /devicecmd and anything else.
      return reply(res, 'OK');
    } catch (e) {
      // No "OK", so the terminal keeps the data and sends it again after ErrorDelay.
      console.error(`[adms] ${req.method} ${req.path} failed:`, e instanceof Error ? e.message : e);
      res.statusCode = 500; res.setHeader('Content-Type', 'text/plain'); res.end('ERROR\n');
    }
  });

  app.use('/iclock', iclock);
  app.use((_req, res) => { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); res.end('Not found\n'); });
  return app;
}
