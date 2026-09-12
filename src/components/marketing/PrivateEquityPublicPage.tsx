"use client"

import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import Link from "next/link"
import { useRef, useState } from "react"
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  CheckCircle2,
  CircleDot,
  FileCheck2,
  GitBranch,
  LockKeyhole,
  Network,
  Scale,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react"

import { siteConfig } from "@/config/site"
import { DEPLOYMENT_START_USD, faqItems, productCategory, productPillars } from "@/content/commercial-truth"
import FinnorNavigation from "@/components/rebuild/FinnorNavigation"
import { FinnorMark } from "@/components/rebuild/FinnorMark"
import styles from "./PrivateEquityPublicPage.module.css"

gsap.registerPlugin(ScrollTrigger, useGSAP)

export type PrivateEquityPublicRoute = "home" | "product" | "capabilities" | "how-it-works" | "pricing" | "faq"

const routeCopy: Record<PrivateEquityPublicRoute, { eyebrow: string; title: string; body: string }> = {
  home: {
    eyebrow: productCategory,
    title: "The decision record and the execution record belong together.",
    body: "FINNOR connects canonical deal truth, underwriting lineage, IC governance, Work, evidence, receipts, and governed AI workers in one inspectable operating surface.",
  },
  product: {
    eyebrow: "Product / JARVIS + Company Brain",
    title: "Move from investment context to governed execution without losing lineage.",
    body: "The Company Brain composes the existing PE truth model. JARVIS turns that source-backed context into inspectable attention, bounded Work, and exact authority requests.",
  },
  capabilities: {
    eyebrow: "Capabilities / P1–P7 projected",
    title: "Seven existing systems of record. One coherent PE operating surface.",
    body: "FINNOR projects the truth, epistemic, underwriting, IC, planning, execution, evidence, and workforce layers already persisted—without inventing another graph or source of truth.",
  },
  "how-it-works": {
    eyebrow: "Deployment / evidence before activation",
    title: "Map the truth. Bind authority. Prove the operating chain.",
    body: "A deployment starts with sources and decision boundaries, then certifies one consequential PE workflow through normal, failure, recovery, and proof paths before broader activation.",
  },
  pricing: {
    eyebrow: "Commercial scope / implementation-led",
    title: "Pricing follows the operating boundary, not a seat count.",
    body: "Scope is driven by source quality, integrations, PE workflows, authority, workspace requirements, recovery testing, production activation, and support.",
  },
  faq: {
    eyebrow: "Direct answers / precise boundaries",
    title: "What FINNOR does—and what it never implies.",
    body: "The short version: FINNOR improves inspectability and governed execution. It does not replace investment judgment or grant autonomous investment authority.",
  },
}

const syntheticObjects = [
  { kind: "Deal", label: "Project Northstar", state: "DILIGENCE", tone: "blue", epistemic: "KNOWN", sources: "synthetic:deal:v3", lineage: "Opportunity → Deal → InvestmentCase", action: "Inspect deal context" },
  { kind: "InvestmentCase", label: "Base case · v12", state: "CURRENT", tone: "ink", epistemic: "KNOWN", sources: "synthetic:investment_case:v12", lineage: "Deal → InvestmentCase → UnderwritingRun", action: "Open IC preparation" },
  { kind: "Finding", label: "Customer concentration", state: "OPEN", tone: "amber", epistemic: "CONFLICTING", sources: "synthetic:cohort:v7 · synthetic:ledger:v18", lineage: "Finding → DealRisk → Work", action: "Request reconciliation" },
  { kind: "DealRisk", label: "Revenue durability", state: "ACTIVE", tone: "red", epistemic: "UNCERTAIN", sources: "synthetic:risk:v4", lineage: "Finding → DealRisk → Workstream", action: "Raise governed Work" },
  { kind: "Work", label: "Validate top-10 retention", state: "IN MOTION", tone: "violet", epistemic: "KNOWN", sources: "synthetic:work:v4", lineage: "Work → PlanRevision → PlanNode", action: "Inspect execution proof" },
  { kind: "EvidenceVersion", label: "Cohort export · hash 81bc", state: "KNOWN", tone: "green", epistemic: "KNOWN", sources: "synthetic:evidence_version:81bc", lineage: "EvidenceSource → EvidenceVersion → Finding", action: "Inspect provenance" },
  { kind: "ICQuestion", label: "Downside protection", state: "UNRESOLVED", tone: "amber", epistemic: "UNKNOWN", sources: "synthetic:ic_question:v2", lineage: "ICCase → ICQuestion → DecisionProposal", action: "Attach evidence" },
  { kind: "Decision", label: "Final IC record", state: "NOT YET RECORDED", tone: "muted", epistemic: "UNKNOWN", sources: "Known empty · no synthetic decision row", lineage: "DecisionProposal → Decision", action: "No decision action available" },
] as const

