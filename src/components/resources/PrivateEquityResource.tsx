import Link from "next/link"
import { ArrowRight, CheckCircle2, FileSearch, GitBranch, LockKeyhole, Scale, ShieldCheck } from "lucide-react"

import FinnorNavigation from "@/components/rebuild/FinnorNavigation"
import { siteConfig } from "@/config/site"
import styles from "./PrivateEquityResource.module.css"

export type PrivateEquityResourceKind = "hub" | "glossary" | "drag" | "readiness" | "trust"

const cards = [
  { href: "/resources/operating-glossary", eyebrow: "REFERENCE", title: "PE operating glossary", text: "Exact language for objects, lineage, Work, Authority, evidence, receipts, proof, and governed agents." },
  { href: "/resources/operational-drag-estimator", eyebrow: "WORKSHEET", title: "Decision-to-execution drag", text: "A transparent worksheet for measuring handoffs and reconciliation effort without inventing an ROI claim." },
  { href: "/resources/deployment-readiness-checklist", eyebrow: "CHECKLIST", title: "Deployment readiness", text: "The source, tenant, authority, recovery, runtime, and evidence questions required before activation." },
  { href: "/trust-safety", eyebrow: "CONTROL MODEL", title: "Trust, authority, and evidence", text: "How FINNOR keeps visibility separate from permission and verified change separate from provider acknowledgement." },
] as const

const glossary = [
  ["Company Brain", "A deterministic, tenant-scoped read projection over existing canonical PE and platform truth. It is not a parallel database or inferred knowledge graph."],
  ["PE root", "A canonical Strategy, Opportunity, or Deal reference used to bound Company Brain, Activity, Work, and workforce projections."],
  ["Epistemic state", "KNOWN, UNKNOWN, STALE, or CONFLICTING—the explicit support state attached to a fact and its sources."],
  ["Underwriting lineage", "The persisted connection from model and version through scenario, run, sensitivity, inputs, and material outputs."],
  ["Decision lineage", "The persisted path among IC case, memo, question, recommendation, vote, dissent, condition, DecisionProposal, and final Decision."],
  ["Work", "The existing durable execution root carrying goals, plan revisions, nodes, actions, effects, receipts, proof, recovery, and attention."],
  ["Authority", "The existing policy boundary that evaluates an exact operation, resource, and revision. Surface visibility is not permission."],
  ["DecisionReceipt", "A durable record of what was proposed, evaluated, attempted, changed, and observed at an execution boundary."],
  ["CompletionProof", "Persisted verification that a completion criterion is satisfied. A success-looking event is not a substitute."],
  ["Semantic Activity", "Meaningful change projected deterministically from canonical P1–P7 records and grouped into Needs Attention, In Motion, or Verified Outcomes."],
  ["Governed agent", "An AgentProfile and immutable revision with bounded grants, budgets, assignments, outcomes, and reviewed learning—never autonomous investment authority."],
] as const

const readiness = [
  ["Canonical truth", "PE roots, objects, source ownership, versions, temporal support, and conflict semantics are identified."],
  ["Tenant boundary", "Direct lookup, search, traversal, provenance, history, and inspection fail closed across tenants."],
  ["Decision lineage", "Underwriting and IC paths use persisted links; chronology and similar text never become fabricated causality."],
  ["Work contract", "Goals, plan revisions, dependencies, action resources, effects, receipts, proof, and recovery are exact."],
  ["Authority", "Human and automated boundaries are explicit, deny by default, and evaluated again at execution."],
  ["Workspace", "Home, Deals, Work, and Agents resolve from one Workspace V3 contract with no legacy semantic parser."],
  ["Runtime truth", "Release SHA, protocol, migration head, worker fleet, and authority state agree across deployed components."],
  ["Activation", "All legacy product blockers are terminalized by the existing retirement protocol before final PE authority is activated."],
] as const

