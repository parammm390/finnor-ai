"use client"

import { useState } from "react"
import { centropyPost } from "../lib/api"
import { growthAmount, growthLabel, type GrowthMutation, type GrowthRequest, type GrowthView } from "./growth-program-contracts"

export function GrowthPreparedOutcomes({ view, busy, mutate }: {
  view: GrowthView; busy: boolean; mutate: GrowthMutation
}) {
  return <div aria-label="Recorded growth opportunities">
    {view.preparedOutcomes.map(original => <article key={original.source.versionId}>
      <h5>{original.question}</h5><p>{original.originalMeaning}</p>
      <p>Original deadline: {new Date(original.originalDeadlineAt).toLocaleString()}. This is a recorded input, not a validated business.</p>
      <button type="button" disabled={busy || !view.complete || Date.parse(original.originalDeadlineAt) <= Date.now()}
        onClick={() => void mutate(() => centropyPost("demand-to-business/submit", {
          workId: view.scope.workId, workInputId: original.workInputId,
          idempotencyKey: "w4-ui-submit:" + original.source.versionId, outcomeSource: original.source,
          budgetObligationRef: original.budgetObligationRef, s7EstimandId: null,
        }))}>Compile this recorded opportunity</button>
      <details><summary>Original source receipt</summary><p>Source {original.source.sourceId}. Version {original.source.versionId}.
        Digest {original.source.contentDigest}. The owner revalidates the original Work, resources and source before compilation.</p></details>
    </article>)}
    {!view.requests.length && !view.preparedOutcomes.length ? <p>No growth opportunity is recorded on this Work.
      Existing independently authored capability, demand, population, test and finance originals are required.
      A new forecast or owner assertion is not a substitute.</p> : null}
  </div>
}

