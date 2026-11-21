// The terminal listener, driven the way the eSSL terminal drives it.
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdmsApp } from '../src/adms/app';
import { prisma } from '../src/db';
import { setNow } from '../src/lib/time';
import { parseAttlog } from '../src/services/adms';
import { app, PASSWORD, resetDb, signIn, world } from './helpers';

const adms = createAdmsApp();
const term = () => request(adms);
type World = Awaited<ReturnType<typeof world>>;
let w: World;

beforeEach(async () => {
  await resetDb();
  w = await world();
  await prisma.device.create({ data: { serialNumber: 'SN001', officeId: w.o1.id, name: 'Office 1 door' } });
  await prisma.device.create({ data: { serialNumber: 'SN002', officeId: w.o2.id, name: 'Office 2 door' } });
});

const line = (user: string, time: string) => `${user}\t${time}\t0\t1\t0\t0\t0`;
const post = (sn: string, body: string, stamp = '100') => term().post(`/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=${stamp}`).set('Content-Type', 'text/plain').send(body);

describe('handshake', () => {
  it('replies with the exact option block, as text/plain, with no TimeZone line', async () => {
    const res = await term().get('/iclock/cdata?SN=SN001&options=all&pushver=2.4.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.text).toBe([
      'GET OPTION FROM: SN001', 'ATTLOGStamp=0', 'OPERLOGStamp=9999', 'ErrorDelay=30', 'Delay=10',
      'TransTimes=00:00;14:05', 'TransInterval=1', 'TransFlag=TransData AttLog', 'Realtime=1', 'Encrypt=None', '',
    ].join('\n'));
    expect(res.text).not.toMatch(/TimeZone/i);
  });

  it('returns the last stored stamp for that terminal', async () => {
    await post('SN001', line(w.priya.terminalUserId!, '2026-11-23 09:00:10'), '4521');
    expect((await term().get('/iclock/cdata?SN=SN001&options=all')).text).toMatch(/^ATTLOGStamp=4521$/m);
    expect((await term().get('/iclock/cdata?SN=SN002&options=all')).text).toMatch(/^ATTLOGStamp=0$/m);
  });
});

describe('ATTLOG upload', () => {
  it('stores punches as UTC, treating the terminal time as Asia/Kolkata, and replies OK with the count', async () => {
    const body = [line(w.priya.terminalUserId!, '2026-11-23 09:00:10'), line(w.aarav.terminalUserId!, '2026-11-23 00:15:00')].join('\n') + '\n';
    const res = await post('SN001', body);
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK: 2\n');
    const rows = await prisma.rawPunch.findMany({ orderBy: { punchTime: 'asc' } });
    expect(rows.map(r => r.punchTime.toISOString())).toEqual(['2026-11-22T18:45:00.000Z', '2026-11-23T03:30:10.000Z']);
    expect(rows[1]).toMatchObject({ terminalUserId: w.priya.terminalUserId, rawLine: line(w.priya.terminalUserId!, '2026-11-23 09:00:10') });
    expect((await prisma.device.findUniqueOrThrow({ where: { serialNumber: 'SN001' } })).lastAttlogStamp).toBe('100');
  });

  it('skips duplicates when the terminal sends the same punches again', async () => {
    const body = [line('9001', '2026-11-23 09:00:10'), line('9001', '2026-11-23 18:05:00')].join('\r\n');
    expect((await post('SN001', body)).text).toBe('OK: 2\n');
    expect((await post('SN001', body + '\r\n' + line('9001', '2026-11-23 18:06:00'), '101')).text).toBe('OK: 3\n');
    expect(await prisma.rawPunch.count()).toBe(3);
  });

  it('the same user and time on two terminals are two punches', async () => {
    await post('SN001', line('9001', '2026-11-23 09:00:10'));
    await post('SN002', line('9001', '2026-11-23 09:00:10'));
    expect(await prisma.rawPunch.count()).toBe(2);
  });

  it('keeps a punch whose user id has no employee', async () => {
    expect((await post('SN001', line('777', '2026-11-23 09:00:10'))).text).toBe('OK: 1\n');
    expect(await prisma.rawPunch.count({ where: { terminalUserId: '777' } })).toBe(1);
  });

  it('skips lines it cannot read but still acknowledges them', async () => {
    const res = await post('SN001', ['garbage', line('9001', 'not a time'), line('9001', '2026-11-23 09:00:10'), ''].join('\n'));
    expect(res.text).toBe('OK: 3\n');
    expect(await prisma.rawPunch.count()).toBe(1);
  });

  it('never changes a stored punch', async () => {
    await post('SN001', '9001\t2026-11-23 09:00:10\t0\t1\t0\t0\t0');
    await post('SN001', '9001\t2026-11-23 09:00:10\t1\t15\t9\t9\t9');
    expect((await prisma.rawPunch.findFirstOrThrow()).rawLine).toBe('9001\t2026-11-23 09:00:10\t0\t1\t0\t0\t0');
  });

  it('acknowledges any other table and stores nothing', async () => {
    const res = await term().post('/iclock/cdata?SN=SN001&table=OPERLOG&Stamp=5').set('Content-Type', 'text/plain').send('OPLOG 4\t0\t2026-11-23 09:00:00\t0\t0\t0\t0\n');
    expect(res.text).toBe('OK\n');
    expect(await prisma.rawPunch.count()).toBe(0);
    expect((await prisma.device.findUniqueOrThrow({ where: { serialNumber: 'SN001' } })).lastAttlogStamp).toBeNull();
  });
});

