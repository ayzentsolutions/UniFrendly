import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { unauthorized } from '../utils/errors.js';

const key = new TextEncoder().encode(env.JWT_SECRET);
export type AccessClaims = { sub: string; mid: string; iid: string; role: string; sid: string };
export async function signAccessToken(claims: AccessClaims) {
  return new SignJWT({ mid: claims.mid, iid: claims.iid, role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer('unifrendly-api')
    .setAudience('unifrendly-mobile')
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: 'unifrendly-api', audience: 'unifrendly-mobile' });
    if (typeof payload.sub !== 'string' || typeof payload.mid !== 'string' || typeof payload.iid !== 'string' || typeof payload.role !== 'string' || typeof payload.sid !== 'string') throw new Error('invalid claims');
    return { sub: payload.sub, mid: payload.mid, iid: payload.iid, role: payload.role, sid: payload.sid };
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}
