/*
 * Update check against the GitHub Releases API.
 *
 * Privacy: this is the ONLY outbound request the app ever makes, and it is a
 * plain unauthenticated GET of a public URL - no query string, no body, no
 * identifier, nothing about the user or their finances. GitHub sees an IP and
 * a timestamp, the same as opening the releases page in a browser. It is off
 * with one toggle (Settings → updateCheck: false) and silently skipped when
 * offline, so the app still runs with the network unplugged.
 *
 * It runs in the main/server process, never the renderer: one check per
 * install rather than one per open browser tab, and the renderer's CSP does
 * not have to allow an external origin.
 */
'use strict';

const REPO = 'blindmikey/spendwise';
const ENDPOINT = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

const TTL_MS = 24 * 60 * 60 * 1000; // a long-running server checks once a day
const TIMEOUT_MS = 5000;            // never let a hung request stall the UI

/**
 * "v1.2.3" / "1.2.3" / "1.2.3-beta.1" → { parts:[1,2,3], pre:'beta.1'|null }.
 * Returns null for anything unparseable, so a garbage tag can never be read
 * as an update.
 */
export function parseVersion (v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
    if (!m) return null;
    return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
}

/** Is `latest` a newer release than `current`? Unparseable → false (never nag). */
export function isNewer (latest, current) {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a.parts[i] > b.parts[i]) return true;
        if (a.parts[i] < b.parts[i]) return false;
    }
    // same x.y.z: a prerelease is OLDER than its final, and we never offer to
    // "update" someone from a final onto a prerelease
    if (a.pre && !b.pre) return false;
    if (!a.pre && b.pre) return true;
    return false;
}

/**
 * `fetchImpl` / `now` are injectable so tests never touch the network.
 */
export function createUpdateChecker ({ currentVersion, fetchImpl, now } = {}) {
    const doFetch = fetchImpl || globalThis.fetch;
    const clock = now || (() => Date.now());
    let cache = null; // { at, result }

    async function fetchLatest () {
        // AbortSignal.timeout needs node 17.3+; we support 18+
        const res = await doFetch(ENDPOINT, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'spendwise' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
        const body = await res.json();
        const tag = body && (body.tag_name || body.name);
        if (!parseVersion(tag)) throw new Error('No usable release tag');
        return { tag: String(tag), url: (body && body.html_url) || RELEASES_URL };
    }

    return {
        /** `force` bypasses the cache (the Settings "Check now" button). */
        async check ({ force = false } = {}) {
            if (!force && cache && clock() - cache.at < TTL_MS) return cache.result;

            const base = { current: currentVersion || '', checkedAt: clock() };
            let result;
            try {
                const { tag, url } = await fetchLatest();
                result = {
                    ...base,
                    latest: tag,
                    url,
                    available: isNewer(tag, currentVersion),
                };
            } catch (err) {
                // offline, rate-limited, no releases yet, DNS blocked: all the
                // same non-event. Never surfaced as an error the user must act
                // on - the app does not need GitHub to work.
                result = { ...base, latest: null, url: RELEASES_URL, available: false, unreachable: true };
            }
            cache = { at: clock(), result };
            return result;
        },
    };
}

export { RELEASES_URL };
