import { describe, it, expect, afterEach } from 'vitest';
import { createWebServer } from '../src/main/webserver.js';

// createWebServer only touches ctx.db lazily (per request), so a stub is fine
// for exercising client-IP resolution.
const stubCtx = () => ({ db: { data: { settings: {} } }, dbPath: '/tmp/db.json' });
const stubCore = {};

const req = (xff, socketIp = '10.0.0.9') => ({
    headers: xff === null ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: socketIp },
});

describe('webserver client IP (rate-limit bucket)', () => {
    it('ignores X-Forwarded-For when no proxy is trusted', () => {
        // otherwise anyone could send a random XFF per request and never lock out
        const web = createWebServer(stubCtx(), stubCore);
        expect(web._clientIp(req('1.2.3.4'))).toBe('10.0.0.9');
        expect(web._clientIp(req(null))).toBe('10.0.0.9');
    });

    it('trustProxy: 1 takes the rightmost entry — the IP the proxy saw', () => {
        const web = createWebServer(stubCtx(), stubCore, { trustProxy: 1 });
        expect(web._clientIp(req('203.0.113.7'))).toBe('203.0.113.7');
    });

    it('trustProxy: 1 is not fooled by a client-forged X-Forwarded-For', () => {
        // attacker sends "1.2.3.4"; our proxy appends their real IP on the right
        const web = createWebServer(stubCtx(), stubCore, { trustProxy: 1 });
        expect(web._clientIp(req('1.2.3.4, 203.0.113.7'))).toBe('203.0.113.7');
    });

    it('trustProxy: 2 steps back through both trusted hops', () => {
        const web = createWebServer(stubCtx(), stubCore, { trustProxy: 2 });
        expect(web._clientIp(req('203.0.113.7, 172.16.0.2'))).toBe('203.0.113.7');
    });

    it('trustProxy: true means one hop', () => {
        const web = createWebServer(stubCtx(), stubCore, { trustProxy: true });
        expect(web._clientIp(req('1.2.3.4, 203.0.113.7'))).toBe('203.0.113.7');
    });

    it('falls back to the socket when a trusted proxy sends no header', () => {
        const web = createWebServer(stubCtx(), stubCore, { trustProxy: 1 });
        expect(web._clientIp(req(null))).toBe('10.0.0.9');
    });

    it('handles a chain shorter than the trusted hop count without going out of range', () => {
        const web = createWebServer(stubCtx(), stubCore, { trustProxy: 3 });
        expect(web._clientIp(req('203.0.113.7'))).toBe('203.0.113.7');
    });
});

// The desktop app builds the server once at boot with no opts, then configures
// trustProxy when web access is toggled - so start() must apply it, not just
// the constructor. Without this, a desktop server behind a proxy can't be told
// to trust it and one attacker locks out everyone.
describe('webserver start() applies trustProxy (desktop toggle path)', () => {
    let web;
    afterEach(async () => { if (web) await web.stop(); web = null; });

    it('honors a trustProxy passed at start() when none was given at construction', async () => {
        web = createWebServer(stubCtx(), stubCore); // no opts, like the desktop
        expect(web._clientIp(req('1.2.3.4, 203.0.113.7'))).toBe('10.0.0.9'); // hops 0: XFF ignored, socket wins
        await web.start(0, '127.0.0.1', { trustProxy: 1 });
        expect(web._clientIp(req('1.2.3.4, 203.0.113.7'))).toBe('203.0.113.7'); // hops 1
        expect(web.status().trustProxy).toBe(1);
    });

    it('leaves the construction value in place when start() gets no runtime opts', async () => {
        web = createWebServer(stubCtx(), stubCore, { trustProxy: 2 });
        await web.start(0, '127.0.0.1');
        expect(web._clientIp(req('203.0.113.7, 172.16.0.2'))).toBe('203.0.113.7');
        expect(web.status().trustProxy).toBe(2);
    });
});
