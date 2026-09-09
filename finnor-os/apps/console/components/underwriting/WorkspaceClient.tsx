"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type {
  UnderwritingInput,
  UnderwritingLineage,
  UnderwritingNodeResult,
  UnderwritingRun,
  UnderwritingSensitivityDetail,
  UnderwritingValue,
  UnderwritingWorkspace,
} from "../../lib/underwriting";
import { shortIdentity, statusClassName } from "../../lib/underwriting";
import LineageTree from "./LineageTree";
import SensitivityMatrix from "./SensitivityMatrix";
import { InputTruthPanel, ValuePanel } from "./ValuePanel";

const TRANSACTION_IDS = new Set([
  "transaction.entry_enterprise_value", "transaction.purchase_equity_value", "sources_uses.total_uses",
  "sources_uses.debt_sources", "sources_uses.sponsor_equity", "sources_uses.total_sources",
]);

function exactNow(): string {
  return new Date(Date.now() - 1_000).toISOString();
}

function sortedValues(run: UnderwritingRun, include: (node: UnderwritingNodeResult) => boolean): UnderwritingNodeResult[] {
  return Object.values(run.result.values).filter(include).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function parseModelValue(raw: string, input: UnderwritingInput): UnderwritingValue {
  if (input.shape === "series") {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A series override must be a JSON object keyed by exact period ID");
    return value as Record<string, string | boolean>;
  }
  if (input.valueType === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error("A boolean override must be true or false");
    return raw === "true";
  }
  return raw;
}

function carriedExplicitInputs(run: UnderwritingRun | undefined, bindingByNode: Map<string, { sourceKind: string }>): Record<string, unknown> {
  if (!run) return {};
  const output: Record<string, unknown> = {};
  for (const [nodeId, input] of Object.entries(run.inputSnapshot.values)) {
    const sourceKind = bindingByNode.get(nodeId)?.sourceKind;
    if (sourceKind && sourceKind !== "explicit" && sourceKind !== "model_parameter") continue;
    if (input.value === null || !["OBSERVED_FACT", "CANONICAL_ASSUMPTION", "MODEL_PARAMETER"].includes(input.truthClass)) continue;
    output[nodeId] = {
      value: input.value,
      truthClass: input.truthClass,
      status: input.status,
      provenance: input.provenance,
      ...(input.reason ? { reason: input.reason } : {}),
    };
  }
  return output;
}

function RunHeader({ run }: { run: UnderwritingRun }) {
  return (
    <section className="uw-run-context" aria-label="Exact selected underwriting run">
      <div><span>Run</span><strong>{run.id}</strong></div>
      <div><span>ModelVersion</span><strong>{run.modelVersionId}</strong></div>
      <div><span>worldAt</span><strong>{run.worldAt}</strong></div>
      <div><span>engine</span><strong>{run.engineVersion}</strong></div>
      <div><span>input hash</span><strong>{run.inputHash}</strong></div>
      <div><span>result hash</span><strong>{run.resultHash}</strong></div>
    </section>
  );
}

export default function UnderwritingWorkspaceClient({ investmentCaseId }: { investmentCaseId: string }) {
  const [workspace, setWorkspace] = useState<UnderwritingWorkspace | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedModelVersionId, setSelectedModelVersionId] = useState("");
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [worldAt, setWorldAt] = useState(exactNow);
  const [explicitInputsJson, setExplicitInputsJson] = useState("{}");
  const [overrideNodeId, setOverrideNodeId] = useState("");
  const [overrideValue, setOverrideValue] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [scenarioName, setScenarioName] = useState("Downside");
  const [comparisonRunId, setComparisonRunId] = useState("");
  const [runDiff, setRunDiff] = useState<Record<string, unknown> | null>(null);
  const [lineageNodeId, setLineageNodeId] = useState("");
  const [lineage, setLineage] = useState<UnderwritingLineage | null>(null);
  const [selectedSensitivityId, setSelectedSensitivityId] = useState("");
  const [sensitivity, setSensitivity] = useState<UnderwritingSensitivityDetail | null>(null);
  const [sensitivityName, setSensitivityName] = useState("Entry / exit multiple");
  const [sensitivityRowNode, setSensitivityRowNode] = useState("");
  const [sensitivityRowValues, setSensitivityRowValues] = useState("");
  const [sensitivityColumnNode, setSensitivityColumnNode] = useState("");
  const [sensitivityColumnValues, setSensitivityColumnValues] = useState("");
  const [sensitivityOutputs, setSensitivityOutputs] = useState("gross_sponsor_moic");
  const [artifactResult, setArtifactResult] = useState<Record<string, unknown> | null>(null);
  const [modelKey, setModelKey] = useState("standard_lbo_v1");
  const [modelName, setModelName] = useState("Standard LBO");
  const [modelDefinitionJson, setModelDefinitionJson] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await api<UnderwritingWorkspace>(`/api/investment-cases/${investmentCaseId}/underwriting`);
    setWorkspace(next);
  }, [investmentCaseId]);

  useEffect(() => { load().catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load underwriting workspace")); }, [load]);

  const activeRun = workspace?.runs.find((run) => run.id === selectedRunId) ?? workspace?.runs[0];
  const activeModelVersionId = selectedModelVersionId || activeRun?.modelVersionId || workspace?.modelVersions[0]?.id || "";
  const activeScenarios = workspace?.scenarios.filter((scenario) => scenario.modelVersionId === activeModelVersionId) ?? [];
  const activeInputs = activeRun ? Object.values(activeRun.inputSnapshot.values).sort((left, right) => left.nodeId.localeCompare(right.nodeId)) : [];
  const scalarInputs = activeInputs.filter((input) => input.shape === "scalar");
  const outputNodes = activeRun ? Object.values(activeRun.result.outputs).sort((left, right) => left.nodeId.localeCompare(right.nodeId)) : [];
  const activeBindings = workspace?.artifactBindings.filter((binding) => binding.modelVersionId === activeModelVersionId) ?? [];
  const bindingByNode = useMemo(() => new Map((workspace?.modelInputBindings ?? [])
    .filter((binding) => binding.modelVersionId === activeModelVersionId)
    .map((binding) => [binding.inputNodeId, binding])), [workspace, activeModelVersionId]);
  const transaction = activeRun ? sortedValues(activeRun, (node) => TRANSACTION_IDS.has(node.nodeId)) : [];
  const forecast = activeRun ? sortedValues(activeRun, (node) => node.nodeId.startsWith("forecast.")) : [];
  const debt = activeRun ? sortedValues(activeRun, (node) => node.nodeId.startsWith("debt.") || node.nodeId === "cash.ending") : [];
  const exitAndReturns = activeRun ? sortedValues(activeRun, (node) => node.nodeId.startsWith("exit.") || node.nodeId.startsWith("returns.")) : [];

  async function act<T>(label: string, action: () => Promise<T>, onDone?: (value: T) => void | Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      const result = await action();
      await onDone?.(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Underwriting operation failed");
    } finally {
      setBusy(null);
    }
  }

  function selectRun(runId: string) {
    const run = workspace?.runs.find((item) => item.id === runId);
    setSelectedRunId(runId);
    if (run) {
      setSelectedModelVersionId(run.modelVersionId);
      setSelectedScenarioId(run.scenarioId ?? "");
      setWorldAt(run.worldAt);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function registerModelVersion() {
    void act("model", async () => {
      const definition = JSON.parse(modelDefinitionJson) as Record<string, unknown>;
      const model = await api<{ id: string }>("/api/underwriting/models", {
        method: "POST",
        body: JSON.stringify({ investmentCaseId, modelKey, name: modelName }),
      });
      return api<{ id: string }>(`/api/underwriting/models/${model.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ definition }),
      });
    }, async (version) => {
      setSelectedModelVersionId(version.id);
      await load();
    });
  }

  function createScenario() {
    const input = activeInputs.find((item) => item.nodeId === overrideNodeId);
    if (!input) { setError("Select an exact input node for the scenario override"); return; }
    void act("scenario", async () => {
      const parentScenarioId = selectedScenarioId || undefined;
      return api<{ id: string }>("/api/underwriting/scenarios", {
        method: "POST",
        body: JSON.stringify({
          investmentCaseId,
          modelVersionId: activeModelVersionId,
          ...(parentScenarioId ? { parentScenarioId } : {}),
          scenario: {
            schemaVersion: "underwriting-scenario.v1",
            name: scenarioName,
            ...(parentScenarioId ? { parentScenarioId } : {}),
            overrides: [{ nodeId: input.nodeId, value: parseModelValue(overrideValue, input), ...(overrideReason ? { reason: overrideReason } : {}) }],
          },
        }),
      });
    }, async (scenario) => {
      setSelectedScenarioId(scenario.id);
      await load();
    });
  }

  function runModel() {
    if (!activeModelVersionId) { setError("Register or select an immutable ModelVersion first"); return; }
    void act("run", async () => {
      const userInputs = JSON.parse(explicitInputsJson) as Record<string, unknown>;
      const carried = activeRun?.modelVersionId === activeModelVersionId ? carriedExplicitInputs(activeRun, bindingByNode) : {};
      return api<{ id: string }>("/api/underwriting/runs", {
        method: "POST",
        body: JSON.stringify({
          investmentCaseId,
          modelVersionId: activeModelVersionId,
          worldAt,
          idempotencyKey: `underwriting-workspace:${crypto.randomUUID()}`,
          ...(selectedScenarioId ? { scenarioId: selectedScenarioId } : {}),
          explicitInputs: { ...carried, ...userInputs },
        }),
      });
    }, async (run) => {
      setSelectedRunId(run.id);
      await load();
    });
  }

  function compareRuns() {
    if (!activeRun || !comparisonRunId) return;
    void act("diff", () => api<Record<string, unknown>>(`/api/underwriting/runs/diff?left=${encodeURIComponent(comparisonRunId)}&right=${encodeURIComponent(activeRun.id)}`), setRunDiff);
  }

  function explain() {
    if (!activeRun || !lineageNodeId) return;
    void act("lineage", () => api<UnderwritingLineage>(`/api/underwriting/runs/${activeRun.id}/explain?nodeId=${encodeURIComponent(lineageNodeId)}`), setLineage);
  }

  function loadSensitivity(id: string) {
    setSelectedSensitivityId(id);
    if (!id) { setSensitivity(null); return; }
    void act("sensitivity-load", () => api<UnderwritingSensitivityDetail>(`/api/underwriting/sensitivities/${id}`), setSensitivity);
  }

  function createSensitivity() {
    if (!activeRun || !sensitivityRowNode || !sensitivityRowValues.trim()) { setError("A base Run, row input node, and exact row values are required"); return; }
    const rowValues = sensitivityRowValues.split(",").map((value) => value.trim()).filter(Boolean);
    const columnValues = sensitivityColumnValues.split(",").map((value) => value.trim()).filter(Boolean);
    const definition = {
      schemaVersion: "underwriting-sensitivity.v1" as const,
      name: sensitivityName,
      rowAxis: { nodeId: sensitivityRowNode, values: rowValues },
      ...(sensitivityColumnNode && columnValues.length ? { columnAxis: { nodeId: sensitivityColumnNode, values: columnValues } } : {}),
      outputNodeIds: sensitivityOutputs.split(",").map((value) => value.trim()).filter(Boolean),
    };
    void act("sensitivity", () => api<{ id: string }>("/api/underwriting/sensitivities", {
      method: "POST",
      body: JSON.stringify({ baseRunId: activeRun.id, definition, idempotencyKey: `underwriting-sensitivity:${crypto.randomUUID()}` }),
    }), async (created) => {
      setSelectedSensitivityId(created.id);
      const [, detail] = await Promise.all([
        load(),
        api<UnderwritingSensitivityDetail>(`/api/underwriting/sensitivities/${created.id}`),
      ]);
      setSensitivity(detail);
    });
  }

  function compareArtifact(documentId: string, documentVersionId: string) {
    if (!activeRun) return;
    void act("artifact-compare", () => api<Record<string, unknown>>("/api/underwriting/comparisons", {
      method: "POST", body: JSON.stringify({ runId: activeRun.id, documentId, documentVersionId }),
    }), setArtifactResult);
  }

  function projectArtifact(documentId: string, baseVersionId: string) {
    if (!activeRun) return;
    void act("artifact-project", () => api<Record<string, unknown>>("/api/underwriting/projections", {
      method: "POST",
      body: JSON.stringify({ runId: activeRun.id, documentId, baseVersionId, idempotencyKey: `underwriting-projection:${crypto.randomUUID()}` }),
    }), async (result) => { setArtifactResult(result); await load(); });
  }

  if (!workspace) return <div className="card pulse">Loading exact InvestmentCase underwriting truth…</div>;

  return (
    <div className="uw-workspace">
      <header className="uw-hero">
        <div>
          <div className="uw-kicker">P4 · deterministic underwriting</div>
          <h1>{workspace.investmentCase.title}</h1>
          <p>{workspace.investmentCase.summary ?? "No P1 InvestmentCase summary recorded."}</p>
          <div className="uw-meta"><span>InvestmentCase {workspace.investmentCase.id}</span><span>Deal {workspace.investmentCase.dealId}</span><span>state {workspace.investmentCase.state}</span></div>
        </div>
        <div className="uw-truth-box">P1 owns this InvestmentCase and its canonical Assumptions. P4 rows are immutable calculations; Excel is an independent comparison.</div>
      </header>

      {error ? <div className="uw-alert" role="alert">{error}</div> : null}

      <section className="card uw-controls">
        <div className="uw-panel-heading"><h2>Exact execution context</h2><span>{busy ? `Working: ${busy}` : "No LLM or Excel required"}</span></div>
        <div className="uw-form-grid">
          <label>Historical Run<select value={activeRun?.id ?? ""} onChange={(event) => selectRun(event.target.value)}><option value="">No Run</option>{workspace.runs.map((run) => <option key={run.id} value={run.id}>{run.computedAt} · {run.validity} · {shortIdentity(run.id)}</option>)}</select></label>
          <label>ModelVersion<select value={activeModelVersionId} onChange={(event) => { setSelectedModelVersionId(event.target.value); setSelectedScenarioId(""); }}><option value="">Select</option>{workspace.modelVersions.map((version) => <option key={version.id} value={version.id}>{version.versionKey} · {shortIdentity(version.semanticHash)}</option>)}</select></label>
          <label>Scenario<select value={selectedScenarioId} onChange={(event) => setSelectedScenarioId(event.target.value)}><option value="">Base · zero overrides</option>{activeScenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name} · {shortIdentity(scenario.semanticHash)}</option>)}</select></label>
          <label>worldAt<input value={worldAt} onChange={(event) => setWorldAt(event.target.value)} aria-label="Exact ISO worldAt timestamp" /></label>
        </div>
        <details className="uw-advanced-inputs">
          <summary>Explicit/model-parameter inputs</summary>
          <p>JSON object keyed by InputNode. Decimal values must be strings. Bound P1 Assumptions, EvidenceVersions, and ArtifactAnchors cannot be shadowed here.</p>
          <textarea value={explicitInputsJson} onChange={(event) => setExplicitInputsJson(event.target.value)} rows={6} spellCheck={false} />
        </details>
        <button type="button" className="btn btn-primary" disabled={Boolean(busy) || !activeModelVersionId || !worldAt} onClick={runModel}>Create immutable Run</button>
      </section>

      {activeRun ? <RunHeader run={activeRun} /> : (
        <section className="card uw-empty">
          <h2>No UnderwritingRun exists</h2>
          <p>This is truthful: the P1 InvestmentCase is valid, but FINNOR will not fabricate model output. Register a structured ModelIR version and supply exact inputs.</p>
          <details>
            <summary>Register immutable structured ModelIR</summary>
            <div className="uw-form-grid"><label>Model key<input value={modelKey} onChange={(event) => setModelKey(event.target.value)} /></label><label>Model name<input value={modelName} onChange={(event) => setModelName(event.target.value)} /></label></div>
            <textarea value={modelDefinitionJson} onChange={(event) => setModelDefinitionJson(event.target.value)} rows={14} spellCheck={false} placeholder="Paste structured UnderwritingModelIR JSON; natural-language definitions are rejected." />
            <button type="button" className="btn" disabled={Boolean(busy) || !modelDefinitionJson.trim()} onClick={registerModelVersion}>Compile and register ModelVersion</button>
          </details>
        </section>
      )}

      {activeRun ? (
        <>
          <section className="uw-stat-grid">
            {outputNodes.filter((node) => ["gross_sponsor_moic", "gross_sponsor_irr", "gross_sponsor_xirr", "output.exit.equity_value"].includes(node.nodeId)).map((node) => (
              <div className="card uw-stat" key={node.nodeId} data-run-id={activeRun.id}><span>{node.nodeId}</span><strong>{typeof node.value === "object" ? "series" : String(node.value)}</strong><small>{node.currency ? `${node.currency} · ` : ""}{node.unit} · Run {shortIdentity(activeRun.id)}</small></div>
            ))}
            <div className="card uw-stat"><span>financial validity</span><strong className={statusClassName(activeRun.validity)}>{activeRun.validity}</strong><small>execution {activeRun.status}</small></div>
          </section>

          <ValuePanel title="Transaction · Sources & Uses" nodes={transaction} runId={activeRun.id} modelVersionId={activeRun.modelVersionId} />
          <ValuePanel title="Operating forecast · FCF" nodes={forecast} runId={activeRun.id} modelVersionId={activeRun.modelVersionId} />
          <ValuePanel title="Debt · interest · cash · revolver" nodes={debt} runId={activeRun.id} modelVersionId={activeRun.modelVersionId} />
          <ValuePanel title="Exit bridge · sponsor cash flows · returns" nodes={exitAndReturns} runId={activeRun.id} modelVersionId={activeRun.modelVersionId} />

          <section className="card uw-panel">
            <div className="uw-panel-heading"><h2>Exact sponsor cash-flow timeline</h2><span>Run {shortIdentity(activeRun.id)} · ModelVersion {shortIdentity(activeRun.modelVersionId)}</span></div>
            {activeRun.result.sponsorCashFlows?.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Period</th><th>Cash-flow type</th><th>Exact amount</th></tr></thead><tbody>{activeRun.result.sponsorCashFlows.map((flow, index) => <tr key={`${flow.date}:${flow.type}:${index}`} data-run-id={activeRun.id}><td>{flow.date}</td><td>{flow.periodId ?? "entry"}</td><td>{flow.type}</td><td>{flow.amount}</td></tr>)}</tbody></table></div> : <p className="uw-muted">This Run does not expose a sponsor cash-flow timeline; it cannot support a verified sponsor-return claim.</p>}
          </section>

          <section className="card uw-panel">
            <div className="uw-panel-heading"><h2>Mandatory checks</h2><span>Run {shortIdentity(activeRun.id)}</span></div>
            <div className="table-wrap"><table className="table"><thead><tr><th>Check</th><th>Status</th><th>Reason</th><th>Difference / tolerance</th></tr></thead><tbody>{activeRun.result.checks.map((check) => <tr key={check.nodeId}><td><code>{check.nodeId}</code></td><td><span className={statusClassName(String(check.passed))}>{check.passed ? "PASS" : "FAIL"}</span></td><td>{check.code} · {check.message}</td><td>{check.difference ?? "—"} / {check.tolerance ?? "—"}</td></tr>)}</tbody></table></div>
          </section>

          <InputTruthPanel inputs={activeInputs} bindings={bindingByNode} runId={activeRun.id} modelVersionId={activeRun.modelVersionId} />

          <div className="uw-two-column">
            <section className="card uw-panel">
              <div className="uw-panel-heading"><h2>Scenario override</h2><span>never mutates P1 Assumption</span></div>
              <p className="uw-muted">Canonical Assumptions are read-only here. This creates a new immutable override set.</p>
              <label>Scenario name<input value={scenarioName} onChange={(event) => setScenarioName(event.target.value)} /></label>
              <label>Exact InputNode<select value={overrideNodeId} onChange={(event) => setOverrideNodeId(event.target.value)}><option value="">Select</option>{activeInputs.map((input) => <option key={input.nodeId} value={input.nodeId}>{input.nodeId} · {input.truthClass}</option>)}</select></label>
              <label>Exact decimal/text value<input value={overrideValue} onChange={(event) => setOverrideValue(event.target.value)} placeholder="Decimal strings use rate fractions, e.g. 0.075" /></label>
              <label>Reason (optional)<input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label>
              <button type="button" className="btn" disabled={Boolean(busy) || !overrideNodeId || !overrideValue} onClick={createScenario}>Create Scenario</button>
            </section>

            <section className="card uw-panel">
              <div className="uw-panel-heading"><h2>Run comparison</h2><span>dependency-graph attribution</span></div>
              <label>Compare selected Run against<select value={comparisonRunId} onChange={(event) => setComparisonRunId(event.target.value)}><option value="">Select</option>{workspace.runs.filter((run) => run.id !== activeRun.id).map((run) => <option key={run.id} value={run.id}>{run.computedAt} · {shortIdentity(run.id)}</option>)}</select></label>
              <button type="button" className="btn" disabled={Boolean(busy) || !comparisonRunId} onClick={compareRuns}>Diff Runs</button>
              {runDiff ? <pre className="uw-json">{JSON.stringify(runDiff, null, 2)}</pre> : null}
            </section>
          </div>

          <section className="card uw-panel">
            <div className="uw-panel-heading"><h2>Deterministic output lineage</h2><span>exact graph traversal · no LLM</span></div>
            <div className="uw-inline-controls"><select value={lineageNodeId} onChange={(event) => setLineageNodeId(event.target.value)}><option value="">Select output</option>{outputNodes.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.nodeId}</option>)}</select><button type="button" className="btn" disabled={Boolean(busy) || !lineageNodeId} onClick={explain}>Explain</button></div>
            {lineage ? <LineageTree node={lineage} /> : <p className="uw-muted">Select an exact OutputNode to inspect calculation, dependencies, Assumption versions, EvidenceVersions, and ArtifactAnchors.</p>}
          </section>

          <section className="card uw-panel">
            <div className="uw-panel-heading"><h2>Scenario sensitivity</h2><span>one immutable Run per cell · maximum 2,500</span></div>
            <div className="uw-form-grid">
              <label>Saved sensitivity<select value={selectedSensitivityId} onChange={(event) => loadSensitivity(event.target.value)}><option value="">Select</option>{workspace.sensitivities.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status} · {item.cellCount}</option>)}</select></label>
              <label>Name<input value={sensitivityName} onChange={(event) => setSensitivityName(event.target.value)} /></label>
              <label>Row InputNode<select value={sensitivityRowNode} onChange={(event) => setSensitivityRowNode(event.target.value)}><option value="">Select</option>{scalarInputs.map((input) => <option key={input.nodeId} value={input.nodeId}>{input.nodeId}</option>)}</select></label>
              <label>Row exact values<input value={sensitivityRowValues} onChange={(event) => setSensitivityRowValues(event.target.value)} placeholder="7,8,9" /></label>
              <label>Column InputNode (optional)<select value={sensitivityColumnNode} onChange={(event) => setSensitivityColumnNode(event.target.value)}><option value="">One-way</option>{scalarInputs.filter((input) => input.nodeId !== sensitivityRowNode).map((input) => <option key={input.nodeId} value={input.nodeId}>{input.nodeId}</option>)}</select></label>
              <label>Column exact values<input value={sensitivityColumnValues} onChange={(event) => setSensitivityColumnValues(event.target.value)} placeholder="0.18,0.20,0.22" /></label>
              <label>OutputNode IDs<input value={sensitivityOutputs} onChange={(event) => setSensitivityOutputs(event.target.value)} /></label>
            </div>
            <button type="button" className="btn" disabled={Boolean(busy) || !sensitivityRowNode || !sensitivityRowValues} onClick={createSensitivity}>Run bounded sensitivity</button>
          </section>
          {sensitivity ? <SensitivityMatrix detail={sensitivity} onSelectRun={selectRun} /> : null}

          <section className="card uw-panel">
            <div className="uw-panel-heading"><h2>P3 workbook bindings</h2><span>P4 never writes Excel directly</span></div>
            {activeBindings.length === 0 ? <p className="uw-muted">No exact SpreadsheetIR anchor bindings exist for this ModelVersion.</p> : (
              <div className="table-wrap"><table className="table"><thead><tr><th>Direction / mode</th><th>Model node</th><th>Exact P3 target</th><th>Policy</th><th>Actions</th></tr></thead><tbody>{activeBindings.map((binding) => <tr key={binding.id}><td>{binding.direction}<br /><small>{binding.bindingMode}</small></td><td><code>{binding.modelNodeId}</code></td><td><a href={`/artifacts/${binding.documentId}`}>{shortIdentity(binding.documentId)}</a><br /><small>version {shortIdentity(binding.documentVersionId)} · {binding.anchorId}</small></td><td>{binding.comparisonPolicy ? JSON.stringify(binding.comparisonPolicy) : "input-only"}</td><td>{binding.direction === "output" ? <div className="uw-inline-controls"><button type="button" className="btn" disabled={Boolean(busy)} onClick={() => compareArtifact(binding.documentId, binding.documentVersionId)}>Compare</button>{binding.bindingMode === "write_and_compare" ? <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => projectArtifact(binding.documentId, binding.documentVersionId)}>Project local version</button> : null}</div> : "read source"}</td></tr>)}</tbody></table></div>
            )}
            {artifactResult ? <pre className="uw-json">{JSON.stringify(artifactResult, null, 2)}</pre> : null}
            <p className="uw-muted">Microsoft publication and delegated Excel recalculation remain in the P3 Artifact Workspace with its existing authority, conditional-write, and read-back controls.</p>
          </section>
        </>
      ) : null}
    </div>
  );
}
