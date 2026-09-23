// Firecrawl adapter for read-only source retrieval. The provider credential is
// intentionally read inside the request path so importing this module, building the
// registry, and constructing a watch service never snapshots a secret at module load.

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { IntegrationError } from "./errors";

export type FreshnessState = "fresh" | "stale" | "unknown" | "unavailable";

export interface WebCitation {
  citationId: string;
  provider: "firecrawl" | "exa";
  url: string;
  title: string;
  retrievedAt: string;
  contentHash?: string;
  changeHash?: string;
  freshness: FreshnessState;
}

export interface WebSourceSnapshot {
  sourceId: string;
  url: string;
  title: string;
  contentHash: string;
  changeHash: string;
  fetchedAt: string;
  freshness: FreshnessState;
  provider: "firecrawl";
  sourceUpdatedAt?: string;
}

export interface FirecrawlScrapeResult {
  provider: "firecrawl";
  url: string;
  title: string;
  content: string;
  excerpt: string;
  citation: WebCitation;
  snapshot: WebSourceSnapshot;
  truncated: boolean;
}

export interface TermsDecision {
  allowed: boolean;
  reason: string;
}

export type TermsPolicy = (url: URL) => TermsDecision | Promise<TermsDecision>;
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

export interface FirecrawlScrapeRequest {
  url: string;
  maxChars?: number;
  allowedDomains?: readonly string[];
  /** A caller-attested approval is required only when requireTermsApproval is true. */
  termsApproved?: boolean;
  termsPolicy?: TermsPolicy;
  requireTermsApproval?: boolean;
}

export interface FirecrawlAdapterOptions {
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
  termsPolicy?: TermsPolicy;
  requireTermsApproval?: boolean;
  respectRobotsTxt?: boolean;
  robotsTtlMs?: number;
  minDomainIntervalMs?: number;
  maxConcurrentPerDomain?: number;
  maxRateLimitWaitMs?: number;
  timeoutMs?: number;
  maxRobotsChars?: number;
  maxResponseChars?: number;
  maxChars?: number;
  now?: () => Date;
  /** Test/local endpoint seam; production defaults to Firecrawl's public API. */
  apiBaseUrl?: string;
}

interface RobotsResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

interface FirecrawlHttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

type HttpFetch = (input: string, init?: RequestInit) => Promise<RobotsResponse & FirecrawlHttpResponse>;

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

interface CachedRobots {
  expiresAt: number;
  groups: RobotsGroup[];
}

const DEFAULT_API_BASE_URL = "https://api.firecrawl.dev/v2";
const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_MAX_RESPONSE_CHARS = 500_000;
const MAX_URL_LENGTH = 2_048;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ROBOTS_TTL_MS = 15 * 60_000;
const DEFAULT_MIN_DOMAIN_INTERVAL_MS = 250;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 5_000;
const DEFAULT_MAX_ROBOTS_CHARS = 100_000;
const FIRECRAWL_USER_AGENT = "Finnor-CENTROPY-Research/1.0";

export class UnsafeWebUrlError extends IntegrationError {
  constructor(message: string) {
    super("firecrawl", message, false, "validation");
    this.name = "UnsafeWebUrlError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A stable change identity for a source; no model-generated summary participates. */
export function hashSourceSnapshot(input: { url: string; title: string; contentHash: string }): string {
  return sha256(JSON.stringify({ url: input.url, title: input.title, contentHash: input.contentHash }));
}

export function sourceIdForUrl(url: string): string {
  return `web:${sha256(url).slice(0, 24)}`;
}

export function citationIdForSnapshot(url: string, changeHash: string): string {
  return `citation:${sha256(`${url}:${changeHash}`).slice(0, 24)}`;
}

export function freshnessFor(observedAt: string | Date | undefined, now = new Date(), maxAgeMs = 24 * 60 * 60_000): FreshnessState {
  if (!observedAt) return "unknown";
  const timestamp = new Date(observedAt).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  return now.getTime() - timestamp <= maxAgeMs ? "fresh" : "stale";
}

function parseDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\.+/, "");
  return normalized.length > 0 && (hostname === normalized || hostname.endsWith(`.${normalized}`));
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    (mappedIpv4 !== undefined && isPrivateIpv4(mappedIpv4))
  );
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isPrivateIpv4(address);
  if (version === 6) return !isPrivateIpv6(address);
  return false;
}