describe('other terminal calls', () => {
  it('answers OK to getrequest and devicecmd', async () => {
    expect((await term().get('/iclock/getrequest?SN=SN001')).text).toBe('OK\n');
    expect((await term().post('/iclock/devicecmd?SN=SN001').send('ID=1&Return=0&CMD=INFO')).text).toBe('OK\n');
  });

  it('updates last_seen_at on every request', async () => {
    const seen = async () => (await prisma.device.findUniqueOrThrow({ where: { serialNumber: 'SN001' } })).lastSeenAt?.toISOString();
    expect(await seen()).toBeUndefined();
    setNow('2026-11-23T03:00:00Z'); await term().get('/iclock/cdata?SN=SN001&options=all');
    expect(await seen()).toBe('2026-11-23T03:00:00.000Z');
    setNow('2026-11-23T03:00:10Z'); await term().get('/iclock/getrequest?SN=SN001');
    expect(await seen()).toBe('2026-11-23T03:00:10.000Z');
    setNow('2026-11-23T03:00:20Z'); await post('SN001', line('9001', '2026-11-23 08:30:20'));
    expect(await seen()).toBe('2026-11-23T03:00:20.000Z');
    setNow('2026-11-23T03:00:30Z'); await term().post('/iclock/devicecmd?SN=SN001').send('x');
    expect(await seen()).toBe('2026-11-23T03:00:30.000Z');
  });

  it('an unknown serial gets OK, stores nothing, and is listed as unregistered', async () => {
    expect((await term().get('/iclock/cdata?SN=NEW777&options=all')).status).toBe(200);
    expect((await post('NEW777', line('9001', '2026-11-23 09:00:10'))).text).toBe('OK\n');
    expect((await term().get('/iclock/getrequest?SN=NEW777')).text).toBe('OK\n');
    expect(await prisma.rawPunch.count()).toBe(0);
    expect(await prisma.device.count()).toBe(2);
    expect(await prisma.unregisteredDevice.findUniqueOrThrow({ where: { serialNumber: 'NEW777' } })).toMatchObject({ requestCount: 3 });
  });
});

describe('the two listeners are separate', () => {
  it('no /api route is reachable on the terminal port', async () => {
    for (const path of ['/api/health', '/api/auth/me', '/api/employees', '/', '/login']) expect((await term().get(path)).status).toBe(404);
    expect((await term().post('/api/auth/login').send({ email: w.admin.email, password: 'x' })).status).toBe(404);
  });
  it('the terminal routes are not on the API port', async () => {
    const res = await request(app).get('/iclock/cdata?SN=SN001&options=all');
    expect(res.status).toBe(404);
    expect(res.text ?? '').not.toMatch(/GET OPTION/);
  });
});

describe('parseAttlog', () => {
  it('reads tab separated lines with either line ending', () => {
    const { lines, punches } = parseAttlog('117\t2026-11-23 09:12:27\t0\t15\t0\t0\t0\r\n  \r\n118\t2026-11-23 09:13:00\t0\t1\n');
    expect(lines).toBe(2);
    expect(punches.map(p => [p.terminalUserId, p.punchTime.toISOString()])).toEqual([['117', '2026-11-23T03:42:27.000Z'], ['118', '2026-11-23T03:43:00.000Z']]);
  });
});

