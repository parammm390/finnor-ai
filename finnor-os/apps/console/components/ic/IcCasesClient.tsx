"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { icStatusClass, readable, shortId, type IcCaseSummary } from "../../lib/ic";

export default function IcCasesClient() {
  const [cases, setCases] = useState<IcCaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api<{ cases: IcCaseSummary[]; complete: true }>("/api/private-equity/ic/cases");
    setCases(result.cases);
  }, []);

  useEffect(() => { load().catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load IC Cases")); }, [load]);

  if (error) return <div className="ic-alert bad" role="alert">{error}</div>;
  if (!cases) return <div className="card pulse">Loading Investment Committee truth…</div>;

  return (
    <div className="ic-index">
      <header className="ic-hero compact">
        <div><span className="ic-kicker">Private Equity · Phase 5</span><h1>Investment Committee</h1><p>Governed process truth from exact P1, P2, P3, and P4 records.</p></div>
        <span className="ic-count">{cases.length} cases</span>
      </header>
      {cases.length === 0 ? <section className="card"><h2>No IC Cases yet</h2><p className="ic-muted">Open a typed IC Case through the governed action fabric or authenticated API.</p></section> : (
        <section className="ic-case-list" aria-label="Investment Committee Cases">
          {cases.map((item) => (
            <a className="card ic-case-row" href={`/ic/${item.id}`} key={item.id}>
              <div><span className="ic-kicker">InvestmentCase {shortId(item.investmentCaseId)}</span><h2>{item.investmentCaseTitle ?? item.investmentCaseId}</h2><p>{item.investmentCaseSummary ?? "No copied summary; open the canonical case for exact context."}</p></div>
              <div className="ic-case-facts">
                <span className={icStatusClass(item.state)}>{readable(item.state)}</span>
                <span>Run {readable(item.underwritingValidity)}</span>
                <span>Recommendation {readable(item.recommendationOutcome)}</span>
                <span>{item.finalDecisionId ? `Decision ${shortId(item.finalDecisionId)}` : `Process v${item.version ?? "—"}`}</span>
              </div>
            </a>
          ))}
        </section>
      )}
    </div>
  );
}