export function normalizeWebUrl(input: string): URL {
  if (typeof input !== "string" || input.trim().length > MAX_URL_LENGTH) {
    throw new UnsafeWebUrlError("URL is missing or exceeds the safety length limit.");
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UnsafeWebUrlError("URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeWebUrlError("Only HTTP and HTTPS URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new UnsafeWebUrlError("URLs with embedded credentials are not allowed.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new UnsafeWebUrlError("Only standard HTTP(S) ports are allowed.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    throw new UnsafeWebUrlError("Private or local hostnames are not allowed.");
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new UnsafeWebUrlError("Private, loopback, link-local, multicast, or reserved IP addresses are not allowed.");
  }
  url.hash = "";
  return url;
}

export async function assertPublicWebHost(url: URL, resolveHost: ResolveHost = defaultResolveHost): Promise<void> {
  if (isIP(url.hostname)) return;
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(url.hostname);
  } catch {
    throw new UnsafeWebUrlError("The source hostname could not be resolved safely.");
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new UnsafeWebUrlError("The source hostname resolves to a private or reserved network.");
  }
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => address.address);
}

function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let hasRule = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0]!.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === "user-agent") {
      if (!current || hasRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        hasRule = false;
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current || !["allow", "disallow"].includes(directive)) continue;
    hasRule = true;
    if (value) current.rules.push({ allow: directive === "allow", path: value });
  }
  return groups;
}

function robotsAllows(groups: RobotsGroup[], url: URL): boolean {
  const matchingGroups = groups.filter((group) => group.agents.includes("*") || group.agents.some((agent) => agent.includes("finnor") || agent.includes("jarvis")));
  const rules = matchingGroups.flatMap((group) => group.rules);
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!url.pathname.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return !best || best.allow;
}

class DomainRateLimiter {
  private readonly nextAvailableAt = new Map<string, number>();
  private readonly active = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxConcurrent: number,
    private readonly maxWaitMs: number,
    private readonly now: () => number,
  ) {}

  async run<T>(domain: string, fn: () => Promise<T>): Promise<T> {
    const startedWaitingAt = this.now();
    while ((this.active.get(domain) ?? 0) >= this.maxConcurrent) {
      if (this.now() - startedWaitingAt > this.maxWaitMs) {
        throw new IntegrationError("firecrawl", `rate limit wait exceeded for ${domain}`, true, "provider_down");
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.maxWaitMs)));
    }
    const next = this.nextAvailableAt.get(domain) ?? 0;
    const waitMs = Math.max(0, next - this.now());
    if (waitMs > this.maxWaitMs) {
      throw new IntegrationError("firecrawl", `rate limit wait exceeded for ${domain}`, true, "provider_down");
    }
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.active.set(domain, (this.active.get(domain) ?? 0) + 1);
    this.nextAvailableAt.set(domain, this.now() + this.minIntervalMs);
    try {
      return await fn();
    } finally {
      const active = (this.active.get(domain) ?? 1) - 1;
      if (active <= 0) this.active.delete(domain);
      else this.active.set(domain, active);
    }
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function responseData(value: unknown): Record<string, unknown> {
  const root = jsonObject(value);
  const nested = jsonObject(root.data);
  return Object.keys(nested).length > 0 ? nested : root;
}

export class FirecrawlAdapter {
  private readonly fetchFn: HttpFetch;
  private readonly resolveHost: ResolveHost;
  private readonly termsPolicy?: TermsPolicy;
  private readonly requireTermsApproval: boolean;
  private readonly respectRobotsTxt: boolean;
  private readonly robotsTtlMs: number;
  private readonly maxRobotsChars: number;
  private readonly maxResponseChars: number;
  private readonly timeoutMs: number;
  private readonly maxChars: number;
  private readonly now: () => Date;
  private readonly apiBaseUrl: string;
  private readonly robotsCache = new Map<string, CachedRobots>();
  private readonly limiter: DomainRateLimiter;

