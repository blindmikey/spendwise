import { describe, it, expect } from 'vitest';
import { parseSetupInput, accessParts, claimAccessUrl, fetchAccounts, toLedgerBatches } from '../src/main/simplefin.js';

const ACCESS = 'https://u%40x:p%23w@bridge.example.com/simplefin';

describe('parseSetupInput', () => {
    it('accepts an access URL, a claim URL, and a base64 setup token', () => {
        expect(parseSetupInput('https://user:pass@host/simplefin')).toEqual({ kind: 'access', url: 'https://user:pass@host/simplefin' });
        expect(parseSetupInput('https://host/simplefin/claim/abc')).toEqual({ kind: 'claim', url: 'https://host/simplefin/claim/abc' });
        const token = Buffer.from('https://host/simplefin/claim/abc').toString('base64');
        expect(parseSetupInput('  ' + token + '  ')).toEqual({ kind: 'claim', url: 'https://host/simplefin/claim/abc' });
    });

    it('rejects junk and empty input', () => {
        expect(() => parseSetupInput('')).toThrow(/setup token/i);
        expect(() => parseSetupInput('not a token !!!')).toThrow(/doesn't look like/i);
    });
});

describe('accessParts', () => {
    it('lifts (url-encoded) credentials out of the URL into a Basic header', () => {
        const { base, headers } = accessParts(ACCESS);
        expect(base).toBe('https://bridge.example.com/simplefin');
        expect(headers.Authorization).toBe('Basic ' + Buffer.from('u@x:p#w').toString('base64'));
    });

    it('rejects an unparsable URL', () => {
        expect(() => accessParts('nope')).toThrow(/invalid/i);
    });
});

describe('claimAccessUrl', () => {
    it('POSTs the claim URL and returns the access URL body', async () => {
        const calls = [];
        const fetchImpl = async (url, opts) => {
            calls.push([url, opts.method]);
            return { ok: true, text: async () => 'https://a:b@host/simplefin\n' };
        };
        const out = await claimAccessUrl('https://host/claim/t', fetchImpl);
        expect(out).toBe('https://a:b@host/simplefin');
        expect(calls).toEqual([['https://host/claim/t', 'POST']]);
    });

    it('explains a used/rejected token', async () => {
        const fetchImpl = async () => ({ ok: false, text: async () => 'denied' });
        await expect(claimAccessUrl('https://host/claim/t', fetchImpl)).rejects.toThrow(/single-use/i);
    });
});

describe('fetchAccounts', () => {
    it('sends Basic auth without credentials in the URL, with start-date', async () => {
        let seen;
        const fetchImpl = async (url, opts) => {
            seen = { url, auth: opts.headers.Authorization };
            return { ok: true, status: 200, json: async () => ({ errors: [], accounts: [] }) };
        };
        await fetchAccounts('https://a:b@host/simplefin', { startDate: 1700000000.9, fetchImpl });
        expect(seen.url).toBe('https://host/simplefin/accounts?start-date=1700000000');
        expect(seen.auth).toBe('Basic ' + Buffer.from('a:b').toString('base64'));
    });

    it('maps auth failures and malformed bodies to clear errors', async () => {
        const forbid = async () => ({ ok: false, status: 403 });
        await expect(fetchAccounts(ACCESS, { fetchImpl: forbid })).rejects.toThrow(/reconnect/i);
        const junk = async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) });
        await expect(fetchAccounts(ACCESS, { fetchImpl: junk })).rejects.toThrow(/unexpected/i);
    });
});

describe('toLedgerBatches', () => {
    const accounts = [{
        id: 'ACT-1',
        name: 'Checking',
        org: { name: 'Demo Bank' },
        transactions: [
            { id: 't1', posted: 1760000000, amount: '-105.50', description: 'Fishing bait', payee: "John's Fishin Shack" },
            { id: 't2', posted: 1760086400, amount: '2000.00', description: 'Payroll' },
            { id: 't3', posted: 1760172800, amount: '-9.99', description: 'Pending thing', pending: true },
            { id: 't4', posted: 0, amount: 'garbage', description: 'Broken' },
            { id: 't5', amount: '-1.00', memo: 'MEMO ONLY' },
        ],
    }];

    it('skips pending and unparsable rows, flips sign, fingerprints by bank id', () => {
        const [b] = toLedgerBatches(accounts);
        expect(b.sfinId).toBe('ACT-1');
        expect(b.label).toBe('Demo Bank Checking');
        expect(b.items.map((i) => i.fp)).toEqual(['sf:t1', 'sf:t2', 'sf:t5']);
        expect(b.items[0]).toMatchObject({ label: "John's Fishin Shack", amount: 105.5 });
        expect(b.items[0].date).toBe(new Date(1760000000 * 1000).toISOString().slice(0, 10));
        expect(b.items[1]).toMatchObject({ label: 'Payroll', amount: -2000 }); // inflow = credit
        expect(b.items[2]).toMatchObject({ label: 'MEMO ONLY', date: null });
    });

    it('does not double the org name when the account name already has it', () => {
        const [b] = toLedgerBatches([{ id: 'x', name: 'Demo Bank Savings', org: { name: 'Demo Bank' }, transactions: [] }]);
        expect(b.label).toBe('Demo Bank Savings');
    });
});
