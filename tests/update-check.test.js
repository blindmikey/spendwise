import { describe, it, expect } from 'vitest';
import { parseVersion, isNewer, createUpdateChecker } from '../src/main/update-check.js';

describe('parseVersion', () => {
    it('accepts a bare or v-prefixed tag', () => {
        expect(parseVersion('1.2.3').parts).toEqual([1, 2, 3]);
        expect(parseVersion('v1.2.3').parts).toEqual([1, 2, 3]);
        expect(parseVersion('  v1.2.3  ').parts).toEqual([1, 2, 3]);
    });

    it('captures a prerelease suffix', () => {
        expect(parseVersion('1.2.3-beta.1').pre).toBe('beta.1');
        expect(parseVersion('1.2.3').pre).toBeNull();
    });

    it('rejects junk rather than guessing', () => {
        for (const bad of ['', null, undefined, 'latest', '1.2', 'v1.2.3.4', 'release-2', 'x.y.z']) {
            expect(parseVersion(bad)).toBeNull();
        }
    });
});

describe('isNewer', () => {
    it('compares each segment numerically, not as a string', () => {
        expect(isNewer('1.10.0', '1.9.0')).toBe(true);   // "1.10" < "1.9" as strings
        expect(isNewer('1.9.0', '1.10.0')).toBe(false);
        expect(isNewer('2.0.0', '1.99.99')).toBe(true);
        expect(isNewer('1.0.10', '1.0.9')).toBe(true);
    });

    it('is false for the same version', () => {
        expect(isNewer('1.2.3', '1.2.3')).toBe(false);
        expect(isNewer('v1.2.3', '1.2.3')).toBe(false);
    });

    it('is false for an older tag', () => {
        expect(isNewer('1.0.0', '1.0.1')).toBe(false);
    });

    it('treats a prerelease as older than its final', () => {
        expect(isNewer('1.2.3-beta.1', '1.2.3')).toBe(false); // never downgrade
        expect(isNewer('1.2.3', '1.2.3-beta.1')).toBe(true);  // beta → final is an update
    });

    it('never nags on an unparseable version', () => {
        expect(isNewer('garbage', '1.0.0')).toBe(false);
        expect(isNewer('1.0.1', 'garbage')).toBe(false);
        expect(isNewer(null, '1.0.0')).toBe(false);
    });
});

// ------------------------------------------------------------------ checker

const release = (tag) => ({
    ok: true,
    json: async () => ({ tag_name: tag, html_url: `https://github.com/blindmikey/spendwise/releases/tag/${tag}` }),
});

describe('createUpdateChecker', () => {
    it('reports an available update', async () => {
        const c = createUpdateChecker({ currentVersion: '1.0.0', fetchImpl: async () => release('v1.1.0') });
        const r = await c.check();
        expect(r.available).toBe(true);
        expect(r.latest).toBe('v1.1.0');
        expect(r.url).toContain('/releases/tag/v1.1.0');
    });

    it('reports no update when current', async () => {
        const c = createUpdateChecker({ currentVersion: '1.1.0', fetchImpl: async () => release('v1.1.0') });
        expect((await c.check()).available).toBe(false);
    });

    it('never reports an update when the app is AHEAD of the latest release', async () => {
        const c = createUpdateChecker({ currentVersion: '2.0.0', fetchImpl: async () => release('v1.1.0') });
        expect((await c.check()).available).toBe(false);
    });

    it('swallows a network failure - offline is not an error', async () => {
        const c = createUpdateChecker({
            currentVersion: '1.0.0',
            fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
        });
        const r = await c.check();
        expect(r.available).toBe(false);
        expect(r.unreachable).toBe(true);
        expect(r.current).toBe('1.0.0');
    });

    it('swallows a rate-limit / error response', async () => {
        const c = createUpdateChecker({ currentVersion: '1.0.0', fetchImpl: async () => ({ ok: false, status: 403 }) });
        expect((await c.check()).unreachable).toBe(true);
    });

    it('survives a repo with no usable tag', async () => {
        const c = createUpdateChecker({
            currentVersion: '1.0.0',
            fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'nightly' }) }),
        });
        const r = await c.check();
        expect(r.available).toBe(false);
        expect(r.unreachable).toBe(true);
    });

    it('caches so a long-running server does not hammer GitHub', async () => {
        let calls = 0;
        let t = 0;
        const c = createUpdateChecker({
            currentVersion: '1.0.0',
            fetchImpl: async () => { calls++; return release('v1.1.0'); },
            now: () => t,
        });
        await c.check();
        await c.check();
        await c.check();
        expect(calls).toBe(1);

        t += 25 * 60 * 60 * 1000; // a day later
        await c.check();
        expect(calls).toBe(2);
    });

    it('force bypasses the cache (the "Check now" button)', async () => {
        let calls = 0;
        const c = createUpdateChecker({
            currentVersion: '1.0.0',
            fetchImpl: async () => { calls++; return release('v1.1.0'); },
            now: () => 0,
        });
        await c.check();
        await c.check({ force: true });
        expect(calls).toBe(2);
    });

    it('sends no identifying data - just a plain GET', async () => {
        let seen = null;
        const c = createUpdateChecker({
            currentVersion: '1.0.0',
            fetchImpl: async (url, opts) => { seen = { url, opts }; return release('v1.0.0'); },
        });
        await c.check();
        expect(seen.url).toBe('https://api.github.com/repos/blindmikey/spendwise/releases/latest');
        expect(seen.url).not.toContain('?');
        expect(seen.opts.body).toBeUndefined();
        expect(seen.opts.method).toBeUndefined(); // default GET
        expect(Object.keys(seen.opts.headers)).toEqual(['Accept', 'User-Agent']);
    });
});
