// Console → API client. In production the bearer token comes from Supabase Auth;
// in dev-bypass mode the headers name the seed tenant directly.
"use client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3100";
const DEV_TENANT = process.env.NEXT_PUBLIC_DEV_TENANT_ID ?? "00000000-0000-4000-8000-000000000001";

export function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("finnor_token") : null;
  if (token) return { Authorization: `Bearer ${token}` };
  // Dev bypass (API must run with AUTH_DEV_BYPASS=1)
  return { "x-tenant-id": DEV_TENANT, "x-user-role": "owner" };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export async function downloadArtifact(documentId: string, versionId: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/documents/${encodeURIComponent(documentId)}?versionId=${encodeURIComponent(versionId)}`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `artifact-${versionId}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export async function allPendingActions<T>(filter: "pending" | "blocked" = "pending"): Promise<{ actions: T[]; complete: true }> {
  const actions: T[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const params = new URLSearchParams({ filter, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const response = await api<{
      actions: T[];
      page?: { hasMore: boolean; nextCursor: string | null };
    }>(`/api/actions/pending?${params.toString()}`);
    actions.push(...response.actions);
    if (!response.page) {
      if (response.actions.length >= 100) throw new Error("Pending approval response did not prove completeness");
      return { actions, complete: true };
    }
    if (!response.page.hasMore) return { actions, complete: true };
    if (!response.page.nextCursor || response.page.nextCursor === cursor) throw new Error("Pending approval pagination did not advance");
    cursor = response.page.nextCursor;
  }
  throw new Error("Pending approval pagination exceeded its safety bound");
}
