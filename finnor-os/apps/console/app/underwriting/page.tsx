"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { shortIdentity, statusClassName } from "../../lib/underwriting";

interface InvestmentCaseSummary {
  id: string;
  dealId: string;
  title: string;
  summary: string | null;
  state: string;
  version: number;
  modelCount: number;
  runCount: number;
  latestRunAt: string | null;
}

export default function UnderwritingIndexPage() {
  const [cases, setCases] = useState<InvestmentCaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ investmentCases: InvestmentCaseSummary[] }>("/api/investment-cases")
      .then((result) => setCases(result.investmentCases))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load InvestmentCases"));
  }, []);
  return (
    <div className="uw-index">
      <header className="uw-hero"><div><div className="uw-kicker">P4 · deterministic underwriting</div><h1>Underwriting</h1><p>Select the canonical P1 InvestmentCase whose exact model truth you want to inspect.</p></div><div className="uw-truth-box">No fixture numbers are rendered here. An InvestmentCase without a P4 model remains valid and correctly shows zero Runs.</div></header>
      {error ? <div className="uw-alert" role="alert">{error}</div> : null}
      {cases === null ? <div className="card pulse">Loading InvestmentCases…</div> : cases.length === 0 ? <div className="card"><h2>No InvestmentCases</h2><p>Create the business context through the P1 owner before underwriting it.</p></div> : (
        <div className="uw-case-grid">{cases.map((item) => <a className="card uw-case-card" href={`/underwriting/${item.id}`} key={item.id}><div className="uw-case-title"><h2>{item.title}</h2><span className={statusClassName(item.state)}>{item.state}</span></div><p>{item.summary ?? "No summary recorded."}</p><dl><div><dt>InvestmentCase</dt><dd>{shortIdentity(item.id)}</dd></div><div><dt>Models</dt><dd>{item.modelCount}</dd></div><div><dt>Runs</dt><dd>{item.runCount}</dd></div><div><dt>Latest</dt><dd>{item.latestRunAt ?? "never"}</dd></div></dl></a>)}</div>
      )}
    </div>
  );
}
