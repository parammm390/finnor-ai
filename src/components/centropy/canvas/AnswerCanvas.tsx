"use client"

import { useState } from "react"
import {
  documentSourceLocation, formatDocumentAmount, type DocumentValuation,
} from "../../../../finnor-os/packages/shared-types/src/document-financial-review"
import type { AnswerResult } from "./answer-result"
import "./answer-canvas.css"

function ValuationImpact({ valuation, onDownload }: { valuation: DocumentValuation; onDownload?: () => Promise<void> }) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  if (valuation.status === "requires_input") return <section className="ct-answer__gaps" aria-label="Valuation needs evidence">
    <h3>Valuation needs evidence</h3><p>{valuation.reason}</p>
  </section>
  const amount = (value: string) => formatDocumentAmount(value, valuation.currency)
  const funding = valuation.funding
  const forecast = "forecast" in valuation ? valuation.forecast : null
  async function download() {
    if (!onDownload) return
    setDownloading(true)
    setDownloadError(null)
    try { await onDownload() }
    catch (error) { setDownloadError(error instanceof Error ? error.message : "The diligence brief could not be downloaded.") }
    finally { setDownloading(false) }
  }
  return <section aria-label="Valuation impact">
    <h3>Valuation impact</h3>
    <p>{valuation.scopeName}</p>
    <p><strong>{amount(valuation.enterpriseValueSpread)}</strong> difference in implied enterprise value at the supplied {valuation.entryMultiple}× multiple.</p>
    {"forecast" in valuation
      ? <><p>FY{valuation.forecast.year} management forecasts. The request treats dollar amounts as {valuation.currency}.</p><p>{valuation.forecast.definition}</p></>
      : <p>Annual EBITDA for {valuation.periodStart.slice(0, 10)} to {valuation.periodEnd.slice(0, 10)}. Keep both cases open until the earnings basis is reconciled.</p>}
    <div className="ct-answer__table"><table>
      <caption>{forecast ? "Forecast sensitivities" : "Conditional entry scenarios"}</caption>
      <thead><tr><th scope="col">EBITDA source</th>{forecast ? <th scope="col">Forecast Adjusted EBITDA</th> : null}<th scope="col">Enterprise value</th>{funding.status === "calculated" ? <>
        <th scope="col">Equity price</th><th scope="col">Sponsor cash</th>
      </> : null}</tr></thead>
      <tbody>{valuation.cases.map(({ source, ebitda, enterpriseValue, funding: row }, index) => <tr key={index}>
        <th scope="row">{source.vintage ?? source.title} · {documentSourceLocation(source.anchor)}</th>
        {forecast ? <td>{amount(ebitda)}</td> : null}
        <td>{amount(enterpriseValue)}</td>{row ? <><td>{amount(row.equityPrice)}</td><td>{amount(row.sponsorCash)}</td></> : null}
      </tr>)}</tbody>
    </table></div>
    {funding.status === "calculated"
      ? <p>Equity price deducts {amount(funding.netDebt)} net debt. Sponsor cash adds {amount(funding.fees)} in fees, with all equity funded by the sponsor and no rollover or other funding.</p>
      : <p>{funding.reason}</p>}
    {forecast ? <details className="ct-answer__inspection"><summary>Inspect exact forecast sources</summary><ul className="ct-answer__sources">
      {valuation.cases.map(({ source }) => <li key={documentSourceLocation(source.anchor)}>
        <strong>{source.title} · {documentSourceLocation(source.anchor)}</strong><p>Version {source.versionId}</p>
        {"quote" in source.anchor ? <blockquote>{source.anchor.quote}</blockquote> : null}
      </li>)}
    </ul></details> : null}
    {onDownload ? <button type="button" className="ct-answer__work-link" disabled={downloading} onClick={() => void download()}>
      {downloading ? "Preparing diligence brief…" : "Download diligence brief"}
    </button> : null}
    {downloadError ? <p role="alert">{downloadError}</p> : null}
  </section>
}

