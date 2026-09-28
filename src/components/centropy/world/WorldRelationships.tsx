"use client"

import { ArrowRight, GitBranch } from "lucide-react"
import { refKey, type CompanyBrainEdge, type CompanyBrainNode, type CompanyBrainObjectRef } from "../pe/contracts"

const label = (value: string) => value.replace(/^pe_/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase()
function relationship(node: CompanyBrainNode, selected: CompanyBrainNode, edges: CompanyBrainEdge[]): string | null {
  const direct = edges.find((edge) => refKey(edge.fromRef) === refKey(selected.ref) && refKey(edge.toRef) === refKey(node.ref))
  if (direct) return label(direct.relationship)
  const incoming = edges.find((edge) => refKey(edge.toRef) === refKey(selected.ref) && refKey(edge.fromRef) === refKey(node.ref))
  if (incoming) return label(incoming.relationship)
  const indirect = edges.find((edge) => refKey(edge.fromRef) === refKey(node.ref) || refKey(edge.toRef) === refKey(node.ref))
  return indirect ? `via ${label(indirect.relationship)}` : null
}

/** A bounded view of the exact owning projection; selecting a row preserves its
 * object identity. No graph edges or business facts are generated in the UI. */
export function WorldRelationships({ nodes, edges, selected, truncated, onSelect }: {
  nodes: CompanyBrainNode[]; edges: CompanyBrainEdge[]; selected: CompanyBrainNode;
  truncated?: boolean; onSelect: (ref: CompanyBrainObjectRef) => void
}) {
  const connected = nodes.filter((node) => refKey(node.ref) !== refKey(selected.ref))
  return <>
    <div className="ct-world__detail-count"><GitBranch size={16} /> {nodes.length} objects · {edges.length} links{truncated ? " · bounded result" : ""}</div>
    {connected.slice(0, 60).map((node) => {
      const relation = relationship(node, selected, edges)
      return <button className="ct-world__related" type="button" key={refKey(node.ref)} onClick={() => onSelect(node.ref)}><span><strong>{node.label}</strong><small>{label(node.type)} · {node.state ?? node.epistemicState}{relation ? ` · ${relation}` : ""}</small></span><ArrowRight size={14} /></button>
    })}
    {connected.length > 60 ? <p>Showing the first 60 of {connected.length} linked objects. Select an object or narrow the search to inspect its connections.</p> : null}
    {!connected.length ? <p>No linked objects are recorded in this view.</p> : null}
  </>
}
