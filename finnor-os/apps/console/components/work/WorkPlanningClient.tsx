"use client";

import { useCallback, useRef, useState } from "react";
import type { AttentionItem, AttentionQueueResult } from "@finnor/shared-types";
import { api } from "../../lib/api";
import { usePoll } from "../../lib/use-poll";
import {
  arrayValue,
  attentionItemsInServerOrder,
  recordValue,
  selectedPlanRevision,
  type WorkAggregateView,
  type WorkPlanRevisionView,
  type WorkSummary,
} from "../../lib/work-planning";

interface AttentionQueryEnvelope {
  result: AttentionQueueResult;
  workId: string;
}

interface PlanNodeView {
  id: string;
  kind: string;
  dependsOn: string[];
  supports: string[];
  preconditions: unknown[];
  expectedEffects: unknown[];
  observation: unknown;
  recovery: unknown;
  semanticHash: string | null;
  actionType?: string;
  request?: unknown;
  waitFor?: unknown;
  criterionId?: string;
}

function shortId(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : "—";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function time(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString() : value;
}

function slack(value: number | null): string {
  if (value === null) return "No explicit deadline";
  const absolute = Math.abs(value);
  const hours = Math.floor(absolute / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  const formatted = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${minutes}m`;
  return value < 0 ? `${formatted} overdue` : `${formatted} remaining`;
}

function json(value: unknown): string {
  if (value === null || value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unserializable verified value";
  }
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function planNodes(revision: WorkPlanRevisionView): PlanNodeView[] {
  const graph = recordValue(revision.planGraph);
  return arrayValue(graph.nodes).flatMap((raw) => {
    const node = recordValue(raw);
    if (typeof node.id !== "string" || typeof node.kind !== "string") return [];
    return [{
      id: node.id,
      kind: node.kind,
      dependsOn: arrayValue(node.dependsOn).filter((value): value is string => typeof value === "string"),
      supports: arrayValue(node.supports).filter((value): value is string => typeof value === "string"),
      preconditions: arrayValue(node.preconditions),
      expectedEffects: arrayValue(node.expectedEffects),
      observation: node.observation,
      recovery: node.recovery,
      semanticHash: typeof node.semanticHash === "string" ? node.semanticHash : null,
      ...(typeof node.actionType === "string" ? { actionType: node.actionType } : {}),
      ...(isPresent(node.request) ? { request: node.request } : {}),
      ...(isPresent(node.waitFor) ? { waitFor: node.waitFor } : {}),
      ...(typeof node.criterionId === "string" ? { criterionId: node.criterionId } : {}),
    }];
  });
}

function causalRefs(values: AttentionItem["blocks"]): string {
  return values.length === 0 ? "No direct causal edge recorded" : values.map((value) => `${humanize(value.kind)} · ${value.id}`).join("\n");
}

function AttentionCard({ item, index, selected, onSelect }: {
  item: AttentionItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <article className={`attention-card${selected ? " selected" : ""}`}>
      <button type="button" className="attention-select" onClick={onSelect} aria-pressed={selected}>
        <span className="attention-rank">Server rank {index + 1}</span>
        <strong>{humanize(item.kind)}</strong>
        <span>{item.reason}</span>
      </button>
      <div className="attention-facts">
        <span>{item.rankReason.primary}</span>
        <span>{slack(item.slackMs)}</span>
        <span>{item.impact.downstreamPlanNodes} downstream nodes</span>
        <span>{item.impact.completionCriteria} completion criteria</span>
      </div>
      <details>
        <summary>Inspect causal basis</summary>
        <dl className="work-definition">
          <dt>Blocks</dt><dd className="preserve-lines">{causalRefs(item.blocks)}</dd>
          <dt>Resolving unlocks</dt><dd className="preserve-lines">{causalRefs(item.unblocks)}</dd>
          <dt>Deadline</dt><dd>{time(item.deadline)}</dd>
          <dt>Eligible actor</dt><dd>{shortId(item.assignedOrEligibleActor.employeeId)} · {humanize(item.assignedOrEligibleActor.basis)}</dd>
          <dt>Authority</dt><dd>{item.authorityBoundary ? `${humanize(item.authorityBoundary.operation)} · ${item.authorityBoundary.capability} · revision ${item.authorityBoundary.authorityRevision ?? "unknown"}` : "No separate authority boundary recorded"}</dd>
          <dt>Recovery</dt><dd>{item.recoveryBoundary ? `${item.recoveryBoundary.mode} · ${item.recoveryBoundary.reasonCode}` : "No recovery boundary recorded"}</dd>
          <dt>Next permissible step</dt><dd>{item.nextHumanBoundary.description}</dd>
          <dt>Evidence</dt><dd className="preserve-lines">{item.evidenceRefs.length > 0 ? item.evidenceRefs.map((ref) => `${ref.type}:${ref.id}${ref.hash ? ` · ${ref.hash}` : ""}`).join("\n") : "No evidence reference recorded"}</dd>
          <dt>Roots</dt><dd className="preserve-lines">{item.rootRefs.length > 0 ? item.rootRefs.map((ref) => `${ref.entityType}:${ref.entityId} · ${ref.relationship} · ${ref.source}`).join("\n") : "No canonical root reference recorded"}</dd>
          <dt>Rank factors</dt><dd className="preserve-lines">{item.rankReason.factors.join("\n")}</dd>
          <dt>As created</dt><dd>{time(item.createdAt)}</dd>
        </dl>
      </details>
    </article>
  );
}

function NodeTruth({ aggregate, revision, node }: {
  aggregate: WorkAggregateView;
  revision: WorkPlanRevisionView;
  node: PlanNodeView;
}) {
  const action = aggregate.actions.find((row) => row.planRevisionId === revision.id && row.planNodeId === node.id);
  const step = aggregate.objectiveSteps.find((row) => row.planRevisionId === revision.id && row.planNodeId === node.id);
  const effect = action ? aggregate.businessEffects.find((row) => row.domainActionId === action.id) : undefined;
  const receipt = action ? aggregate.receipts.find((row) => row.domainActionId === action.id) : undefined;
  const state = action?.status ?? step?.iterationOutcome ?? (step?.completedAt ? "observed" : step?.phase) ?? "planned";
  const observed = isPresent(effect?.observedResult) ? effect?.observedResult
    : isPresent(effect?.verification) ? effect?.verification
      : isPresent(step?.observation) ? step?.observation
        : isPresent(receipt?.actualResult) ? receipt?.actualResult
          : null;
  const blocker = isPresent(step?.failure) ? step?.failure
    : isPresent(receipt?.failure) ? receipt?.failure
      : effect && ["divergent", "reconciliation_required", "failed"].includes(effect.status)
        ? { businessEffectStatus: effect.status, verification: effect.verification }
        : action && ["failed", "blocked_integration_unavailable", "needs_human_review"].includes(action.status)
          ? { actionStatus: action.status }
          : null;
  const runtimeRecovery = step?.recoveryKind ? { runtimeRecovery: step.recoveryKind } : null;

  return (
    <article className="plan-node">
      <header>
        <div>
          <span className="plan-node-kind">{humanize(node.kind)}</span>
          <strong>{node.actionType ?? node.criterionId ?? node.id}</strong>
        </div>
        <span className={`work-state state-${state}`}>{humanize(state)}</span>
      </header>
      <dl className="work-definition">
        <dt>Node</dt><dd>{node.id} {node.semanticHash ? `· ${node.semanticHash}` : ""}</dd>
        <dt>Depends on</dt><dd>{node.dependsOn.length > 0 ? node.dependsOn.join(", ") : "Graph root"}</dd>
        <dt>Completion coverage</dt><dd>{node.supports.length > 0 ? node.supports.join(", ") : "No criterion directly covered"}</dd>
        <dt>Preconditions</dt><dd><pre>{json(node.preconditions)}</pre></dd>
        <dt>Expected effect</dt><dd><pre>{json(node.expectedEffects)}</pre></dd>
        <dt>Observation contract</dt><dd><pre>{json(node.observation)}</pre></dd>
        <dt>Observed result</dt><dd><pre>{json(observed)}</pre></dd>
        <dt>Blocker</dt><dd><pre>{json(blocker)}</pre></dd>
        <dt>Recovery</dt><dd><pre>{json({ specification: node.recovery, runtime: runtimeRecovery })}</pre></dd>
      </dl>
    </article>
  );
}

function PlanningDetail({ aggregate }: { aggregate: WorkAggregateView }) {
  const revision = selectedPlanRevision(aggregate.planRevisions);
  if (!revision) {
    return (
      <section className="work-panel">
        <h2>No selected PlanGraph</h2>
        <p className="work-muted">This Work has no persisted Phase 6 plan revision. Query-only and legacy Work can legitimately have none.</p>
      </section>
    );
  }
  const goal = recordValue(revision.goalSpec);
  const constraints = recordValue(revision.constraintSet);
  const hardConstraints = arrayValue(constraints.constraints)
    .map(recordValue)
    .filter((constraint) => constraint.strength === "hard");
  const nodes = planNodes(revision);

  return (
    <div className="work-detail-stack">
      <section className="work-panel plan-summary">
        <div className="work-panel-heading">
          <div><span className="work-kicker">Selected immutable plan</span><h2>Revision {revision.revision}</h2></div>
          <span className={`work-state state-${revision.status}`}>{humanize(revision.status)}</span>
        </div>
        <dl className="work-definition">
          <dt>Goal</dt><dd>{typeof goal.statement === "string" ? goal.statement : "No accepted goal statement recorded"}</dd>
          <dt>Objective</dt><dd>{typeof goal.objective === "string" ? goal.objective : "—"}</dd>
          <dt>Deadline</dt><dd>{time(typeof goal.deadline === "string" ? goal.deadline : null)}</dd>
          <dt>Explicit non-goals</dt><dd>{arrayValue(goal.explicitNonGoals).filter((value): value is string => typeof value === "string").join("; ") || "None recorded"}</dd>
          <dt>Graph hash</dt><dd className="mono-wrap">{revision.graphHash}</dd>
          <dt>Selected</dt><dd>{time(revision.selectedAt)}</dd>
        </dl>
        <h3>Hard constraints</h3>
        {hardConstraints.length === 0 ? <p className="work-muted">No hard constraints persisted.</p> : (
          <div className="constraint-list">
            {hardConstraints.map((constraint, index) => (
              <article key={typeof constraint.id === "string" ? constraint.id : index}>
                <strong>{typeof constraint.kind === "string" ? humanize(constraint.kind) : "hard constraint"}</strong>
                <pre>{json(constraint.requirement)}</pre>
                <small>{json(constraint.provenance)}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="work-panel">
        <div className="work-panel-heading"><div><span className="work-kicker">Causal graph</span><h2>Nodes and verified runtime truth</h2></div><span>{nodes.length} nodes</span></div>
        {nodes.length === 0 ? <p className="work-muted">The persisted graph has no readable nodes.</p> : nodes.map((node) => (
          <NodeTruth key={node.id} aggregate={aggregate} revision={revision} node={node} />
        ))}
      </section>

      <section className="work-panel">
        <div className="work-panel-heading"><div><span className="work-kicker">Immutable lineage</span><h2>Replan history</h2></div><span>{aggregate.planRevisions.length} revisions</span></div>
        <div className="revision-list">
          {aggregate.planRevisions.map((row) => (
            <article key={row.id}>
              <strong>Revision {row.revision} · {humanize(row.status)}</strong>
              <span>{humanize(row.reason)} · parent {shortId(row.parentRevisionId)}</span>
              <span className="mono-wrap">{row.graphHash}</span>
              <small>{time(row.selectedAt)}{row.completedAt ? ` · completed ${time(row.completedAt)}` : ""}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="work-panel">
        <div className="work-panel-heading"><div><span className="work-kicker">Completion</span><h2>Completion proof</h2></div></div>
        <pre className="completion-proof">{json(revision.completionProof)}</pre>
      </section>
    </div>
  );
}

export default function WorkPlanningClient() {
  const [works, setWorks] = useState<WorkSummary[] | null>(null);
  const [attention, setAttention] = useState<AttentionQueueResult | null>(null);
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [aggregate, setAggregate] = useState<WorkAggregateView | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const attentionWorkId = useRef<string | null>(null);
  const executionSequence = useRef(0);

  const loadQueues = useCallback(async () => {
    executionSequence.current += 1;
    const body = {
      intent: "attention_queue",
      page: { limit: 50 },
      executionKey: `console-attention:${Date.now()}:${executionSequence.current}`,
      ...(attentionWorkId.current ? { workId: attentionWorkId.current } : {}),
    };
    const [workResult, attentionResult] = await Promise.allSettled([
      api<{ works: WorkSummary[] }>("/api/works?active=true"),
      api<AttentionQueryEnvelope>("/api/queries", { method: "POST", body: JSON.stringify(body) }),
    ]);
    const nextWorks = workResult.status === "fulfilled" ? workResult.value.works : null;
    const nextAttention = attentionResult.status === "fulfilled" ? attentionResult.value.result : null;
    if (workResult.status === "fulfilled") {
      setWorks(workResult.value.works);
      setWorkError(null);
    } else {
      setWorkError(workResult.reason instanceof Error ? workResult.reason.message : "Work list unavailable");
    }
    if (attentionResult.status === "fulfilled") {
      attentionWorkId.current = attentionResult.value.workId;
      setAttention(attentionResult.value.result);
      setQueueError(null);
    } else {
      setQueueError(attentionResult.reason instanceof Error ? attentionResult.reason.message : "Attention queue unavailable");
    }
    const preferredWorkId = nextAttention?.items[0]?.workId ?? nextWorks?.[0]?.id ?? null;
    if (preferredWorkId) setSelectedWorkId((current) => current ?? preferredWorkId);
  }, []);

  const loadDetail = useCallback(async () => {
    if (!selectedWorkId) {
      setAggregate(null);
      return;
    }
    try {
      const response = await api<{ work: WorkAggregateView }>(`/api/works/${encodeURIComponent(selectedWorkId)}`);
      setAggregate(response.work);
      setDetailError(null);
    } catch (error) {
      setAggregate(null);
      setDetailError(error instanceof Error ? error.message : "Work detail unavailable");
    }
  }, [selectedWorkId]);

  usePoll(loadQueues, 15_000, []);
  usePoll(loadDetail, 12_000, [selectedWorkId]);

  const serverOrderedItems = attention ? attentionItemsInServerOrder(attention.items) : [];
  const selectedSummary = works?.find((work) => work.id === selectedWorkId) ?? aggregate?.work ?? null;

  return (
    <div className="work-console">
      <header className="work-hero">
        <div>
          <span className="work-kicker">Phase 6 · canonical operations</span>
          <h1>Work + causal attention</h1>
          <p>Attention order comes from the server’s persisted Work, authority, plan blockers, deadlines, recovery state, and governed human boundaries.</p>
        </div>
        <button type="button" className="btn" onClick={() => { void loadQueues(); void loadDetail(); }}>Refresh verified state</button>
      </header>

      <div className="work-shell">
        <aside className="attention-panel work-panel">
          <div className="work-panel-heading">
            <div><span className="work-kicker">Server-ranked</span><h2>Your attention</h2></div>
            {attention && <span className={`source-status source-${attention.sourceStatus.status}`}>{attention.sourceStatus.status}</span>}
          </div>
          {queueError && <p className="truth-warning">Transport unavailable: {queueError}. This is not a clear queue.</p>}
          {!attention && !queueError && <p className="pulse work-muted">Reading canonical sources…</p>}
          {attention && attention.sourceStatus.status !== "complete" && (
            <div className="truth-warning">
              <strong>{attention.sourceStatus.status === "unavailable" ? "Attention is unavailable." : "Attention is partial."}</strong>
              <span>Missing sources: {attention.sourceStatus.unavailableSources.join(", ") || "source status did not identify one"}. This result must not be read as a clear queue.</span>
            </div>
          )}
          {attention && (
            <div className="attention-asof">
              <span>As of {time(attention.asOf)}</span>
              <details><summary>Source status</summary><pre>{json(attention.sourceStatus.sources)}</pre></details>
            </div>
          )}
          {attention?.sourceStatus.status === "complete" && serverOrderedItems.length === 0 && <p className="work-empty">No verified actionable items at this as-of time.</p>}
          <div className="attention-list">
            {serverOrderedItems.map((item, index) => (
              <AttentionCard key={item.id} item={item} index={index} selected={selectedWorkId === item.workId} onSelect={() => setSelectedWorkId(item.workId)} />
            ))}
          </div>
        </aside>

        <main className="work-main-column">
          <section className="work-panel work-index">
            <div className="work-panel-heading">
              <div><span className="work-kicker">Canonical Work</span><h2>Open Work</h2></div>
              <span>{works?.length ?? "—"}</span>
            </div>
            {workError && <p className="truth-warning">{workError}</p>}
            {!works && !workError && <p className="pulse work-muted">Loading Work…</p>}
            {works && works.length === 0 && <p className="work-empty">No open Work.</p>}
            <div className="work-list">
              {works?.map((work) => (
                <button type="button" key={work.id} className={selectedWorkId === work.id ? "selected" : ""} onClick={() => setSelectedWorkId(work.id)}>
                  <strong>{work.initialInstruction}</strong>
                  <span>{humanize(work.status)} · {work.executionModel ? humanize(work.executionModel) : "unclassified"} · {shortId(work.id)}</span>
                  <small>{time(work.updatedAt)}</small>
                </button>
              ))}
            </div>
          </section>

          {selectedSummary && (
            <section className="work-panel work-selected-header">
              <div>
                <span className="work-kicker">Selected Work · {shortId(selectedSummary.id)}</span>
                <h2>{selectedSummary.initialInstruction}</h2>
              </div>
              <span className={`work-state state-${selectedSummary.status}`}>{humanize(selectedSummary.status)}</span>
              {isPresent(aggregate?.work.recovery) ? <div className="truth-warning"><strong>Work recovery</strong><pre>{json(aggregate?.work.recovery)}</pre></div> : null}
              {isPresent(aggregate?.work.failure) ? <div className="truth-warning"><strong>Work failure</strong><pre>{json(aggregate?.work.failure)}</pre></div> : null}
            </section>
          )}
          {detailError && <p className="truth-warning">{detailError}</p>}
          {selectedWorkId && !aggregate && !detailError && <p className="pulse work-muted">Loading persisted plan truth…</p>}
          {aggregate && <PlanningDetail aggregate={aggregate} />}
          {!selectedWorkId && <section className="work-panel"><p className="work-empty">Select Work or a server-ranked attention item to inspect its plan.</p></section>}
        </main>
      </div>
    </div>
  );
}
