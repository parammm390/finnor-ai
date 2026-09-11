"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { icStatusClass, readable, shortId, type IcRecord, type IcWorkspace } from "../../lib/ic";

const OUTCOMES = ["INVEST", "DECLINE", "DEFER", "INVEST_WITH_CONDITIONS", "CONTINUE_DILIGENCE"] as const;
const VOTE_CHOICES = ["APPROVE", "REJECT", "ABSTAIN", "DEFER"] as const;

function timestamp(value: unknown): string {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isFinite(date.valueOf()) ? date.toLocaleString() : "—";
}

function Pill({ value }: { value: unknown }) {
  return <span className={icStatusClass(value)}>{readable(value)}</span>;
}

function SourceList({ sources }: { sources: IcRecord[] }) {
  if (sources.length === 0) return <span className="ic-muted">No exact source attached</span>;
  return <ul className="ic-source-list">{sources.map((source) => (
    <li key={String(source.id)}><Pill value={source.truthStatus} /><span>{readable(source.sourceKind)}</span><span>{readable(source.relationship)}</span></li>
  ))}</ul>;
}

export default function IcWorkspaceClient({ icCaseId }: { icCaseId: string }) {
  const [workspace, setWorkspace] = useState<IcWorkspace | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [questionText, setQuestionText] = useState("");
  const [questionRequiredVote, setQuestionRequiredVote] = useState(true);
  const [questionRequiredDecision, setQuestionRequiredDecision] = useState(true);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [waiverReasons, setWaiverReasons] = useState<Record<string, string>>({});
  const [recommendationOutcome, setRecommendationOutcome] = useState<(typeof OUTCOMES)[number]>("INVEST");
  const [recommendationRationale, setRecommendationRationale] = useState("");
  const [voteChoice, setVoteChoice] = useState<(typeof VOTE_CHOICES)[number]>("APPROVE");
  const [voteRationale, setVoteRationale] = useState("");
  const [dissentRationale, setDissentRationale] = useState("");
  const [conditionTitle, setConditionTitle] = useState("");
  const [conditionDescription, setConditionDescription] = useState("");
  const [conditionOwner, setConditionOwner] = useState("");
  const [conditionReasons, setConditionReasons] = useState<Record<string, string>>({});
  const [decisionTitle, setDecisionTitle] = useState("");
  const [decisionRationale, setDecisionRationale] = useState("");

  const load = useCallback(async () => {
    const result = await api<IcWorkspace>(`/api/private-equity/ic/cases/${encodeURIComponent(icCaseId)}`);
    setWorkspace(result);
    setConditionOwner((current) => current || result.viewer.employeeId || "");
    setDecisionTitle((current) => current || `${result.investmentCase.title ?? "Investment"} — Investment Committee Decision`);
  }, [icCaseId]);

  useEffect(() => { load().catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load IC workspace")); }, [load]);

  async function run(label: string, path: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(label);
    setError(null);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await load();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "IC operation failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function key(prefix: string): string {
    return `console/${prefix}/${crypto.randomUUID()}`;
  }

  if (error && !workspace) return <div className="ic-alert bad" role="alert">{error}</div>;
  if (!workspace) return <div className="card pulse">Reconstructing exact IC process truth…</div>;

  const process = workspace.case;
  const aggregation = workspace.readiness.aggregation;
  const recommendation = workspace.currentRecommendation;
  const ownVote = workspace.votes.find((vote) => vote.employeeId === workspace.viewer.employeeId && vote.recommendationId === recommendation?.id);
  const ownDissent = workspace.dissents.find((dissent) => dissent.employeeId === workspace.viewer.employeeId);
  const actionRoot = `/api/private-equity/ic/cases/${encodeURIComponent(process.id)}`;
  const disabled = busy !== null;

  const transition = (name: string, path: string) => run(name, `${actionRoot}/${path}`, { expectedVersion: process.version });

  return (
    <div className="ic-workspace">
      <header className="ic-hero">
        <div>
          <a className="ic-back" href="/ic">← Investment Committee</a>
          <span className="ic-kicker">InvestmentCase {shortId(process.investmentCaseId)} · ICCase {shortId(process.id)}</span>
          <h1>{workspace.investmentCase.title ?? "Investment Committee Case"}</h1>
          <p>{workspace.investmentCase.summary ?? "No copied narrative. This workspace presents linked canonical truth."}</p>
        </div>
        <div className="ic-hero-state"><Pill value={process.state} /><span>Process v{process.version}</span><span>Vote set v{process.voteSetVersion}</span><small>Truth as of {timestamp(workspace.asOf)}</small></div>
      </header>

      {error ? <div className="ic-alert bad" role="alert">{error}</div> : null}
      {busy ? <div className="ic-alert" role="status">Applying {readable(busy)} through the governed boundary…</div> : null}

      <section className="ic-stat-grid" aria-label="IC readiness summary">
        <article className="card"><span>Eligible voters</span><strong>{aggregation?.counts.eligible ?? workspace.committee.members.filter((member) => member.votingEligible).length}</strong><small>pinned configuration v{String(workspace.committee.config.configVersion ?? "—")}</small></article>
        <article className="card"><span>Participation</span><strong>{aggregation ? `${aggregation.quorum.actual}/${aggregation.quorum.required}` : "—"}</strong><Pill value={aggregation?.quorum.status ?? "NOT OPEN"} /></article>
        <article className="card"><span>Threshold</span><strong>{aggregation?.threshold.requiredApprovals === null || aggregation?.threshold.requiredApprovals === undefined ? "—" : `${aggregation.threshold.actualApprovals}/${aggregation.threshold.requiredApprovals}`}</strong><Pill value={aggregation?.threshold.status ?? "NOT OPEN"} /></article>
        <article className="card"><span>Decision readiness</span><strong>{workspace.readiness.decisionEligible ? "READY" : "BLOCKED"}</strong><Pill value={aggregation?.process.status ?? process.state} /></article>
      </section>

      <section className="card ic-panel">
        <div className="ic-panel-head"><div><span className="ic-kicker">Backend-derived controls</span><h2>Process control</h2></div><Pill value={process.state} /></div>
        <div className="ic-actions">
          <button disabled={disabled || !workspace.controls.beginPreparation} onClick={() => void transition("begin preparation", "begin-preparation")}>Begin preparation</button>
          <button disabled={disabled || !["PREPARING", "QUESTIONS_OPEN", "BLOCKED"].includes(process.state)} onClick={() => void transition("ready for review", "ready-for-review")}>Ready for review</button>
          <button disabled={disabled || process.state !== "READY_FOR_REVIEW"} onClick={() => void transition("open questions", "open-questions")}>Open questions</button>
          <button disabled={disabled || !workspace.controls.markReadyForVote} onClick={() => void transition("ready for vote", "ready-for-vote")}>Ready for vote</button>
          <button disabled={disabled || !workspace.controls.openVoting || !recommendation?.id || !workspace.memo?.id || !process.primaryUnderwritingRunId} onClick={() => {
            if (!recommendation?.id || !workspace.memo?.id || !process.primaryUnderwritingRunId) return;
            void run("open voting", `${actionRoot}/voting/open`, {
              expectedCaseVersion: process.version,
              recommendationId: recommendation.id,
              memoId: workspace.memo.id,
              underwritingRunId: process.primaryUnderwritingRunId,
              idempotencyKey: key("open-voting"),
            });
          }}>Open voting</button>
        </div>
        {!workspace.readiness.votingEligible || !workspace.readiness.decisionEligible ? <div className="ic-blockers"><strong>Deterministic blockers</strong><ul>{workspace.readiness.blockers.length > 0 ? workspace.readiness.blockers.map((blocker) => <li key={blocker}>{readable(blocker)}</li>) : <li>State-specific transition preconditions remain</li>}</ul></div> : null}
      </section>

      <section className="ic-two-column">
        <article className="card ic-panel">
          <div className="ic-panel-head"><div><span className="ic-kicker">P3 owns artifact truth</span><h2>Memo and Deck</h2></div><Pill value={workspace.memo?.sourceCompleteness ?? "MISSING"} /></div>
          {workspace.memo && workspace.artifacts.memo ? <div className="ic-basis-card">
            <dl><dt>Memo revision</dt><dd>{String(workspace.memo.revision)}</dd><dt>DocumentVersion</dt><dd>{shortId(workspace.memo.documentVersionId, 16)}</dd><dt>Editorial review</dt><dd><Pill value={workspace.artifacts.memo.reviewState ?? "not reviewed"} /></dd><dt>Citations</dt><dd>{String(workspace.artifacts.memo.citationCount ?? 0)}</dd><dt>Material change</dt><dd><Pill value={workspace.memo.changeClassification} /></dd></dl>
            <a className="ic-link-button" href={`/artifacts/${workspace.memo.documentId}?versionId=${workspace.memo.documentVersionId}`}>Open exact P3 artifact ↗</a>
          </div> : <p className="ic-muted">No exact P3 Memo DocumentVersion is selected.</p>}
          {workspace.deck ? <p>Deck revision {String(workspace.deck.revision)} · DocumentVersion {shortId(workspace.deck.documentVersionId, 16)} <a href={`/artifacts/${workspace.deck.documentId}?versionId=${workspace.deck.documentVersionId}`}>Open ↗</a></p> : <p className="ic-muted">No Deck version selected.</p>}
        </article>

        <article className="card ic-panel">
          <div className="ic-panel-head"><div><span className="ic-kicker">P4 owns financial truth</span><h2>Primary UnderwritingRun</h2></div><Pill value={workspace.underwriting?.run.validity ?? "MISSING"} /></div>
          {workspace.underwriting ? <>
            <dl className="ic-definition"><dt>Run</dt><dd>{shortId(workspace.underwriting.run.id, 16)}</dd><dt>ModelVersion</dt><dd>{shortId(workspace.underwriting.run.modelVersionId, 16)}</dd><dt>Scenario</dt><dd>{shortId(workspace.underwriting.run.scenarioId, 16)}</dd><dt>worldAt</dt><dd>{timestamp(workspace.underwriting.run.worldAt)}</dd><dt>Result hash</dt><dd><code>{shortId(workspace.underwriting.run.resultHash, 22)}</code></dd></dl>
            <a className="ic-link-button" href={`/underwriting/${process.investmentCaseId}`}>Open P4 workspace ↗</a>
            <div className="ic-checks">{workspace.underwriting.checks.map((check, index) => <span key={String(check.nodeId ?? index)}><Pill value={check.passed === true ? "PASS" : "FAIL"} /> {String(check.nodeId ?? check.code ?? `check ${index + 1}`)}</span>)}</div>
          </> : <p className="ic-muted">No exact P4 Run is selected. FINNOR does not calculate substitute IC numbers.</p>}
        </article>
      </section>

      <section className="card ic-panel">
        <div className="ic-panel-head"><div><span className="ic-kicker">Question → Evidence → Work</span><h2>Questions</h2></div><span>{workspace.questions.length} total</span></div>
        <form className="ic-inline-form" onSubmit={(event) => { event.preventDefault(); if (!questionText.trim()) return; void run("create question", `${actionRoot}/questions`, { expectedCaseVersion: process.version, question: questionText, requiredBeforeVote: questionRequiredVote, requiredBeforeDecision: questionRequiredDecision, idempotencyKey: key("question") }).then((ok) => { if (ok) setQuestionText(""); }); }}>
          <label>New exact question<textarea value={questionText} onChange={(event) => setQuestionText(event.target.value)} maxLength={10_000} /></label>
          <label className="ic-checkbox"><input type="checkbox" checked={questionRequiredVote} onChange={(event) => setQuestionRequiredVote(event.target.checked)} /> Required before vote</label>
          <label className="ic-checkbox"><input type="checkbox" checked={questionRequiredDecision} onChange={(event) => setQuestionRequiredDecision(event.target.checked)} /> Required before Decision</label>
          <button disabled={disabled || !workspace.controls.createQuestion || !questionText.trim()}>Open Question</button>
        </form>
        <div className="ic-stack">{workspace.questions.map((question) => (
          <article className="ic-item" key={question.id}>
            <div className="ic-item-head"><div><Pill value={question.state} /> <Pill value={question.substantiationStatus} /></div><span>v{String(question.version ?? "—")}</span></div>
            <h3>{question.question}</h3>
            <p>{question.answer ?? "No answer recorded. Answer text alone never marks this Question resolved."}</p>
            <div className="ic-requirements"><span>{question.requiredBeforeVote ? "Required before vote" : "Not vote-blocking"}</span><span>{question.requiredBeforeDecision ? "Required before Decision" : "Not Decision-blocking"}</span><span>Work {shortId(question.workId)}</span></div>
            <SourceList sources={question.sources} />
            {question.state === "OPEN" ? <div className="ic-row-form"><input aria-label={`Answer ${question.question}`} placeholder="Grounded answer" value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /><button disabled={disabled || !(answers[question.id] ?? "").trim()} onClick={() => void run("answer question", `${actionRoot}/questions/${question.id}/answer`, { expectedQuestionVersion: question.version, answer: answers[question.id] })}>Record answer</button></div> : null}
            {question.state === "ANSWERED" ? <button disabled={disabled || question.sources.length === 0} onClick={() => void run("resolve question", `${actionRoot}/questions/${question.id}/resolve`, { expectedQuestionVersion: question.version })}>Resolve from attached evidence</button> : null}
            {["OPEN", "ANSWERED"].includes(String(question.state)) ? <div className="ic-row-form"><input aria-label={`Waiver reason for ${question.question}`} placeholder="Governed waiver reason" value={waiverReasons[question.id] ?? ""} onChange={(event) => setWaiverReasons((current) => ({ ...current, [question.id]: event.target.value }))} /><button className="danger" disabled={disabled || !(waiverReasons[question.id] ?? "").trim()} onClick={() => void run("waive question", `${actionRoot}/questions/${question.id}/waive`, { expectedQuestionVersion: question.version, reason: waiverReasons[question.id], idempotencyKey: key("waive-question") })}>Waive with Authority</button></div> : null}
          </article>
        ))}</div>
      </section>

      <section className="ic-two-column">
        <article className="card ic-panel">
          <div className="ic-panel-head"><div><span className="ic-kicker">Immutable revisions</span><h2>Recommendation</h2></div><Pill value={recommendation?.outcome ?? "MISSING"} /></div>
          {recommendation ? <><p>{recommendation.rationale}</p><dl className="ic-definition"><dt>Revision</dt><dd>{String(recommendation.revision)}</dd><dt>Memo</dt><dd>{shortId(recommendation.memoId)}</dd><dt>Run</dt><dd>{shortId(recommendation.underwritingRunId)}</dd></dl></> : <p className="ic-muted">No official Recommendation revision exists.</p>}
          <form className="ic-inline-form" onSubmit={(event) => { event.preventDefault(); if (!recommendationRationale.trim()) return; void run("record recommendation", `${actionRoot}/recommendations`, { expectedCaseVersion: process.version, outcome: recommendationOutcome, rationale: recommendationRationale, idempotencyKey: key("recommendation") }).then((ok) => { if (ok) setRecommendationRationale(""); }); }}>
            <label>Outcome<select value={recommendationOutcome} onChange={(event) => setRecommendationOutcome(event.target.value as (typeof OUTCOMES)[number])}>{OUTCOMES.map((outcome) => <option key={outcome}>{outcome}</option>)}</select></label>
            <label>Grounded rationale<textarea value={recommendationRationale} onChange={(event) => setRecommendationRationale(event.target.value)} maxLength={20_000} /></label>
            <button disabled={disabled || !workspace.controls.createRecommendation || !recommendationRationale.trim()}>Create next revision</button>
          </form>
        </article>

        <article className="card ic-panel">
          <div className="ic-panel-head"><div><span className="ic-kicker">Authenticated human attestation</span><h2>Your Vote</h2></div><Pill value={ownVote?.choice ?? "NOT RECORDED"} /></div>
          <p>Basis: Recommendation {shortId(recommendation?.id)} · Memo {shortId(workspace.memo?.id)} · Run {shortId(process.primaryUnderwritingRunId)}.</p>
          {!ownVote ? <form className="ic-inline-form" onSubmit={(event) => { event.preventDefault(); if (!recommendation?.id || !workspace.memo?.id || !process.primaryUnderwritingRunId || !process.votingBasisVersion) return; void run("record vote", `${actionRoot}/votes`, { recommendationId: recommendation.id, memoId: workspace.memo.id, underwritingRunId: process.primaryUnderwritingRunId, expectedVotingBasisVersion: process.votingBasisVersion, choice: voteChoice, ...(voteRationale.trim() ? { rationale: voteRationale } : {}), idempotencyKey: key("vote") }); }}>
            <label>Choice<select value={voteChoice} onChange={(event) => setVoteChoice(event.target.value as (typeof VOTE_CHOICES)[number])}>{VOTE_CHOICES.map((choice) => <option key={choice}>{choice}</option>)}</select></label>
            <label>Rationale<textarea value={voteRationale} onChange={(event) => setVoteRationale(event.target.value)} maxLength={10_000} /></label>
            <button disabled={disabled || !workspace.controls.recordVote}>Record my immutable Vote</button>
          </form> : <p>{ownVote.rationale ?? "No rationale supplied."} · recorded {timestamp(ownVote.recordedAt)}</p>}
          {ownVote && !ownDissent ? <form className="ic-inline-form" onSubmit={(event) => { event.preventDefault(); if (!dissentRationale.trim()) return; void run("record dissent", `${actionRoot}/dissents`, { voteId: ownVote.id, rationale: dissentRationale, idempotencyKey: key("dissent") }); }}><label>Dissent rationale<textarea value={dissentRationale} onChange={(event) => setDissentRationale(event.target.value)} maxLength={20_000} /></label><button disabled={disabled || !workspace.controls.recordDissent || !dissentRationale.trim()}>Preserve Dissent</button></form> : null}
        </article>
      </section>

      <section className="card ic-panel">
        <div className="ic-panel-head"><div><span className="ic-kicker">First-class IC terms</span><h2>Conditions</h2></div><span>{workspace.conditions.length} total</span></div>
        <form className="ic-inline-form condition" onSubmit={(event) => { event.preventDefault(); if (!conditionTitle.trim() || !conditionDescription.trim() || !conditionOwner) return; void run("create condition", `${actionRoot}/conditions`, { expectedCaseVersion: process.version, conditionType: "PRE_DECISION", title: conditionTitle, description: conditionDescription, ownerEmployeeId: conditionOwner, required: true, evidenceRequired: true, idempotencyKey: key("condition") }).then((ok) => { if (ok) { setConditionTitle(""); setConditionDescription(""); } }); }}>
          <label>Title<input value={conditionTitle} onChange={(event) => setConditionTitle(event.target.value)} maxLength={500} /></label><label>Description<textarea value={conditionDescription} onChange={(event) => setConditionDescription(event.target.value)} maxLength={10_000} /></label><label>Canonical owner employee<input value={conditionOwner} onChange={(event) => setConditionOwner(event.target.value)} /></label><button disabled={disabled || !recommendation || !conditionTitle.trim() || !conditionDescription.trim() || !conditionOwner}>Create PRE_DECISION Condition</button>
        </form>
        <div className="ic-stack">{workspace.conditions.map((condition) => (
          <article className="ic-item" key={condition.id}><div className="ic-item-head"><div><Pill value={condition.state} /> <Pill value={condition.conditionType} /></div><span>v{String(condition.version ?? "—")}</span></div><h3>{condition.title}</h3><p>{condition.description}</p><div className="ic-requirements"><span>Owner {shortId(condition.ownerEmployeeId)}</span><span>{condition.required ? "Required" : "Optional"}</span><span>{condition.evidenceRequired ? "Evidence required" : "No evidence required"}</span></div><SourceList sources={condition.sources} />
            {condition.state === "PROPOSED" ? <button disabled={disabled} onClick={() => void run("activate condition", `${actionRoot}/conditions/${condition.id}/activate`, { expectedConditionVersion: condition.version })}>Activate</button> : null}
            {condition.state === "ACTIVE" && process.primaryUnderwritingRunId ? <button disabled={disabled} onClick={() => void run("satisfy condition", `${actionRoot}/conditions/${condition.id}/satisfy`, { expectedConditionVersion: condition.version, verification: { source: { kind: "UNDERWRITING_RUN", underwritingRunId: process.primaryUnderwritingRunId }, relationship: "VERIFIES", idempotencyKey: key("condition-verification") } })}>Satisfy from exact primary Run</button> : null}
            {condition.state === "ACTIVE" ? <div className="ic-row-form"><input aria-label={`Waiver reason for ${condition.title}`} placeholder="Governed waiver reason" value={conditionReasons[condition.id] ?? ""} onChange={(event) => setConditionReasons((current) => ({ ...current, [condition.id]: event.target.value }))} /><button className="danger" disabled={disabled || !(conditionReasons[condition.id] ?? "").trim()} onClick={() => void run("waive condition", `${actionRoot}/conditions/${condition.id}/waive`, { expectedConditionVersion: condition.version, reason: conditionReasons[condition.id], idempotencyKey: key("waive-condition") })}>Waive with Authority</button></div> : null}
          </article>
        ))}</div>
      </section>

      <section className="card ic-panel decision">
        <div className="ic-panel-head"><div><span className="ic-kicker">P1 owns the canonical investment Decision</span><h2>Decision</h2></div><Pill value={workspace.decision?.state ?? aggregation?.process.status ?? "NOT READY"} /></div>
        {workspace.decision ? <div className="ic-decision"><h3>{workspace.decision.title}</h3><strong>{readable(workspace.decision.decision)}</strong><p>{workspace.decision.rationale}</p><dl className="ic-definition"><dt>Decision ID</dt><dd>{String(workspace.decision.id)}</dd><dt>Effective</dt><dd>{timestamp(workspace.decision.decidedAt)}</dd><dt>Supersedes</dt><dd>{shortId(workspace.decision.supersedesDecisionId, 16)}</dd><dt>Provenance</dt><dd><code>{shortId(workspace.decisionProposal?.provenanceHash, 24)}</code></dd></dl><span className="ic-muted">Machine-readable proof is loaded from the authenticated API and shown above.</span></div> : <>
          <div className="ic-vote-breakdown"><span>Approve <strong>{aggregation?.counts.approve ?? 0}</strong></span><span>Reject <strong>{aggregation?.counts.reject ?? 0}</strong></span><span>Abstain <strong>{aggregation?.counts.abstain ?? 0}</strong></span><span>Defer <strong>{aggregation?.counts.defer ?? 0}</strong></span><span>Dissents <strong>{workspace.dissents.length}</strong></span></div>
          {process.state === "VOTING" ? <div className="ic-actions"><button disabled={disabled} onClick={() => void run("prepare proposal", `${actionRoot}/decision-proposals`, { expectedCaseVersion: process.version, expectedVoteSetVersion: process.voteSetVersion, idempotencyKey: key("proposal") })}>Preview exact DecisionProposal</button><button disabled={disabled || !workspace.controls.closeVoting} onClick={() => void run("close voting", `${actionRoot}/voting/close`, { expectedCaseVersion: process.version, expectedVoteSetVersion: process.voteSetVersion, idempotencyKey: key("close-voting") })}>Close voting and freeze proposal</button></div> : null}
          {process.state === "CONDITIONS_PENDING" && workspace.decisionProposal ? <form className="ic-inline-form" onSubmit={(event) => { event.preventDefault(); if (!decisionTitle.trim() || !decisionRationale.trim()) return; void run("finalize decision", `${actionRoot}/finalize`, { decisionProposalId: workspace.decisionProposal?.id, expectedCaseVersion: process.version, title: decisionTitle, rationale: decisionRationale, idempotencyKey: key("final-decision") }); }}><label>Decision title<input value={decisionTitle} onChange={(event) => setDecisionTitle(event.target.value)} maxLength={500} /></label><label>Human rationale<textarea value={decisionRationale} onChange={(event) => setDecisionRationale(event.target.value)} maxLength={20_000} /></label><button disabled={disabled || !workspace.controls.finalizeDecision || !decisionTitle.trim() || !decisionRationale.trim()}>Finalize canonical P1 Decision</button></form> : null}
        </>}
        {workspace.dissents.length > 0 ? <div className="ic-dissents"><h3>Preserved Dissents</h3>{workspace.dissents.map((dissent) => <article key={dissent.id}><Pill value="DISSENT" /><p>{dissent.rationale}</p><SourceList sources={dissent.sources} /></article>)}</div> : null}
      </section>
    </div>
  );
}
