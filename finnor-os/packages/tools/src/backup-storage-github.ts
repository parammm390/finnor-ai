// A4.T4: GitHub Releases as the $0 backup storage target (Param's call — Cloudflare R2
// is blocked, no card on file; see CENTROPY-CREDENTIALS-LEDGER.md). Plain `fetch` against
// the GitHub REST API, no octokit dependency (hard rule #5: prefer a small hand-roll).
// A dedicated private repo (not finnor-os itself) holds nothing but backup releases, so
// the token this needs is scoped to exactly that repo — least-privilege, unlike the
// overly-broad Cloudflare API token from A1's own credentials episode.
//
// No-ops loudly-logged (never silently) when BACKUP_GITHUB_TOKEN/BACKUP_GITHUB_REPO are
// unset — same "safe until the credential exists" posture as every other optional
// integration in this codebase (Sentry, Axiom, healthchecks.io).

const GITHUB_API = "https://api.github.com";
const TAG_PREFIX = "backup-";

export interface BackupStorageConfig {
  token: string;
  repo: string; // "owner/repo"
}

export function backupStorageConfig(): BackupStorageConfig | null {
  const token = process.env.BACKUP_GITHUB_TOKEN;
  const repo = process.env.BACKUP_GITHUB_REPO;
  if (!token || !repo) return null;
  return { token, repo };
}

function headers(cfg: BackupStorageConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export interface BackupRelease {
  id: number;
  tag: string;
  createdAt: string;
}

/** Real network call — the two integration/unit split (this file has both, cleanly
 *  separable) matches resend.ts's own convention: the allowlist/retention logic is pure
 *  and unit-tested (dlq-triage.ts's own split too); this is the thin wire. */
export async function listBackupReleases(cfg: BackupStorageConfig): Promise<BackupRelease[]> {
  const res = await fetch(`${GITHUB_API}/repos/${cfg.repo}/releases?per_page=100`, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`GitHub releases list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as Array<{ id: number; tag_name: string; created_at: string }>;
  return body.filter((r) => r.tag_name.startsWith(TAG_PREFIX)).map((r) => ({ id: r.id, tag: r.tag_name, createdAt: r.created_at }));
}

export async function deleteBackupRelease(cfg: BackupStorageConfig, releaseId: number): Promise<void> {
  const res = await fetch(`${GITHUB_API}/repos/${cfg.repo}/releases/${releaseId}`, { method: "DELETE", headers: headers(cfg) });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub release delete failed: ${res.status} ${await res.text()}`);
}

export async function uploadBackup(cfg: BackupStorageConfig, tag: string, filename: string, gzipped: Buffer): Promise<{ releaseId: number }> {
  const createRes = await fetch(`${GITHUB_API}/repos/${cfg.repo}/releases`, {
    method: "POST",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: tag, body: "Automated finnor DB backup — see CENTROPY-MAESTRO-PLAN.md A4.T4.", draft: false, prerelease: false }),
  });
  if (!createRes.ok) throw new Error(`GitHub release create failed: ${createRes.status} ${await createRes.text()}`);
  const release = (await createRes.json()) as { id: number; upload_url: string };

  const uploadUrl = release.upload_url.replace("{?name,label}", `?name=${encodeURIComponent(filename)}`);
  const assetRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...headers(cfg), "Content-Type": "application/gzip" },
    body: new Uint8Array(gzipped),
  });
  if (!assetRes.ok) throw new Error(`GitHub asset upload failed: ${assetRes.status} ${await assetRes.text()}`);
  return { releaseId: release.id };
}

export async function downloadLatestBackup(cfg: BackupStorageConfig): Promise<Buffer | null> {
  const releases = await listBackupReleases(cfg);
  if (releases.length === 0) return null;
  const latest = releases.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));

  const assetsRes = await fetch(`${GITHUB_API}/repos/${cfg.repo}/releases/${latest.id}/assets`, { headers: headers(cfg) });
  if (!assetsRes.ok) throw new Error(`GitHub assets list failed: ${assetsRes.status} ${await assetsRes.text()}`);
  const assets = (await assetsRes.json()) as Array<{ id: number; url: string }>;
  const asset = assets[0];
  if (!asset) return null;

  const downloadRes = await fetch(asset.url, { headers: { ...headers(cfg), Accept: "application/octet-stream" } });
  if (!downloadRes.ok) throw new Error(`GitHub asset download failed: ${downloadRes.status} ${await downloadRes.text()}`);
  return Buffer.from(await downloadRes.arrayBuffer());
}

// --- Retention (pure, unit-tested independently of the network calls above) ---

const RETAIN_DAILY = 14;
const RETAIN_WEEKLY = 8;

function isoWeekKey(d: Date): string {
  // ISO week number — good enough as a bucketing key for "one kept backup per week
  // beyond the daily window"; no external date library needed for this.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${weekNo}`;
}

/** 14 most recent daily backups (one per calendar day, newest wins ties) + 8 most
 *  recent weekly backups from OLDER than that window (one per ISO week) are kept;
 *  everything else is marked for deletion. Pure — no network, easy to unit-test with
 *  synthetic release lists across many simulated days. Purely relative ordering (no
 *  "now" needed) — the newest N distinct-day buckets, then the next M distinct-week
 *  buckets, whatever the caller's release list actually contains. */
export function applyRetention(releases: BackupRelease[]): { keep: string[]; deleteIds: number[] } {
  const sorted = [...releases].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  const keep = new Set<string>();
  const dailySeen = new Set<string>();
  const weeklySeen = new Set<string>();
  const keptIds = new Set<number>();

  for (const r of sorted) {
    const created = new Date(r.createdAt);
    const dayKey = created.toISOString().slice(0, 10);
    if (dailySeen.size < RETAIN_DAILY && !dailySeen.has(dayKey)) {
      dailySeen.add(dayKey);
      keep.add(r.tag);
      keptIds.add(r.id);
      continue;
    }
    const weekKey = isoWeekKey(created);
    if (weeklySeen.size < RETAIN_WEEKLY && !weeklySeen.has(weekKey) && !dailySeen.has(dayKey)) {
      weeklySeen.add(weekKey);
      keep.add(r.tag);
      keptIds.add(r.id);
    }
  }

  return { keep: [...keep], deleteIds: sorted.filter((r) => !keptIds.has(r.id)).map((r) => r.id) };
}