const relationshipRows = [
  ["Finding", "raises", "DealRisk"],
  ["DealRisk", "requires", "Work"],
  ["Work", "supported by", "EvidenceVersion"],
  ["InvestmentCase", "contains", "UnderwritingModelVersion"],
  ["ICQuestion", "governs", "DecisionProposal"],
  ["CompletionProof", "verifies", "Work"],
] as const

const activityRows = [
  { bucket: "NEEDS ATTENTION", title: "Customer concentration evidence conflicts", detail: "Two persisted source observations disagree. No cause inferred.", meta: "Finding → Risk · CONFLICTING" },
  { bucket: "IN MOTION", title: "Retention validation plan revision opened", detail: "Three nodes, one predecessor edge, one human boundary.", meta: "Work · PlanRevision 4" },
  { bucket: "VERIFIED OUTCOME", title: "Cohort reconciliation proof finalized", detail: "CompletionProof and DecisionReceipt reference the exact evidence version.", meta: "Proof · Receipt · KNOWN" },
] as const

const deploymentSteps = [
  ["01", "Truth census", "Identify canonical PE roots, source ownership, versions, freshness, conflicts, and tenant boundaries."],
  ["02", "Workflow + authority map", "Define Work, decisions, human boundaries, exact action resources, failure modes, and prohibited autonomy."],
  ["03", "Workspace configuration", "Configure the owner surface around Home, Deals, Work, and Agents from one generated contract."],
  ["04", "Certification", "Exercise the normal, failure, recovery, receipt, proof, and cross-tenant denial paths."],
  ["05", "Production activation", "Activate only after runtime truth, release consistency, data readiness, and authority gates all pass."],
] as const

function SyntheticBrain() {
  const [selectedIndex, setSelectedIndex] = useState(2)
  const selected = syntheticObjects[selectedIndex]
  return (
    <section className={styles.demo} aria-labelledby="synthetic-brain-title" data-reveal>
      <header className={styles.sectionHeader}>
        <div>
          <span>SYNTHETIC CONTRACT WALKTHROUGH · NOT LIVE ACTIVITY</span>
          <h2 id="synthetic-brain-title">Inspect the object, its evidence, and the work it creates.</h2>
        </div>
        <p>Project Northstar is a structurally representative, explicitly synthetic example. It makes no production or investment-performance claim.</p>
      </header>

      <div className={styles.brainLayout} data-pin-zone>
        <aside className={styles.objectRail}>
          <header><BrainCircuit size={16} /> Company Brain</header>
          {syntheticObjects.map((object, index) => (
            <button type="button" key={`${object.kind}:${object.label}`} data-active={index === selectedIndex ? "true" : "false"} onClick={() => setSelectedIndex(index)} aria-pressed={index === selectedIndex}>
              <span><small>{object.kind}</small><strong>{object.label}</strong></span>
              <em data-tone={object.tone}>{object.state}</em>
            </button>
          ))}
        </aside>

        <div className={styles.graphStage} data-graph-stage>
          <header><Network size={16} /><span>Synthetic relationship ledger</span><b>6 explicit edges</b></header>
          <div className={styles.graphObject}>
            <span>SELECTED OBJECT</span>
            <h3>{selected.label}</h3>
            <p>{selected.kind} · {selected.state} · synthetic root Project Northstar</p>
          </div>
          <div className={styles.relationships}>
            {relationshipRows.map(([from, relationship, to]) => (
              <div key={`${from}:${relationship}:${to}`}>
                <span>{from}</span><i /><em>{relationship}</em><i /><strong>{to}</strong>
              </div>
            ))}
          </div>
        </div>

        <aside className={styles.inspector} data-pin-inspector>
          <header><SearchCheck size={16} /><span>Exact inspection</span></header>
          <div><small>EPISTEMIC STATE</small><strong className={selected.epistemic === "CONFLICTING" ? styles.conflicting : undefined}>{selected.epistemic}</strong></div>
          <div><small>SYNTHETIC SOURCE REFS</small><strong>{selected.sources}</strong><p>Illustrative identifiers only; no production source is represented.</p></div>
          <div><small>LINEAGE</small><strong>{selected.lineage}</strong><p>The production projection requires a source reference on every edge.</p></div>
          <div><small>CANDIDATE ACTION</small><strong>{selected.action}</strong><p>Illustrative only; production Authority is evaluated at execution.</p></div>
        </aside>
      </div>
    </section>
  )
}

