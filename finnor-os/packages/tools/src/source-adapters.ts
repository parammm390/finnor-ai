import type { TenantCredentialContext } from "@finnor/security";
import type {
  BusinessEffectSet,
  CanonicalSourceRecord,
  ProviderObservationSyncPage,
  SourceSyncCursor,
  SourceSyncPage,
} from "@finnor/shared-types";
import { IntegrationError } from "./errors";

export interface SourceAdapterContext {
  tenantId: string;
  integrationId: string;
  config: Readonly<Record<string, unknown>>;
  credentialContext: TenantCredentialContext;
}

export interface SourceAdapter {
  readonly provider: string;
  readonly scopes: readonly string[];
  readPage(scope: string, cursor: SourceSyncCursor, context: SourceAdapterContext): Promise<SourceSyncPage>;
  readObject(objectType: string, externalId: string, context: SourceAdapterContext): Promise<CanonicalSourceRecord | null>;
  observationTarget?(output: Record<string, unknown>, effect: BusinessEffectSet): {
    objectType: string;
    externalId: string;
    expected: Record<string, unknown>;
  } | null;
  isTerminalObservation?(record: CanonicalSourceRecord): boolean;
}

/** Successor boundary for transports whose provider objects may be retained as
 * evidence before any canonical/root mapping exists. Business/vertical packages
 * consume these observations; transport adapters never write domain state. */
export interface ProviderObservationAdapter<TScope, TContext> {
  readonly provider: string;
  readObservationPage(scope: TScope, cursor: SourceSyncCursor, context: TContext): Promise<ProviderObservationSyncPage>;
}

/** Provider transport and business mapping are deliberately separate. The generic
 * registry is retained, but Phase 5 installs no provider-to-business mapper. */
export class SourceAdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    if (!adapter.provider.trim()) throw new Error("source adapter provider is required");
    if (this.adapters.has(adapter.provider)) throw new Error(`source adapter already registered: ${adapter.provider}`);
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  get(provider: string): SourceAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new IntegrationError(provider, "no active source-truth mapping is registered", false, "config");
    return adapter;
  }

  providers(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

/** The active composition is intentionally empty. PE observations enter through the
 * typed @finnor/private-equity evidence boundary; reusable provider transports stay
 * exported from their own modules. */
export function createSourceAdapterRegistry(): SourceAdapterRegistry {
  return new SourceAdapterRegistry();
}