function DocumentReview({ review, onDownload }: { review: NonNullable<AnswerResult["documentReview"]>; onDownload?: () => Promise<void> }) {
  if (review.status === "stale") return <p className="ct-answer__basis">The source versions or coverage have changed. Run the comparison again to use the current documents.</p>
  if (review.status === "unavailable") return <p className="ct-answer__basis">The saved source comparison is unavailable under current access or source conditions.</p>
  return <>
    <p className="ct-answer__basis">{review.forecast
      ? `Compared two FY${review.forecast.year} management forecasts from one source PDF.`
      : <>Compared {review.comparableGroups} comparable financial groups across {review.documentsReviewed} readable documents. Each figure is a source assertion for the period and basis shown.</>}</p>
    {review.gaps.length ? <section className="ct-answer__gaps" aria-label="Coverage gaps"><h3>Coverage gaps</h3><ul>{review.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></section> : null}
    {review.valuation ? <ValuationImpact valuation={review.valuation} onDownload={onDownload} /> : null}
    {!review.findings.length && !review.valuation ? <p>{review.comparableGroups ? "The comparable figures reviewed agree." : "The review found no group with comparable figures from at least two documents."}</p> : null}
    {review.findings.map((finding, index) => {
      const unit = finding.currency ?? finding.unit
      return <section key={index} aria-label={`${finding.metric} disagreement`}>
        <h3>{finding.metric} · {finding.periodStart.slice(0, 10)} to {finding.periodEnd.slice(0, 10)}</h3>
        <p>{finding.frequency} · {finding.consolidation.replaceAll("_", " ").toLowerCase()} · {finding.calendar.replaceAll("_", " ").toLowerCase()}{finding.instrument !== "UNSPECIFIED" ? ` · ${finding.instrument}` : ""}</p>
        <div className="ct-answer__table"><table>
          <caption>Conflicting source assertions</caption>
          <thead><tr><th scope="col">Source and location</th><th scope="col">Reported value</th></tr></thead>
          <tbody>{finding.assertions.map(({ value, source }, assertionIndex) => <tr key={assertionIndex}>
            <th scope="row">{source.title} · {documentSourceLocation(source.anchor)}</th>
            <td>{formatDocumentAmount(value, unit)}</td>
          </tr>)}</tbody>
        </table></div>
        <p>Spread {formatDocumentAmount(finding.spread, unit)}. Reconcile the source definitions and supporting adjustments before using either figure in a decision.</p>
        <details className="ct-answer__inspection"><summary>Inspect exact document versions</summary><ul className="ct-answer__sources">
          {finding.assertions.map(({ source }, assertionIndex) => <li key={assertionIndex}>
            <strong>{source.title}</strong><p>Version {source.versionId}</p>
            {"quote" in source.anchor ? <blockquote>{source.anchor.quote}</blockquote> : null}
          </li>)}
        </ul></details>
      </section>
    })}
  </>
}

export function AnswerCanvas({ result, onInspectWork, onDownloadBrief }: {
  result: AnswerResult; onInspectWork: () => void; onDownloadBrief?: () => Promise<void>
}) {
  const analysis = result.analysis
  const review = result.documentReview
  return <article className="ct-answer" aria-label="Answer and supporting calculations">
    <header className="ct-answer__header">
      <span className="ct-eyebrow">{analysis ? "FINANCIAL EXPLANATION" : review ? "DOCUMENT EVIDENCE" : "ANSWER"}</span>
      <h2>{result.title}</h2>
      <div className="ct-answer__meta"><span>{analysis?.status === "checked" ? "Arithmetic checked" : analysis ? "Inputs needed" : review?.status === "reviewed" ? "Source versions checked" : review ? "Review unavailable" : "Response delivered"}</span><time dateTime={result.asOf}>{new Date(result.asOf).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></div>
    </header>
    {analysis ? <>
      <p className="ct-answer__basis">Conditional on the inputs you supplied. Financial interpretation and source assertions have not been independently verified.</p>
      {analysis.calculations.length ? <div className="ct-answer__table"><table>
        <caption>Calculated results</caption>
        <thead><tr><th scope="col">Result</th><th scope="col">Value</th></tr></thead>
        <tbody>{analysis.calculations.map(item => <tr key={item.id}><th scope="row">{item.label}</th><td>{item.value.formatted}</td></tr>)}</tbody>
      </table></div> : null}
      {analysis.gaps.length ? <section className="ct-answer__gaps" aria-label="Inputs or method needed"><h3>What’s needed to finish</h3><ul>{analysis.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></section> : null}
      {analysis.assumptions.length ? <section><h3>Supplied conditions</h3><ul>{analysis.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null}
      {analysis.calculations.length ? <details className="ct-answer__inspection"><summary>Inspect formulas and exact values</summary><dl>{analysis.calculations.map(item => <div key={item.id}>
        <dt>{item.label}</dt><dd>{item.formula}</dd><dd className="ct-answer__exact">Exact value: {item.value.numerator}{item.value.denominator === "1" ? "" : ` / ${item.value.denominator}`} {item.value.unit === "scalar" ? "" : item.value.unit}</dd>
        <dd>Inputs: {item.inputRefs.map(id => analysis.sources.find(source => source.id === id)?.label ?? id).join(", ")}</dd>
      </div>)}</dl></details> : null}
      {analysis.sources.length ? <details className="ct-answer__inspection"><summary>Inspect supplied sources</summary><ul className="ct-answer__sources">{analysis.sources.map(source => <li key={source.id}><strong>{source.label}</strong><blockquote>{source.quote}</blockquote></li>)}</ul></details> : null}
    </> : review ? <DocumentReview review={review} onDownload={onDownloadBrief} /> : <div className="ct-answer__prose">{result.text}</div>}
    <footer><button type="button" className="ct-answer__work-link" onClick={onInspectWork}>Inspect Work history</button></footer>
  </article>
}
