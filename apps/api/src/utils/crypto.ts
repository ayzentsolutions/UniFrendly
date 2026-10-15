import { createHash, randomBytes, randomUUID } from 'node:crypto';
export const newOpaqueToken = () => randomBytes(48).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newClientId = () => randomUUID();
export const safeEqualHex = (a: string, b: string) => a.length === b.length && createHash('sha256').update(a).digest('hex') === createHash('sha256').update(b).digest('hex');
