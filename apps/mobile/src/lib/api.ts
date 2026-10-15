import * as SecureStore from 'expo-secure-store';

const ACCESS_KEY = 'unifrendly.access.v1';
const REFRESH_KEY = 'unifrendly.refresh.v1';
const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
export const API_BASE_URL = (configured || 'http://localhost:8080/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'REQUEST_FAILED', public readonly fields?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = 'ApiError';
  }
}
export type SessionResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresAt: string;
  user: { id: string; email: string; displayName: string };
  membership: { id: string; institutionId: string; role: string; status: string };
};
export type MeResponse = {
  user: { id: string; email: string; displayName: string };
  membership: {
    membership_id: string; role: string; status: string; institution_id: string; institution_slug: string; institution_name: string;
    department?: string | null; programme?: string | null; batch_year?: number | null; bio?: string;
    interests?: string[]; visibility?: 'private' | 'connections' | 'campus'; discoverable?: boolean; allow_messages?: 'nobody' | 'connections' | 'campus';
    push_enabled?: boolean; notify_messages?: boolean; notify_connections?: boolean; notify_events?: boolean; notify_study?: boolean; notify_marketplace?: boolean; private_message_previews?: boolean;
  };
};

let refreshInFlight: Promise<boolean> | null = null;
async function readAccess() { return SecureStore.getItemAsync(ACCESS_KEY); }
async function readRefresh() { return SecureStore.getItemAsync(REFRESH_KEY); }
export async function saveSession(session: Pick<SessionResponse, 'accessToken' | 'refreshToken'>) {
  await Promise.all([SecureStore.setItemAsync(ACCESS_KEY, session.accessToken), SecureStore.setItemAsync(REFRESH_KEY, session.refreshToken)]);
}
export async function clearSession() {
  await Promise.all([SecureStore.deleteItemAsync(ACCESS_KEY), SecureStore.deleteItemAsync(REFRESH_KEY)]);
}
async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = await readRefresh();
    if (!refreshToken) return false;
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken })
      });
      if (!response.ok) { await clearSession(); return false; }
      const result = await response.json() as { accessToken: string; refreshToken: string };
      await saveSession(result);
      return true;
    } catch {
      // A transient network failure must not destroy a still-valid refresh token.
      return false;
    }
  })();
  try { return await refreshInFlight; } finally { refreshInFlight = null; }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const token = await readAccess();
  const headers = new Headers(options.headers ?? {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body !== undefined && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`, { ...options, headers });
  } catch {
    throw new ApiError(0, 'Could not reach UniFrendly. Check your connection and try again.', 'NETWORK_ERROR');
  }
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refreshSession()) return apiRequest<T>(path, options, false);
    await clearSession();
  }
  const responseData = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; fields?: Array<{ path: string; message: string }> } } & T;
  if (!response.ok) throw new ApiError(response.status, responseData.error?.message ?? `Request failed (${response.status})`, responseData.error?.code, responseData.error?.fields);
  return responseData as T;
}

export async function uploadPrivateFile(args: { purpose: 'post_image' | 'avatar' | 'study_pdf' | 'message_attachment'; uri: string; fileName: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'; sizeBytes: number }) {
  const intent = await apiRequest<{ uploadId: string; url: string; fields: Record<string, string>; finalizePath: string; maxBytes: number }>('/media/upload-intents', {
    method: 'POST', body: JSON.stringify({ fileName: args.fileName, mimeType: args.mimeType, sizeBytes: args.sizeBytes, purpose: args.purpose })
  });
  if (args.sizeBytes > intent.maxBytes) throw new ApiError(413, 'File exceeds the permitted size.', 'FILE_TOO_LARGE');
  const source = await fetch(args.uri);
  const blob = await source.blob();
  if (blob.size > intent.maxBytes) throw new ApiError(413, 'Compressed file still exceeds the permitted size.', 'FILE_TOO_LARGE');
  const form = new FormData();
  for (const [key, value] of Object.entries(intent.fields)) form.append(key, value);
  form.append('file', blob, args.fileName);
  let uploaded: Response;
  try { uploaded = await fetch(intent.url, { method: 'POST', body: form }); }
  catch { throw new ApiError(0, 'Upload interrupted. Start a new upload and try again.', 'UPLOAD_NETWORK_ERROR'); }
  if (!uploaded.ok) throw new ApiError(uploaded.status, 'Private media upload failed. Please retry.', 'UPLOAD_FAILED');
  const finalized = await apiRequest<{ media: { id: string; mime_type: string; byte_size: number; media_kind: string } }>(intent.finalizePath, { method: 'POST', body: JSON.stringify({}) });
  return finalized.media;
}

export async function mediaDownloadUrl(mediaId: string) {
  const result = await apiRequest<{ url: string }>(`/media/${mediaId}/download`);
  return result.url;
}