describe('app side: terminals, unmatched punches, live board', () => {
  it('a head registers a terminal for their own office only, and it leaves the unregistered list', async () => {
    await term().get('/iclock/cdata?SN=NEW777&options=all');
    const head = await signIn(w.head1.email);
    expect((await head.get('/api/devices/unregistered')).body).toMatchObject([{ serial: 'NEW777', requests: 1 }]);
    // Whatever office the form names, a head registers for their own.
    const made = await head.post('/api/devices').send({ serialNumber: 'NEW777', officeId: w.o2.id, name: 'Back door' });
    expect(made.status).toBe(201); expect(made.body.officeId).toBe(w.o1.id);
    expect((await head.get('/api/devices/unregistered')).body).toEqual([]);
    expect((await head.post('/api/devices').send({ serialNumber: 'NEW777' })).status).toBe(409);
    expect((await head.get('/api/devices')).body.map((d: { serial: string }) => d.serial).sort()).toEqual(['NEW777', 'SN001']);
    expect((await head.get(`/api/devices?office=${w.o2.id}`)).status).toBe(403);
    // Now its punches are stored.
    expect((await post('NEW777', line('9001', '2026-11-23 09:00:10'))).text).toBe('OK: 1\n');
    expect((await (await signIn(w.priya.email)).get('/api/devices')).status).toBe(403);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'Terminal registered' } })).officeId).toBe(w.o1.id);
  });

  it('a head cannot rename or remove another office\'s terminal, and a terminal with punches stays', async () => {
    const head = await signIn(w.head1.email);
    const admin = await signIn(w.admin.email);
    const all = (await admin.get('/api/devices')).body as { id: string; serial: string }[];
    const d1 = all.find(d => d.serial === 'SN001')!; const d2 = all.find(d => d.serial === 'SN002')!;
    expect((await head.patch(`/api/devices/${d2.id}`).send({ name: 'Mine now' })).status).toBe(403);
    expect((await head.delete(`/api/devices/${d2.id}`)).status).toBe(403);
    expect((await head.patch(`/api/devices/${d1.id}`).send({ name: 'Front door' })).status).toBe(204);
    expect((await head.patch(`/api/devices/${d1.id}`).send({ officeId: w.o2.id })).status).toBe(403);
    await post('SN001', line('9001', '2026-11-23 09:00:10'));
    expect((await head.delete(`/api/devices/${d1.id}`)).status).toBe(409);
    expect((await admin.delete(`/api/devices/${d2.id}`)).status).toBe(204);
  });

  it('shows online and offline, last seen and punches today', async () => {
    setNow('2026-11-23T04:00:00Z'); // 9:30 AM office time
    await post('SN001', [line(w.priya.terminalUserId!, '2026-11-23 09:00:10'), line(w.priya.terminalUserId!, '2026-11-22 09:00:10')].join('\n'));
    const head = await signIn(w.head1.email);
    expect((await head.get('/api/devices')).body).toMatchObject([{ serial: 'SN001', officeName: 'Office 1', online: true, lastSeen: '2026-11-23T09:30', punchesToday: 1 }]);
    setNow('2026-11-23T04:06:00Z');
    expect((await head.get('/api/devices')).body[0].online).toBe(false);
    const offices = (await (await signIn(w.admin.email)).get('/api/offices')).body;
    expect(offices[0].terminal).toMatchObject({ serial: 'SN001', online: false });
    expect(offices[1].terminal).toMatchObject({ serial: 'SN002', online: false, lastSeen: null });
  });

  it('lists unmatched punches by the terminal\'s office until the id is given to an employee', async () => {
    await post('SN001', [line('777', '2026-11-23 09:00:10'), line(w.priya.terminalUserId!, '2026-11-23 09:01:00')].join('\n'));
    await post('SN002', line('888', '2026-11-23 09:05:00'));
    const head = await signIn(w.head1.email);
    const mine = await head.get('/api/punches/unmatched');
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0]).toMatchObject({ terminalUserId: '777', at: '2026-11-23T09:00', terminalName: 'Office 1 door', officeName: 'Office 1' });
    expect((await head.get(`/api/punches/unmatched?office=${w.o2.id}`)).status).toBe(403);
    expect((await (await signIn(w.admin.email)).get('/api/punches/unmatched')).body.total).toBe(2);
    // Giving the id to an employee matches the punches that were waiting.
    expect((await head.patch(`/api/employees/${w.aarav.id}`).send({ terminalUserId: '777' })).status).toBe(204);
    expect((await head.get('/api/punches/unmatched')).body.total).toBe(0);
  });

  it('lists the latest punches and flags one made at another office', async () => {
    await post('SN001', line(w.priya.terminalUserId!, '2026-11-23 09:00:10'));
    await post('SN002', line(w.aarav.terminalUserId!, '2026-11-23 10:30:00')); // Office 1's Aarav at Office 2's door
    await post('SN002', line(w.sunita.terminalUserId!, '2026-11-23 09:02:00'));
    const head1 = await signIn(w.head1.email);
    const list = (await head1.get('/api/devices/punches')).body;
    expect(list.items.map((p: { name: string; other: boolean; terminalName: string }) => [p.name, p.other, p.terminalName]))
      .toEqual([['Aarav Mehta', true, 'Office 2 door'], ['Priya Nair', false, 'Office 1 door']]);
    // Office 2's head sees it too: it happened on their terminal.
    const list2 = (await (await signIn(w.head2.email)).get('/api/devices/punches')).body;
    expect(list2.items.map((p: { name: string }) => p.name)).toEqual(['Aarav Mehta', 'Sunita Agarwal']);
  });

  it('builds today\'s board from the punches', async () => {
    setNow('2026-11-23T04:00:00Z'); // Mon 23 Nov, 9:30 AM
    await post('SN001', [line(w.priya.terminalUserId!, '2026-11-23 09:00:59'), line(w.head1.terminalUserId!, '2026-11-23 09:01:00')].join('\n'));
    await post('SN002', line(w.priya.terminalUserId!, '2026-11-23 09:25:00'));
    const board = (await (await signIn(w.head1.email)).get('/api/attendance/today')).body;
    expect(board).toMatchObject({ date: '2026-11-23', time: '09:30', working: true, counts: { total: 3, in: 2, notIn: 1 } });
    const day = (name: string) => board.people.find((p: { name: string }) => p.name === name).day;
    expect(day('Priya Nair')).toMatchObject({ status: 'working', inTime: '09:00', outTime: '09:25', late: false, workedMin: 24, otherOffice: 'Office 2', label: 'Last punch 9:25 AM' });
    expect(day('Vikram Singh')).toMatchObject({ status: 'working', inTime: '09:01', outTime: null, late: true, label: 'In since 9:01 AM' });
    expect(day('Aarav Mehta')).toMatchObject({ status: 'not_in', late: true });
    expect(board.offices).toMatchObject([{ name: 'Office 1', headcount: 3, terminal: { serial: 'SN001', online: true, punchesToday: 2 } }]);
    setNow('2026-11-22T04:00:00Z'); // Sunday
    expect((await (await signIn(w.head1.email)).get('/api/attendance/today')).body).toMatchObject({ working: false, dayLabel: 'Weekly off', counts: { total: 0 } });
  });
});