function ActivityTheater() {
  return (
    <section className={styles.activity} data-reveal>
      <div className={styles.sectionHeader}>
        <div><span>SEMANTIC ACTIVITY</span><h2>Meaningful change, grouped by operating consequence.</h2></div>
        <p>Primary activity is deterministically projected from canonical state and change records. Chronology alone never becomes causality.</p>
      </div>
      <div className={styles.activityTrack}>
        {activityRows.map((row) => (
          <article key={row.bucket}>
            <span>{row.bucket}</span><h3>{row.title}</h3><p>{row.detail}</p><footer>{row.meta}<ArrowRight size={14} /></footer>
          </article>
        ))}
      </div>
    </section>
  )
}

function CapabilityGrid() {
  const icons = [Network, GitBranch, Scale, Workflow, ShieldCheck, FileCheck2, Bot]
  return (
    <section className={styles.capabilities} id="capabilities" data-reveal>
      <div className={styles.sectionHeader}>
        <div><span>THE OPERATING STACK</span><h2>Decision infrastructure that survives contact with execution.</h2></div>
        <p>Each layer remains owned by its canonical package and projected into JARVIS. Visibility does not grant mutation authority.</p>
      </div>
      <div className={styles.capabilityGrid}>
        {productPillars.map((pillar, index) => {
          const Icon = icons[index]
          return <article key={pillar.name}><Icon size={19} /><small>0{index + 1}</small><h3>{pillar.name}</h3><strong>{pillar.verb}</strong><p>{pillar.copy}</p></article>
        })}
      </div>
    </section>
  )
}

function Deployment() {
  return (
    <section className={styles.deployment} data-reveal>
      <div className={styles.sectionHeader}>
        <div><span>HOW IT REACHES PRODUCTION</span><h2>Activation is the last step, not the first promise.</h2></div>
        <p>The operating boundary is certified against actual sources, authority, runtime truth, recovery, and evidence before production authority can move.</p>
      </div>
      <div className={styles.deploymentRows}>{deploymentSteps.map(([number, title, body]) => <article key={number}><b>{number}</b><h3>{title}</h3><p>{body}</p></article>)}</div>
    </section>
  )
}

function Pricing() {
  return (
    <section className={styles.pricing} data-reveal>
      <div><span>IMPLEMENTATION BOUNDARY</span><h2>Production deployments start around ${DEPLOYMENT_START_USD.toLocaleString("en-US")}.</h2><p>Final scope depends on source quality, integration depth, PE workflows, authority requirements, workspace engineering, recovery testing, reliability, activation, and support.</p></div>
      <ul>
        <li><CheckCircle2 size={16} /> Canonical source and relationship mapping</li>
        <li><CheckCircle2 size={16} /> Underwriting and IC lineage configuration</li>
        <li><CheckCircle2 size={16} /> Work, authority, execution, receipt, and proof paths</li>
        <li><CheckCircle2 size={16} /> Tenant isolation and failure-path certification</li>
      </ul>
      <p className={styles.pricingNote}>No ROI, readiness, integration, or outcome is implied before it is verified for the specific deployment.</p>
    </section>
  )
}

function FAQ() {
  return <section className={styles.faq} data-reveal><div className={styles.sectionHeader}><div><span>FAQ</span><h2>Specific answers. Explicit boundaries.</h2></div></div><div>{faqItems.map((item, index) => <details key={item.question} open={index === 0}><summary>{item.question}<span>+</span></summary><p>{item.answer}</p></details>)}</div></section>
}

function PublicFooter() {
  return <footer className={styles.footer}><div><Link href="/" aria-label="FINNOR home"><FinnorMark /><strong>FINNOR</strong></Link><p>{productCategory}. Source-backed context, explicit uncertainty, exact authority, and durable proof.</p></div><nav aria-label="Footer"><Link href="/product">Product</Link><Link href="/resources">Resources</Link><Link href="/trust-safety">Trust</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav><span>Human investment authority remains human.</span></footer>
}

