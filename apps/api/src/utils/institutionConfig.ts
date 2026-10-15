/** Parse institution-owned numeric settings defensively before using them in server limits. */
export function readConfigNumber(
  config: Record<string, unknown> | null | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = config?.[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
