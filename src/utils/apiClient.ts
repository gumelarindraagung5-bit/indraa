export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, errorMessage: string) => void;
}

export async function fetchWithRetry<T>(
  url: string,
  init: RequestInit,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1200;

  let lastError: Error = new Error('Gagal menghubungi server.');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message =
          (data as { error?: string })?.error ||
          `Server mengembalikan kesalahan (HTTP ${response.status}).`;

        // Retry only on transient rate-limit or 5xx server failures
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxRetries) {
          const delayMs = baseDelayMs * Math.pow(2, attempt);
          options.onRetry?.(attempt + 1, delayMs, message);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw new Error(message);
      }

      return data as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isNetworkError =
        lastError.name === 'TypeError' || lastError.message.toLowerCase().includes('network');

      if (isNetworkError && attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        options.onRetry?.(attempt + 1, delayMs, lastError.message);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
}
