"use client";

/** Dev/demo switch: simulate zero data without airplane mode (?offline=1 or the toggle on Home). */
export function isForcedOffline() {
  try {
    return localStorage.getItem("blaze:offline") === "1";
  } catch {
    return false;
  }
}

export function setForcedOffline(on: boolean) {
  try {
    if (on) localStorage.setItem("blaze:offline", "1");
    else localStorage.removeItem("blaze:offline");
    window.dispatchEvent(new Event("blaze:connectivity"));
  } catch {}
}

export class ApiError extends Error {}

/** fetch with a short timeout; throws ApiError("offline") when there is no usable network. */
export async function api<T>(path: string, body?: unknown, timeoutMs = 6000): Promise<T> {
  if (isForcedOffline()) throw new ApiError("offline");
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("offline");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `http_${res.status}`);
  return json as T;
}
