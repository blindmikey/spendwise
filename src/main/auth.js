/*
 * App-password hashing: node's built-in scrypt, no dependencies. The hash
 * lives in db.json settings.auth so it travels with the data (desktop lock
 * and web login share one password). Threat model is casual privacy - anyone
 * with filesystem access to db.json can read the data regardless.
 */
'use strict';

import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

export function hashPassword (password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT);
    return { v: 1, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function verifyPassword (password, auth) {
    if (!auth || !auth.salt || !auth.hash) return false;
    try {
        const hash = crypto.scryptSync(String(password), Buffer.from(auth.salt, 'hex'), KEYLEN, SCRYPT);
        const expected = Buffer.from(auth.hash, 'hex');
        return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
    } catch {
        return false;
    }
}