export function GrowthOwnerControls({ request, busy, mutate }: {
  request: GrowthRequest; busy: boolean; mutate: GrowthMutation
}) {
  const [participantKey, setParticipantKey] = useState(""), [offerId, setOfferId] = useState("")
  const [buyerId, setBuyerId] = useState(""), [buyerPurpose, setBuyerPurpose] = useState("response")
  const { program, product, projection } = request
  const participant = product.participants.find(p => p.id + ":" + p.role === participantKey)
  const selectedOffer = program?.offers.find(o => o.id === offerId)
  const buyers = product.participants.filter(p => p.role === "BUYER")
  const metrics = projection ? [
    ["Assigned once", projection.counts.assigned], ["Responded", projection.counts.responded],
    ["Interest only", projection.counts.interested], ["Declined", projection.counts.declined],
    ["No response", projection.counts.nonresponse], ["Commitments", projection.counts.accepted],
    ["Independently eligible", projection.counts.independentEligibleAccepted], ["Delivery accepted", projection.counts.delivered],
  ] as const : []
  const money = projection?.accounting
  const due = Date.parse(product.currentUntil) <= Date.now()
  const responseClosed = !program || Date.parse(program.protocol.closesAt) <= Date.now()
  const invite = () => {
    if (!participant || !program) return
    const observer = participant.role === "INDEPENDENT_OBSERVER"
    const responding = participant.role === "BUYER" && buyerPurpose === "response"
    const buyer = participant.role === "BUYER" ? participant.id : buyerId
    if (!observer && (!selectedOffer || !buyer)) return
    const expiresAt = responding ? program.protocol.closesAt : new Date(
      Date.parse(request.originalDeadlineAt) + Math.min(365 * 86400000, (selectedOffer?.supportHours ?? 24) * 3600000)).toISOString()
    const permittedKinds = participant.role === "BUYER" ? responding ? ["RESPONSE"] : ["DELIVERY_ACCEPTANCE", "SUPPORT", "REFUND"]
      : participant.role === "OPERATOR" ? ["DELIVERY"] : observer ? ["TEST_CLOSED", "MARKET_CHANGE"]
        : ["EVIDENCE", "COLLECTION", "RECOGNITION", "REFUND", "COST"]
    void mutate(() => centropyPost("demand-to-business/invite", { scope: product.scope,
      requestId: request.requestId, participantId: participant.id, role: participant.role,
      buyerId: observer ? null : buyer, offerId: observer ? null : selectedOffer!.id,
      termsDigest: observer ? null : selectedOffer!.termsDigest, permittedKinds,
      evidenceKinds: participant.role === "ACCOUNTANT" ? ["INVOICE", "ACCOUNTING"] : [],
      purpose: product.purpose, expiresAt,
    }))
  }
  return <article data-w4-request={request.requestId}>
    <h5>{growthLabel(request.status)}</h5>
    <p>One original business assignment. Deadline {new Date(request.originalDeadlineAt).toLocaleString()}.</p>
    {projection ? <>
      <p>Decision: {growthLabel(projection.decision)}. Evidence: {growthLabel(projection.validationState)}.
        Currentness: {growthLabel(projection.currentness)}{due ? ", revalidation is due" : ""}.</p>
      <dl>{metrics.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      {money ? <>
        <h6>Distinct accounting coordinates</h6>
        <dl>{([["Bookings", money.bookingsMinor], ["Cash collected, net", money.collectedMinor],
          ["Revenue recognized, net", money.recognizedMinor], ["Deferred revenue", money.deferredMinor],
          ["Receivable", money.receivableMinor], ["Refunds settled", money.refundedMinor],
          ["Refunds requested", money.refundRequestedMinor]] as const).map(([name, minor]) =>
          <div key={name}><dt>{name}</dt><dd>{growthAmount({ currency: money.currency, minor })}</dd></div>)}</dl>
        <p>Unknown lifecycle costs: {money.missingCostCategories.map(growthLabel).join(", ") || "None in this bounded record"}.
          This is not qualified realized profit or causal increment.</p>
      </> : null}
      {projection.commitments.map((commitment, i) => <section key={commitment.buyerId + ":" + commitment.offerId}>
        <strong>Original commitment {i + 1}: {growthLabel(commitment.state)}</strong>
        <p>{commitment.quantity} committed units; {commitment.deliveredQuantity} reported delivered;
          {" "}{commitment.acceptedDeliveryQuantity} independently accepted.</p>
        <p>Remaining duties: {commitment.continuingObligations.map(growthLabel).join(", ") || "None in this controlled read"}.
          Support horizon {new Date(commitment.supportUntil).toLocaleString()}.</p>
      </section>)}
      {projection.originalFailures.length ? <p>Retained failures: {projection.originalFailures.map(growthLabel).join("; ")}.</p> : null}
    </> : <p>The checked programme or authoritative evidence is pending. No completion is assumed.</p>}
    {program ? <>
      <p>Original exposure: at most {program.protocol.maxContacts} contacts, {growthAmount(program.protocol.maxMoney)},
        {" "}{program.protocol.maxHumanSeconds} human seconds. Test closes {new Date(program.protocol.closesAt).toLocaleString()}.</p>
      {program.hypotheses.map(hypothesis => <section key={hypothesis.demandId}><strong>{hypothesis.problem}</strong>
        <p>Alternatives: {hypothesis.alternatives.join("; ") || "None recorded"}. Selection limitations: {hypothesis.selectionBias.join("; ")}.</p></section>)}
      {program.offers.map((offer, i) => <details key={offer.id}><summary>Exact offer {i + 1}: {growthAmount(offer.unitPrice)} per unit</summary>
        <p>{offer.disclosure}</p><p>Claims: {offer.claims.join("; ")}. Exclusions: {offer.exclusions.join("; ")}.</p>
        <p>Delivery lead: {offer.deliveryLeadHours} hours. Support: {offer.supportHours} hours. Maximum units: {offer.maximumUnits}.</p>
        <p>Refund terms: {offer.refunds}. Warranty: {offer.warranty}.</p>
        <small>Exact terms digest: {offer.termsDigest}</small>
      </details>)}
      <details><summary>Register an exact participant protocol</summary>
        <p>This registers an invitation, not consent or buyer contact. Only the participant can consent.
          It grants no generic Work access or new execution authority.</p>
        <form onSubmit={event => { event.preventDefault(); invite() }}>
          <label>Original duty owner<select required value={participantKey} onChange={event => setParticipantKey(event.target.value)}>
            <option value="">Choose a registered original participant</option>
            {product.participants.map(p => <option key={p.id + ":" + p.role} value={p.id + ":" + p.role}>
              {growthLabel(p.role)}: {p.label}</option>)}</select></label>
          {participant?.role === "BUYER" ? <label>Purpose<select value={buyerPurpose} onChange={e => setBuyerPurpose(e.target.value)}>
            <option value="response">Respond to the original offer</option><option value="continuing">Delivery, support and refund duties</option>
          </select></label> : null}
          {participant && participant.role !== "INDEPENDENT_OBSERVER" ? <>
            <label>Exact original offer<select required value={offerId} onChange={e => setOfferId(e.target.value)}>
              <option value="">Choose the exact offer</option>{program.offers.map((o, i) =>
                <option key={o.id} value={o.id}>Offer {i + 1}, {growthAmount(o.unitPrice)} per unit</option>)}</select></label>
            {participant.role !== "BUYER" ? <label>Assigned buyer<select required value={buyerId} onChange={e => setBuyerId(e.target.value)}>
              <option value="">Choose the original buyer</option>{buyers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label> : null}
          </> : null}
          <button type="submit" disabled={busy || !participant || participant.role === "BUYER" && buyerPurpose === "response"
            && (responseClosed || due || projection?.currentness !== "CURRENT")}>Register purpose-bound invitation</button>
        </form>
      </details>
    </> : null}
    {request.nativeEffects.length ? <details><summary>Original native observations</summary>
      {request.nativeEffects.map(effect => <p key={effect.ref.id}>{growthLabel(effect.kind)}: {growthLabel(effect.state)}.
        Original-identity readback: {effect.originalIdentityReadback ? "established" : "not established"}.</p>)}
    </details> : null}
    {request.gaps.length ? <p>Open evidence gaps: {request.gaps.map(growthLabel).join("; ")}.</p> : null}
    <button type="button" disabled={busy || !request.artifactDigest} onClick={() =>
      void mutate(() => centropyPost("demand-to-business/advance", {
        requestId: request.requestId, expectedArtifactDigest: request.artifactDigest,
      }))}>Revalidate original continuation and remaining duties</button>
  </article>
}