const trust = [
  ["Source-backed by construction", "Every visible fact carries source references and an as-of time. Derivations identify their input references."],
  ["Uncertainty remains visible", "Unknown, stale, and conflicting evidence is not coerced into a confident status or narrative."],
  ["Exact inspection", "Every rendered Company Brain object and semantic activity item resolves to a typed inspection target."],
  ["Tenant-scoped composition", "The authenticated session supplies tenant context; client-supplied tenant identifiers are rejected."],
  ["Authority at execution", "Candidate actions do not imply permission. Policy and Authority evaluate the exact operation, resource, and revision."],
  ["Durable verification", "BusinessEffect state, DecisionReceipts, CompletionProofs, and reconciliation establish outcomes—not provider acknowledgement alone."],
  ["Governed workforce", "Agents act through explicit profiles, revisions, grants, budgets, Work assignments, and reviewable learning."],
  ["Human investment judgment", "FINNOR does not autonomously approve investments, cast IC votes, or convert supporting analysis into final investment authority."],
] as const

function ResourceHeader({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return <header className={styles.hero}><span>{eyebrow}</span><h1>{title}</h1><p>{body}</p></header>
}

function Hub() {
  return <><ResourceHeader eyebrow="FINNOR FIELD NOTES" title="Operational clarity for PE decisions and execution." body="These resources explain the product’s object, lineage, authority, evidence, and activation model without substituting marketing prose for verified capability." /><section className={styles.cards}>{cards.map((card) => <Link href={card.href} key={card.href}><span>{card.eyebrow}</span><h2>{card.title}</h2><p>{card.text}</p><footer>Open resource <ArrowRight size={14} /></footer></Link>)}</section></>
}

function Glossary() {
  return <><ResourceHeader eyebrow="OPERATING GLOSSARY" title="The exact nouns behind FINNOR." body="Precise product language keeps canonical truth, projections, execution, and authority from collapsing into generic AI claims." /><section className={styles.rows}>{glossary.map(([term, definition]) => <article key={term}><h2>{term}</h2><p>{definition}</p></article>)}</section></>
}

function Drag() {
  return <><ResourceHeader eyebrow="TRANSPARENT WORKSHEET" title="Measure decision-to-execution drag without fabricating value." body="Use observed counts and elapsed time from your own process. FINNOR does not turn these inputs into an unsupported revenue, return, or investment-performance claim." /><section className={styles.formula}><article><FileSearch /><h2>Evidence reconciliation</h2><p>Conflicting or stale source checks × observed analyst minutes per check.</p></article><article><GitBranch /><h2>Decision handoffs</h2><p>Unresolved review handoffs × observed waiting time before an accountable owner acts.</p></article><article><Scale /><h2>Execution verification</h2><p>Actions lacking receipt or proof × observed reconciliation time after attempted execution.</p></article><footer><strong>Total observed coordination load</strong><p>Use the sum as a baseline only. Keep assumptions, sample window, exclusions, and source records beside it.</p></footer></section></>
}

function Readiness() {
  return <><ResourceHeader eyebrow="DEPLOYMENT READINESS" title="Evidence required before production activation." body="A persuasive interface is not a readiness signal. Each boundary below needs an inspectable, testable answer." /><section className={styles.rows}>{readiness.map(([title, body]) => <article key={title}><CheckCircle2 /><div><h2>{title}</h2><p>{body}</p></div></article>)}</section></>
}

function Trust() {
  return <><ResourceHeader eyebrow="TRUST + SAFETY" title="Visibility, recommendation, permission, and execution stay separate." body="FINNOR is designed to make the source, uncertainty, lineage, authority decision, attempted effect, and verified outcome inspectable." /><section className={styles.rows}>{trust.map(([title, body], index) => <article key={title}>{index % 2 ? <ShieldCheck /> : <LockKeyhole />}<div><h2>{title}</h2><p>{body}</p></div></article>)}</section></>
}

export function PrivateEquityResource({ kind }: { kind: PrivateEquityResourceKind }) {
  return <div className={styles.page}><FinnorNavigation /><main>{kind === "hub" ? <Hub /> : kind === "glossary" ? <Glossary /> : kind === "drag" ? <Drag /> : kind === "readiness" ? <Readiness /> : <Trust />}<section className={styles.cta}><span>PRIVATE EQUITY DECISION + EXECUTION INFRASTRUCTURE</span><h2>Map one consequential workflow from canonical truth to durable proof.</h2><a href={siteConfig.calendlyLink} target="_blank" rel="noreferrer">Book an operating review <ArrowRight size={14} /></a></section></main></div>
}