describe('live stream (Server-Sent Events)', () => {
  let server: ReturnType<typeof app.listen>;
  let controllers: AbortController[] = [];
  beforeEach(async () => { server = app.listen(0); await new Promise(r => server.once('listening', r)); });
  afterEach(async () => { controllers.forEach(c => c.abort()); controllers = []; await new Promise(r => server.close(r)); });

  /** Opens /api/live as `email` and collects the events it receives. */
  async function listen(email: string, query = '') {
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const ac = new AbortController(); controllers.push(ac);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/live${query}`, { headers: { Cookie: cookie }, signal: ac.signal });
    const events: { event: string; data: Record<string, unknown> }[] = [];
    if (res.ok && res.body) {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const event = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
              if (event) events.push({ event, data: data ? JSON.parse(data) : {} });
            }
          }
        } catch { /* aborted at the end of the test */ }
      })();
    }
    return { status: res.status, type: res.headers.get('content-type'), events };
  }
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 20)); };

  it('pushes a punch to the offices it concerns and to nobody else', async () => {
    const h1 = await listen(w.head1.email);
    const h2 = await listen(w.head2.email);
    const admin = await listen(w.admin.email);
    expect(h1.status).toBe(200); expect(h1.type).toMatch(/text\/event-stream/);
    await until(() => [h1, h2, admin].every(s => s.events.some(e => e.event === 'ready')));

    await post('SN001', line(w.priya.terminalUserId!, '2026-11-23 09:00:10'));
    await until(() => h1.events.length >= 2 && admin.events.length >= 2);
    expect(h1.events[1]).toMatchObject({ event: 'punch', data: { employeeId: w.priya.id, name: 'Priya Nair', date: '2026-11-23', time: '09:00', matched: true, otherOffice: false } });
    expect(admin.events[1]).toMatchObject({ event: 'punch', data: { employeeId: w.priya.id } });
    await new Promise(r => setTimeout(r, 100));
    expect(h2.events.map(e => e.event)).toEqual(['ready']); // Office 2 hears nothing about Office 1

    // Office 1's Aarav punches at Office 2: both offices hear it.
    await post('SN002', line(w.aarav.terminalUserId!, '2026-11-23 10:30:00'));
    await until(() => h2.events.length >= 2 && h1.events.length >= 3);
    expect(h2.events[1]).toMatchObject({ event: 'punch', data: { name: 'Aarav Mehta', otherOffice: true } });
    expect(h1.events[2]).toMatchObject({ event: 'punch', data: { name: 'Aarav Mehta', otherOffice: true } });

    // A duplicate upload stores nothing and announces nothing.
    await post('SN001', line(w.priya.terminalUserId!, '2026-11-23 09:00:10'));
    await new Promise(r => setTimeout(r, 100));
    expect(h1.events).toHaveLength(3);
  });

  it('refuses an employee, a signed-out caller and a head asking for another office', async () => {
    expect((await listen(w.priya.email)).status).toBe(403);
    expect((await listen(w.head1.email, `?office=${w.o2.id}`)).status).toBe(403);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/live`);
    expect(res.status).toBe(401);
  });
});