  constructor(options: FirecrawlAdapterOptions = {}) {
    this.fetchFn = (options.fetch ?? globalThis.fetch) as HttpFetch;
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.termsPolicy = options.termsPolicy;
    this.requireTermsApproval = options.requireTermsApproval ?? false;
    this.respectRobotsTxt = options.respectRobotsTxt ?? true;
    this.robotsTtlMs = options.robotsTtlMs ?? DEFAULT_ROBOTS_TTL_MS;
    this.maxRobotsChars = options.maxRobotsChars ?? DEFAULT_MAX_ROBOTS_CHARS;
    this.maxResponseChars = options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.now = options.now ?? (() => new Date());
    this.apiBaseUrl = (options.apiBaseUrl ?? process.env.FIRECRAWL_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    this.limiter = new DomainRateLimiter(
      Math.max(0, options.minDomainIntervalMs ?? DEFAULT_MIN_DOMAIN_INTERVAL_MS),
      Math.max(1, options.maxConcurrentPerDomain ?? 1),
      Math.max(0, options.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS),
      () => Date.now(),
    );
  }

  async scrape(request: FirecrawlScrapeRequest): Promise<FirecrawlScrapeResult> {
    const url = normalizeWebUrl(request.url);
    await assertPublicWebHost(url, this.resolveHost);
    if (request.allowedDomains && !request.allowedDomains.some((domain) => hostMatchesDomain(url.hostname.toLowerCase(), domain))) {
      throw new UnsafeWebUrlError("The source domain is outside the configured research allowlist.");
    }

    const termsPolicy = request.termsPolicy ?? this.termsPolicy;
    const requireTermsApproval = request.requireTermsApproval ?? this.requireTermsApproval;
    if (requireTermsApproval && request.termsApproved !== true && !termsPolicy) {
      throw new IntegrationError("firecrawl", "explicit terms approval is required for this source", false, "needs_human");
    }
    if (termsPolicy) {
      const decision = await termsPolicy(url);
      if (!decision.allowed) throw new IntegrationError("firecrawl", `source rejected by terms policy: ${decision.reason}`, false, "validation");
    }

    return this.limiter.run(url.hostname, async () => {
      if (this.respectRobotsTxt) await this.assertRobotsAllowed(url);
      return this.limiter.run(new URL(this.apiBaseUrl).hostname, () => this.callFirecrawl(url, request.maxChars));
    });
  }

  private async assertRobotsAllowed(url: URL): Promise<void> {
    const origin = url.origin;
    const cached = this.robotsCache.get(origin);
    let groups: RobotsGroup[];
    if (cached && cached.expiresAt > Date.now()) {
      groups = cached.groups;
    } else {
      const response = await this.fetchWithTimeout(`${origin}/robots.txt`, {
        headers: { "user-agent": FIRECRAWL_USER_AGENT, accept: "text/plain" },
        redirect: "error",
      }, "robots");
      if (response.status === 404 || response.status === 410) {
        groups = [];
      } else if (!response.ok) {
        throw new IntegrationError("firecrawl", `robots.txt check failed (${response.status})`, false, "provider_down");
      } else {
        const body = (await response.text()).slice(0, this.maxRobotsChars);
        groups = parseRobots(body);
      }
      this.robotsCache.set(origin, { expiresAt: Date.now() + this.robotsTtlMs, groups });
    }
    if (!robotsAllows(groups, url)) throw new IntegrationError("firecrawl", "source is disallowed by robots.txt", false, "validation");
  }

  private async callFirecrawl(url: URL, requestedMaxChars: number | undefined): Promise<FirecrawlScrapeResult> {
    const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
    if (!apiKey) throw new IntegrationError("firecrawl", "FIRECRAWL_API_KEY is not configured", false, "config");
    const response = await this.fetchWithTimeout(`${this.apiBaseUrl}/scrape`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        url: url.toString(),
        formats: ["markdown"],
        onlyMainContent: true,
      }),
      redirect: "error",
    }, "scrape");
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      const kind = response.status === 401 || response.status === 403 ? "auth" : retryable ? "provider_down" : "terminal";
      throw new IntegrationError("firecrawl", `scrape request failed (${response.status})`, retryable, kind);
    }
    const payload = responseData(await response.json());
    const markdown = typeof payload.markdown === "string" ? normalizeText(payload.markdown) : "";
    if (!markdown) throw new IntegrationError("firecrawl", "scrape returned no readable markdown", false, "provider_down");
    if (markdown.length > this.maxResponseChars) throw new IntegrationError("firecrawl", "scrape response exceeded the configured safety limit", false, "validation");

    const metadata = jsonObject(payload.metadata);
    const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim().slice(0, 500) : url.toString();
    const fetchedAt = this.now().toISOString();
    const sourceUpdatedAt = parseDate(metadata.modifiedTime ?? metadata.lastModified ?? metadata.publishedTime);
    const contentHash = sha256(markdown);
    const changeHash = hashSourceSnapshot({ url: url.toString(), title, contentHash });
    const maxChars = Math.min(Math.max(100, requestedMaxChars ?? this.maxChars), this.maxResponseChars);
    const content = markdown.slice(0, maxChars);
    const snapshot: WebSourceSnapshot = {
      sourceId: sourceIdForUrl(url.toString()),
      url: url.toString(),
      title,
      contentHash,
      changeHash,
      fetchedAt,
      freshness: "fresh",
      provider: "firecrawl",
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    };
    return {
      provider: "firecrawl",
      url: url.toString(),
      title,
      content,
      excerpt: content.slice(0, 320),
      citation: {
        citationId: citationIdForSnapshot(url.toString(), changeHash),
        provider: "firecrawl",
        url: url.toString(),
        title,
        retrievedAt: fetchedAt,
        contentHash,
        changeHash,
        freshness: snapshot.freshness,
      },
      snapshot,
      truncated: content.length < markdown.length,
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit, operation: string): Promise<RobotsResponse & FirecrawlHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch {
      throw new IntegrationError("firecrawl", `${operation} request failed`, true, "provider_down");
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function firecrawlScrape(request: FirecrawlScrapeRequest): Promise<FirecrawlScrapeResult> {
  return new FirecrawlAdapter().scrape(request);
}
