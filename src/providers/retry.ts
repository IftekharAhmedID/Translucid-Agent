const retryableStatuses = new Set([429, 502, 503, 504]);
const maximumDelayMilliseconds = 5_000;

export function retryDelayMilliseconds(
  retryAfter: string | null,
  attempt: number,
  now = Date.now(),
): number {
  let delay: number | undefined;
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())) {
    delay = Number(retryAfter) * 1_000;
  } else if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) delay = retryAt - now;
  }
  if (delay === undefined || !Number.isFinite(delay)) delay = 250 * (2 ** attempt);
  return Math.max(0, Math.min(maximumDelayMilliseconds, Math.round(delay)));
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  attempts = 3,
  onAttempt?: (attempt: number) => void,
): Promise<Response> {
  const maximumAttempts = Math.max(1, attempts);
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    onAttempt?.(attempt + 1);
    try {
      const response = await fetch(url, init);
      if (!retryableStatuses.has(response.status) || attempt === maximumAttempts - 1) return response;
      const delay = retryDelayMilliseconds(response.headers.get("retry-after"), attempt);
      await response.body?.cancel().catch(() => undefined);
      await wait(delay, init.signal ?? undefined);
    } catch (error) {
      if (init.signal?.aborted || attempt === maximumAttempts - 1) throw error;
      await wait(retryDelayMilliseconds(null, attempt), init.signal ?? undefined);
    }
  }
  throw new Error("Provider request exhausted its retry attempts.");
}
