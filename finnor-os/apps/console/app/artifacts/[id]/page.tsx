"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, downloadArtifact } from "../../../lib/api";

type Version = {
  id: string;
  version_ordinal: number;
  origin: string;
  format: string;
  byte_sha256: string;
  size_bytes: number;
  provider_etag: string | null;
  created_at: string;
};
type Head = { kind: string; head_key: string; version_id: string; updated_at: string };
type Node = { id: string; part: string; path: string; kind: string; hash: string; data: Record<string, unknown> };
type Summary = {
  documentId: string;
  document: { title: string; source_system: string | null; storage_ref: string | null };
  version: Version;
  versions: Version[];
  heads: Head[];
  semantic: { schema: string; kind: string; semanticHash: string; nodeCount: number; warnings: string[]; calculationStatus: string };
  comments: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
  lineage: Array<Record<string, unknown>>;
  publications: Array<Record<string, unknown>>;
  providerCreations: Array<Record<string, unknown>>;
};
type IrSlice = { kind: string; semanticHash: string; calculationStatus: string; total: number; nodes: Node[]; warnings: string[] };
type Diff = { changes: Array<{ id: string; kind: string; before?: string; after?: string }>; left: string; right: string };
type Collaboration = Pick<Summary, "comments" | "reviews" | "bindings" | "lineage" | "publications" | "providerCreations"> & { remaps: Array<Record<string, unknown>> };

function short(value: string | null | undefined, length = 10): string {
  return value ? `${value.slice(0, length)}${value.length > length ? "…" : ""}` : "—";
}

function statusClass(status: string): string {
  if (/verified|approved|exact/.test(status)) return "artifact-status good";
  if (/conflict|failed|stale|unverified|changes_requested/.test(status)) return "artifact-status bad";
  return "artifact-status";
}

function cellPosition(address: string): { column: number; row: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(address);
  if (!match) return { column: Number.MAX_SAFE_INTEGER, row: Number.MAX_SAFE_INTEGER };
  let column = 0;
  for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}

