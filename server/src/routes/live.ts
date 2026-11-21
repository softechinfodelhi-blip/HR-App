// The Server-Sent Events stream that tells the live board when to refresh.
import { Router } from 'express';
import { subscribe } from '../lib/live';
import { officeScope, requireManager, scopeWhere } from '../middleware/auth';

const HEARTBEAT_MS = 25_000;
/** The stream is closed after this long. The browser reconnects by itself and the session is checked again. */
const MAX_STREAM_MS = 60 * 60 * 1000;

export function liveRoutes(): Router {
  const r = Router();

  /**
   * GET /live?office=  text/event-stream. Events: `punch`, `device`, `day`.
   * Only events of the offices in the caller's scope are sent.
   */
  r.get('/', requireManager, officeScope, (req, res) => {
    const scope = scopeWhere(req).officeId ?? null;
    res.status(200).set({
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tells proxies not to hold the stream back
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    res.write(`event: ready\ndata: {}\n\n`);

    const stop = subscribe(e => {
      if (scope && !e.officeIds.includes(scope)) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    });
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const end = setTimeout(() => res.end(), MAX_STREAM_MS);
    req.on('close', () => { stop(); clearInterval(beat); clearTimeout(end); });
  });

  return r;
}