export default function PrivateEquityPublicPage({ route }: { route: PrivateEquityPublicRoute }) {
  const root = useRef<HTMLDivElement>(null)
  const copy = routeCopy[route]
  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    gsap.from("[data-hero-copy] > *", { opacity: 0, y: 24, duration: 0.75, stagger: 0.08, ease: "power3.out" })
    gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((section) => gsap.from(section, { opacity: 0, y: 38, duration: 0.8, ease: "power2.out", scrollTrigger: { trigger: section, start: "top 86%", once: true } }))
    const graph = root.current?.querySelector<HTMLElement>("[data-graph-stage]")
    if (graph) gsap.from(graph, { scale: 0.94, opacity: 0.45, ease: "none", scrollTrigger: { trigger: graph, start: "top 82%", end: "top 35%", scrub: true } })
    const zone = root.current?.querySelector<HTMLElement>("[data-pin-zone]")
    const inspector = root.current?.querySelector<HTMLElement>("[data-pin-inspector]")
    if (zone && inspector && window.matchMedia("(min-width: 1100px)").matches) ScrollTrigger.create({ trigger: zone, start: "top 110px", end: "bottom bottom-=80", pin: inspector, pinSpacing: false })
  }, { scope: root })

  return (
    <div className={styles.site} ref={root}>
      <FinnorNavigation />
      <main>
        <section className={styles.hero}>
          <div className={styles.heroCopy} data-hero-copy><span>{copy.eyebrow}</span><h1>{copy.title}</h1><p>{copy.body}</p><div><a href={siteConfig.calendlyLink} target="_blank" rel="noreferrer">Map your operating boundary <ArrowRight size={15} /></a><Link href="/product">Inspect the product</Link></div></div>
          <aside className={styles.heroLedger} aria-label="FINNOR product control model"><header><CircleDot size={15} /><span>DECISION + EXECUTION LEDGER</span><em>EXPLICIT STATE</em></header><div><small>CONTEXT</small><strong>Project Northstar</strong><span>Synthetic PE walkthrough</span></div><div><small>DECISION STATE</small><strong>Not yet recorded</strong><span>No autonomous authority implied</span></div><div><small>EVIDENCE</small><strong>KNOWN · UNKNOWN · CONFLICTING</strong><span>Each fact carries source references</span></div><div><small>EXECUTION</small><strong>Candidate actions only</strong><span>Authority evaluated at execution</span></div><footer><LockKeyhole size={14} /> Tenant-scoped · source-backed · inspectable</footer></aside>
        </section>
        <div className={styles.marquee} aria-label="FINNOR product layers"><div>{[...productPillars, ...productPillars].map((pillar, index) => <span key={`${pillar.name}:${index}`}><Sparkles size={11} />{pillar.name}</span>)}</div></div>
        {(route === "home" || route === "product") ? <SyntheticBrain /> : null}
        {(route === "home" || route === "product") ? <ActivityTheater /> : null}
        {(route === "home" || route === "product" || route === "capabilities") ? <CapabilityGrid /> : null}
        {(route === "home" || route === "how-it-works") ? <Deployment /> : null}
        {route === "pricing" ? <Pricing /> : null}
        {route === "faq" ? <FAQ /> : null}
        <section className={styles.authority} data-reveal><Scale size={25} /><div><span>AUTHORITY BOUNDARY</span><h2>Better context can support judgment. It cannot replace it.</h2><p>FINNOR exposes candidate actions and the exact evidence behind them. Existing Policy, Authority, approval, BusinessEffect, receipt, and proof boundaries remain decisive.</p></div><ShieldCheck size={32} /></section>
        <section className={styles.cta} data-reveal><span>START WITH THE REAL OPERATING BOUNDARY</span><h2>Map one consequential PE workflow from truth to proof.</h2><p>Bring the sources, governance path, failure modes, and decisions that matter. We will define what can be inspected, what can be prepared, and what must remain held.</p><a href={siteConfig.calendlyLink} target="_blank" rel="noreferrer">Book an operating review <ArrowRight size={15} /></a></section>
      </main>
      <PublicFooter />
    </div>
  )
}
