import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { z } from "zod"
import { AnswerCanvas } from "../../src/components/centropy/canvas/AnswerCanvas"
import { readAnswerResult, type AnswerResult } from "../../src/components/centropy/canvas/answer-result"
import "../../src/components/centropy/shell/centropy.css"

const SavedWork = z.object({
  work: z.object({ status: z.string(), updatedAt: z.string(), finalOutcome: z.unknown() }),
  documentReview: z.unknown().optional(),
})

function Preview() {
  const [result, setResult] = useState<AnswerResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  useEffect(() => {
    void fetch("/answer.json").then(response => response.json()).then(value => {
      const result = readAnswerResult(SavedWork.parse(value))
      if (!result) throw new Error("No answer in the saved Work")
      setResult(result)
    }).catch(() => setError("The saved owner result could not be loaded."))
  }, [])
  return <div className="ct-app"><header className="ct-topbar"><strong>FINNOR · Result verification</strong><span>Local renderer · saved HTTP output</span></header><main className="ct-canvas">
    {error ? <p role="alert">{error}</p> : result ? history ? <section><h2>Renderer proof boundary</h2><p>This preview renders the actual saved result from the signed disposable HTTP test. Full workspace navigation and authentication are separate acceptance checks.</p><button type="button" onClick={() => setHistory(false)}>Back to answer</button></section> : <AnswerCanvas result={result} onInspectWork={() => setHistory(true)} /> : <p role="status">Reading saved result…</p>}
  </main></div>
}
const element = document.getElementById("root")
if (!element) throw new Error("Preview root missing")
createRoot(element).render(<Preview />)
