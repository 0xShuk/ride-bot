// fetch with a timeout, one retry on a timeout or network error, and errors that name the call.

export async function fetchWithTimeout(label: string, url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      const why = timedOut ? `timed out after ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e);
      if (attempt >= 2) throw new Error(`${label}: ${why}`);
      console.warn(`[http] ${label}: ${why}, retrying`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