export default function ArtifactWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const requestedVersion = useSearchParams().get("versionId") ?? "";
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [ir, setIr] = useState<IrSlice | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [draft, setDraft] = useState<{ draftKey: string; versionId: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editAsFormula, setEditAsFormula] = useState(false);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [comment, setComment] = useState("");
  const [publication, setPublication] = useState<Record<string, unknown> | null>(null);
  const [collaboration, setCollaboration] = useState<Collaboration | null>(null);
  const [selectedSheetId, setSelectedSheetId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    const data = await api<Summary>(`/api/documents/${id}/artifact${requestedVersion ? `?versionId=${encodeURIComponent(requestedVersion)}` : ""}`);
    setSummary(data);
    setSelectedVersion((current) => current || requestedVersion || data.version.id);
  }, [id, requestedVersion]);

  useEffect(() => { loadSummary().catch((reason) => setError((reason as Error).message)); }, [loadSummary]);
  useEffect(() => {
    if (!selectedVersion) return;
    setIr(null);
    api<IrSlice>(`/api/documents/${id}/artifact/ir/${selectedVersion}?limit=500`)
      .then((value) => {
        setIr(value);
        setSelectedNodeId((current) => value.nodes.some((node) => node.id === current) ? current : value.nodes[0]?.id ?? "");
        const sheets = value.nodes.filter((node) => node.kind === "worksheet");
        setSelectedSheetId((current) => sheets.some((node) => node.id === `sheet:${current}`) ? current : sheets[0]?.id.replace(/^sheet:/, "") ?? "");
      })
      .catch((reason) => setError((reason as Error).message));
    api<Collaboration>(`/api/documents/${id}/artifact/context?versionId=${encodeURIComponent(selectedVersion)}`)
      .then(setCollaboration)
      .catch((reason) => setError((reason as Error).message));
  }, [id, selectedVersion]);

  const selectedNode = ir?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const providerHead = summary?.heads.find((head) => head.kind === "provider");
  const localHead = draft?.versionId ?? summary?.heads.find((head) => head.kind === "draft")?.version_id;
  const selectedCollaboration: Collaboration | null = collaboration ?? (summary ? { comments: summary.comments, reviews: summary.reviews, bindings: summary.bindings, lineage: summary.lineage, publications: summary.publications, providerCreations: summary.providerCreations, remaps: [] } : null);
  const reviewState = selectedCollaboration?.reviews.find((review) => review.version_id === selectedVersion)?.state as string | undefined;
  const groupedNodes = useMemo(() => {
    const groups = new Map<string, Node[]>();
    for (const node of ir?.nodes ?? []) groups.set(node.kind, [...(groups.get(node.kind) ?? []), node]);
    return [...groups.entries()];
  }, [ir]);
  const sheets = useMemo(() => ir?.nodes.filter((node) => node.kind === "worksheet") ?? [], [ir]);
  const spreadsheetCells = useMemo(() => (ir?.kind === "xlsx" || ir?.kind === "xlsm")
    ? ir.nodes.filter((node) => node.kind === "cell" && String(node.data.sheetId) === selectedSheetId)
      .sort((left, right) => {
        const a = cellPosition(String(left.data.address));
        const b = cellPosition(String(right.data.address));
        return a.row - b.row || a.column - b.column;
      }).slice(0, 360)
    : [], [ir, selectedSheetId]);
  const tableColumns = useMemo(() => [...new Set(spreadsheetCells.map((node) => String(node.data.address).match(/^[A-Z]+/)?.[0]).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => cellPosition(`${left}1`).column - cellPosition(`${right}1`).column).slice(0, 18), [spreadsheetCells]);
  const tableRows = useMemo(() => [...new Set(spreadsheetCells.map((node) => Number(String(node.data.address).match(/[0-9]+$/)?.[0])).filter(Number.isSafeInteger))].sort((a, b) => a - b).slice(0, 40), [spreadsheetCells]);
  const cellByAddress = useMemo(() => new Map(spreadsheetCells.map((node) => [String(node.data.address), node])), [spreadsheetCells]);
  const latestExternalOperation = publication ?? selectedCollaboration?.publications[0] ?? selectedCollaboration?.providerCreations[0] ?? null;

  async function run<T>(label: string, action: () => Promise<T>, done?: (value: T) => void) {
    setBusy(label); setError(null);
    try { const value = await action(); done?.(value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Artifact operation failed"); }
    finally { setBusy(null); }
  }

  function beginDraft() {
    if (!selectedVersion) return;
    void run("draft", () => api<{ draftKey: string; versionId: string }>(`/api/documents/${id}/artifact/drafts`, { method: "POST", body: JSON.stringify({ baseVersionId: selectedVersion }) }), setDraft);
  }

  function operationFor(node: Node): Record<string, unknown> {
    if (ir?.kind === "xlsx" || ir?.kind === "xlsm") {
      if (node.kind !== "cell") throw new Error("Select a cell for a spreadsheet edit");
      return editAsFormula
        ? { type: "set_formula", sheetId: node.data.sheetId, address: node.data.address, formula: editValue, expectedHash: node.hash }
        : { type: "set_value", sheetId: node.data.sheetId, address: node.data.address, value: editValue, expectedHash: node.hash };
    }
    if (ir?.kind === "docx") return { type: node.kind === "tableCell" ? "replace_table_cell" : "replace_text", anchor: node.id, expectedHash: node.hash, text: editValue };
    if (ir?.kind === "pptx") return { type: node.kind === "tableCell" ? "replace_table_cell" : node.kind === "notes" ? "update_notes" : "replace_text", anchor: node.id, expectedHash: node.hash, text: editValue };
    throw new Error("This format is read-only");
  }

  function saveEdit() {
    if (!draft || !selectedNode) return;
    let operation: Record<string, unknown>;
    try { operation = operationFor(selectedNode); } catch (reason) { setError((reason as Error).message); return; }
    void run("patch", () => api<{ version?: Version; versionId?: string }>(`/api/documents/${id}/artifact/patches`, {
      method: "POST",
      body: JSON.stringify({ baseVersionId: draft.versionId, draftKey: draft.draftKey, operations: [operation] }),
    }), async (value) => {
      const versionId = value.version?.id ?? value.versionId;
      if (versionId) { setDraft({ ...draft, versionId }); setSelectedVersion(versionId); }
      await loadSummary();
    });
  }

  function compareToProvider() {
    if (!providerHead || !selectedVersion) return;
    void run("diff", () => api<Diff>(`/api/documents/${id}/artifact/diff?left=${providerHead.version_id}&right=${selectedVersion}`), setDiff);
  }

  function addComment() {
    if (!selectedNode || !comment.trim()) return;
    void run("comment", () => api(`/api/documents/${id}/artifact/comments`, { method: "POST", body: JSON.stringify({ versionId: selectedVersion, anchorId: selectedNode.id, anchorHash: selectedNode.hash, body: comment }) }), async () => { setComment(""); await loadSummary(); });
  }

  function recordReview(state: "requested" | "approved" | "changes_requested") {
    void run("review", () => api(`/api/documents/${id}/artifact/reviews`, { method: "POST", body: JSON.stringify({ versionId: selectedVersion, state }) }), async () => loadSummary());
  }

  function publish() {
    if (!draft || !providerHead) return;
    void run("publish", () => api<Record<string, unknown>>(`/api/documents/${id}/artifact/publish`, {
      method: "POST",
      body: JSON.stringify({ localVersionId: draft.versionId, baseVersionId: providerHead.version_id, mode: "APP_ONLY_FILE_REPLACE" }),
    }), async (value) => { setPublication(value); await loadSummary(); });
  }

  if (!summary) return <div className="card pulse">Loading artifact truth…</div>;

  return (
    <div className="artifact-workspace">
      <header className="artifact-hero">
        <div>
          <div className="artifact-kicker">Artifact Workspace · semantic structure</div>
          <h1>{summary.document.title}</h1>
          <div className="artifact-meta">
            <span className="artifact-format">{summary.semantic.kind.toUpperCase()}</span>
            <span>{summary.document.source_system ?? "FINNOR local"}</span>
            <span>{summary.semantic.nodeCount} semantic nodes</span>
            <span className={statusClass(ir?.calculationStatus ?? summary.semantic.calculationStatus)}>{(ir?.calculationStatus ?? summary.semantic.calculationStatus).replaceAll("_", " ")}</span>
            <span>Provider head {providerHead ? `v${summary.versions.find((version) => version.id === providerHead.version_id)?.version_ordinal ?? "?"}` : "unbound"}</span>
            <span>Local draft {localHead ? `v${summary.versions.find((version) => version.id === localHead)?.version_ordinal ?? "?"}` : "none"}</span>
          </div>
        </div>
        <div className="artifact-actions">
          <button className="btn" onClick={() => void run("download", () => downloadArtifact(id, selectedVersion))}>Download source</button>
          <button className="btn" onClick={compareToProvider} disabled={!providerHead || busy !== null}>Compare</button>
          <button className="btn btn-primary" onClick={beginDraft} disabled={busy !== null || summary.semantic.kind === "pdf"}>Start draft</button>
        </div>
      </header>

      {error && <div className="artifact-alert" role="alert">{error}</div>}
      {summary.semantic.warnings.length > 0 && <div className="artifact-warning">{summary.semantic.warnings.join(" · ")}</div>}

      <div className="artifact-shell">
        <aside className="artifact-timeline" aria-label="Version timeline">
          <h2>Versions</h2>
          {summary.versions.map((version) => {
            const heads = summary.heads.filter((head) => head.version_id === version.id).map((head) => head.kind);
            return (
              <button key={version.id} className={`artifact-version ${selectedVersion === version.id ? "selected" : ""}`} onClick={() => setSelectedVersion(version.id)}>
                <span className="artifact-version-number">v{version.version_ordinal}</span>
                <span>{version.origin.replaceAll("_", " ")}</span>
                <small>{new Date(version.created_at).toLocaleString()}</small>
                <span>{heads.map((head) => <b key={head} className="artifact-head">{head}</b>)}</span>
              </button>
            );
          })}
          <div className="artifact-truth-note">Provider and local draft heads stay separate. This view does not imitate Office rendering.</div>
        </aside>

        <main className="artifact-main-panel">
          <div className="artifact-panel-heading">
            <div><span className="artifact-kicker">Selected immutable version</span><h2>v{summary.versions.find((version) => version.id === selectedVersion)?.version_ordinal ?? "—"}</h2></div>
            <code>{short(ir?.semanticHash, 16)}</code>
          </div>
          {(ir?.kind === "xlsx" || ir?.kind === "xlsm") && <section className="artifact-sheet-view" aria-label="Bounded spreadsheet range">
            <div className="artifact-sheet-toolbar">
              <label>Worksheet <select value={selectedSheetId} onChange={(event) => setSelectedSheetId(event.target.value)}>{sheets.map((sheet) => <option key={sheet.id} value={sheet.id.replace(/^sheet:/, "")}>{String(sheet.data.name)}</option>)}</select></label>
              <span>{spreadsheetCells.length} loaded cells · bounded to 360</span>
            </div>
            <div className="table-wrap"><table className="table artifact-cell-grid"><thead><tr><th></th>{tableColumns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{tableRows.map((row) => <tr key={row}><th>{row}</th>{tableColumns.map((column) => { const node = cellByAddress.get(`${column}${row}`); return <td key={column}>{node ? <button className={selectedNodeId === node.id ? "selected" : ""} onClick={() => { setSelectedNodeId(node.id); setEditValue(String(node.data.formula ?? node.data.value ?? "")); }}>{String(node.data.formula ?? node.data.value ?? node.data.cached ?? "") || "·"}</button> : ""}</td>; })}</tr>)}</tbody></table></div>
            {ir.total > ir.nodes.length && <p className="artifact-muted">Showing a bounded semantic slice. Use the exact node API to inspect additional cells.</p>}
          </section>}
          <div className="artifact-node-layout">
            <div className="artifact-node-list">
              {!ir && <p className="pulse">Reading bounded IR…</p>}
              {groupedNodes.map(([kind, nodes]) => (
                <section key={kind}>
                  <h3>{kind} <span>{nodes.length}</span></h3>
                  {nodes.slice(0, 80).map((node) => <button key={node.id} className={selectedNodeId === node.id ? "selected" : ""} onClick={() => { setSelectedNodeId(node.id); setEditValue(String(node.data.formula ?? node.data.text ?? node.data.value ?? "")); }}>{String(node.data.address ?? node.data.name ?? node.data.text ?? node.id).slice(0, 90) || node.id}</button>)}
                </section>
              ))}
            </div>
            <section className="artifact-inspector">
              <h3>Exact node inspector</h3>
              {selectedNode ? <>
                <dl><dt>Anchor</dt><dd><code>{selectedNode.id}</code></dd><dt>Fingerprint</dt><dd><code>{short(selectedNode.hash, 18)}</code></dd><dt>Part</dt><dd>{selectedNode.part}</dd></dl>
                {selectedNode.kind === "cell" && <div className="artifact-cell-truth">
                  <h3>Spreadsheet truth</h3>
                  <dl>
                    <dt>Value</dt><dd>{JSON.stringify(selectedNode.data.value ?? null)}</dd>
                    <dt>Formula</dt><dd><code>{String(selectedNode.data.formula ?? "—")}</code></dd>
                    <dt>Cached</dt><dd>{JSON.stringify(selectedNode.data.cached ?? null)}</dd>
                    <dt>Calculation</dt><dd><span className={statusClass(String(selectedNode.data.calculation ?? ir?.calculationStatus ?? "unknown"))}>{String(selectedNode.data.calculation ?? ir?.calculationStatus ?? "unknown")}</span></dd>
                    <dt>Number format</dt><dd><code>{String(selectedNode.data.numberFormatCode ?? "General")}</code></dd>
                    <dt>Dependencies</dt><dd><pre>{JSON.stringify(selectedNode.data.dependencies ?? [], null, 2)}</pre></dd>
                    <dt>Dependents</dt><dd><pre>{JSON.stringify(selectedNode.data.dependents ?? [], null, 2)}</pre></dd>
                  </dl>
                </div>}
                <pre>{JSON.stringify(selectedNode.data, null, 2)}</pre>
                {draft && selectedVersion === draft.versionId && summary.semantic.kind !== "pdf" && <div className="artifact-editor">
                  {(ir?.kind === "xlsx" || ir?.kind === "xlsm") && <label><input type="checkbox" checked={editAsFormula} onChange={(event) => setEditAsFormula(event.target.checked)} /> Formula edit</label>}
                  <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} rows={5} aria-label="Typed artifact edit" />
                  <button className="btn btn-primary" onClick={saveEdit} disabled={busy !== null}>Create immutable draft version</button>
                </div>}
              </> : <p>Select a semantic node.</p>}
            </section>
          </div>
        </main>
      </div>

      <div className="artifact-lower-grid">
        <section className="card">
          <div className="artifact-panel-heading"><h2>Semantic diff</h2><button className="btn" onClick={compareToProvider}>Refresh</button></div>
          {diff ? <div className="table-wrap"><table className="table"><thead><tr><th>Change</th><th>Anchor</th></tr></thead><tbody>{diff.changes.map((change, index) => <tr key={`${change.id}-${index}`}><td><span className={statusClass(change.kind)}>{change.kind}</span></td><td><code>{change.id}</code></td></tr>)}</tbody></table></div> : <p className="artifact-muted">Compare the selected version with the provider head.</p>}
        </section>
        <section className="card">
          <h2>Sources & citations</h2>
          {selectedCollaboration?.bindings.length ? selectedCollaboration.bindings.map((binding, index) => <pre key={index}>{JSON.stringify(binding, null, 2)}</pre>) : <p className="artifact-muted">No exact node binding recorded for this version.</p>}
          <p className="artifact-muted">Bindings remain pinned to their source version and fingerprint.</p>
        </section>
        <section className="card">
          <h2>Editorial review</h2>
          <p><span className={statusClass(reviewState ?? "not requested")}>{reviewState?.replaceAll("_", " ") ?? "not requested"}</span></p>
          <div className="artifact-actions"><button className="btn" onClick={() => recordReview("requested")}>Request review</button><button className="btn" onClick={() => recordReview("approved")}>Editorial approve</button><button className="btn" onClick={() => recordReview("changes_requested")}>Request changes</button></div>
          <p className="artifact-muted">Editorial approval does not authorize external publication.</p>
        </section>
        <section className="card">
          <h2>Comments</h2>
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="Comment on the selected exact node" />
          <button className="btn" onClick={addComment} disabled={!selectedNode || !comment.trim()}>Add version-pinned comment</button>
          {selectedCollaboration?.comments.map((entry, index) => <div className="artifact-comment" key={String(entry.id ?? index)}>{String(entry.body ?? "")}</div>)}
        </section>
      </div>

      <section className="artifact-publish card">
        <div><span className="artifact-kicker">External effect</span><h2>Microsoft publication</h2><p>Exact provider eTag precondition → write acknowledgement → mandatory readback → semantic verification.</p></div>
        <div><button className="btn btn-primary" onClick={publish} disabled={!draft || !providerHead || busy !== null}>Publish local draft</button>{latestExternalOperation && <p className={statusClass(String(latestExternalOperation.status))}>{String(latestExternalOperation.status).replaceAll("_", " ")}</p>}</div>
      </section>
    </div>
  );
}
