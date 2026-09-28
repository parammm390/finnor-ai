"use client"

import { useId } from "react"

export type FieldSchema = { type?: string | string[]; const?: unknown; enum?: unknown[]; properties?: Record<string, FieldSchema>; required?: string[]; items?: FieldSchema; additionalProperties?: boolean | FieldSchema; anyOf?: FieldSchema[]; oneOf?: FieldSchema[]; allOf?: FieldSchema[]; default?: unknown; format?: string; pattern?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; exclusiveMinimum?: number; minItems?: number; maxItems?: number }
export const humanLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll(/[_-]/g, " ").replace(/\bId\b/gi, "reference")
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}

export function schemaDefaults(schema: FieldSchema, supplied: Record<string, unknown> = {}): unknown {
  if (schema.const !== undefined) return schema.const
  if (schema.default !== undefined) return schema.default
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    if (supplied[key] !== undefined) return [[key, supplied[key]]]
    if (child.const !== undefined || child.default !== undefined || schema.required?.includes(key)) {
      const value = schemaDefaults(child, supplied)
      return value === undefined ? [] : [[key, value]]
    }
    return []
  }))
  if (schema.type === "array") return []
  if (schema.type === "boolean") return false
  return undefined
}

function branchFits(schema: FieldSchema, value: unknown): boolean {
  if (schema.type === "null") return value === null
  if (schema.const !== undefined) return value === schema.const
  if (schema.type === "object") return Object.entries(schema.properties ?? {}).every(([key, field]) => field.const === undefined || record(value)[key] === field.const)
  return schema.type === typeof value
}

function Field({ schema, value, set, name, required, depth, baseId }: { schema: FieldSchema; value: unknown; set: (value: unknown) => void; name: string; required: boolean; depth: number; baseId: string }) {
  const id = `${baseId}-${name.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`
  const title = humanLabel(name.split(".").at(-1) ?? name)
  if (depth > 12) return <p role="alert">This field is deeper than the supported form limit.</p>
  if (!schema.type && !schema.properties && !schema.additionalProperties && !schema.enum && !schema.oneOf && !schema.anyOf && schema.const === undefined) {
    const kind = value === undefined ? "" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value
    const types: Record<string, FieldSchema> = { string: { type: "string" }, number: { type: "number" }, boolean: { type: "boolean" }, object: { type: "object", additionalProperties: true }, array: { type: "array", items: {} } }
    return <fieldset className="ct-record-field"><legend>{title}{required ? " *" : ""}</legend><label htmlFor={id}>Fact type</label><select id={id} required={required} value={kind} onChange={(e) => set(e.target.value === "" ? undefined : e.target.value === "null" ? null : e.target.value === "object" ? {} : e.target.value === "array" ? [] : e.target.value === "boolean" ? false : e.target.value === "number" ? 0 : "")}><option value="">Choose fact type</option>{["string", "number", "boolean", "object", "array", "null"].map((type) => <option key={type} value={type}>{({ string: "Text", number: "Number", boolean: "Yes or no", object: "Named facts", array: "List", null: "No value" })[type]}</option>)}</select>{types[kind] ? <Field schema={types[kind]} name={`${name}.value`} value={value} set={set} required={required} depth={depth + 1} baseId={baseId} /> : null}</fieldset>
  }
  if (schema.const !== undefined) return <div className="ct-record-field__fixed"><span>{title}</span><strong>{String(schema.const)}</strong></div>
  const alternatives = schema.oneOf ?? schema.anyOf
  if (alternatives?.length) {
    const choices = alternatives.map((choice, index) => ({ choice, index, label: choice.type === "null" ? "No value" : String(Object.values(choice.properties ?? {}).find((field) => field.const !== undefined)?.const ?? choice.type ?? `Format ${index + 1}`) }))
    const active = value === undefined ? -1 : alternatives.findIndex((choice) => branchFits(choice, value))
    return <fieldset className="ct-record-field"><legend>{title}{required ? " *" : ""}</legend><label htmlFor={id}>Value format</label><select id={id} required={required} value={active < 0 ? "" : String(active)} onChange={(e) => { const choice = alternatives[Number(e.target.value)]; set(e.target.value === "" ? undefined : choice.type === "null" ? null : schemaDefaults(choice) ?? (choice.type === "boolean" ? false : "")) }}><option value="">Choose a value format</option>{choices.map(({ index, label }) => <option key={index} value={index}>{humanLabel(label)}</option>)}</select>{active >= 0 && alternatives[active].type !== "null" ? <Field schema={alternatives[active]} name={`${name}.value`} value={value} set={set} required={required} depth={depth + 1} baseId={baseId} /> : null}</fieldset>
  }
  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    const object = record(value), fields = Object.entries(schema.properties ?? {})
    const enabled = required || value !== undefined
    return <fieldset className="ct-record-field"><legend>{title}{required ? " *" : ""}</legend>{!required ? <label className="ct-record-field__include"><input type="checkbox" checked={enabled} onChange={(e) => set(e.target.checked ? schemaDefaults(schema) ?? {} : undefined)} /> Include {title}</label> : null}{enabled ? <>
      {fields.map(([key, child]) => <Field key={key} schema={child} value={object[key]} set={(next) => { const updated = { ...object }; if (next === undefined) delete updated[key]; else updated[key] = next; set(updated) }} name={`${name}.${key}`} required={Boolean(schema.required?.includes(key))} depth={depth + 1} baseId={baseId} />)}
      {schema.additionalProperties && <div className="ct-record-map">{Object.entries(object).filter(([key]) => !schema.properties?.[key]).map(([key, entry]) => <div key={key}><Field schema={typeof schema.additionalProperties === "object" ? schema.additionalProperties : {}} name={`${name}.${key}`} value={entry} set={(next) => set({ ...object, [key]: next })} required depth={depth + 1} baseId={baseId} /><button type="button" onClick={() => { const updated = { ...object }; delete updated[key]; set(updated) }}>Remove {key}</button></div>)}<label htmlFor={`${id}-key`}>Add a named fact</label><input id={`${id}-key`} maxLength={80} placeholder="Fact name" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const key = e.currentTarget.value.trim(); if (key && !["__proto__", "constructor", "prototype"].includes(key) && Object.keys(object).length < 100) { set({ ...object, [key]: typeof schema.additionalProperties === "object" ? schemaDefaults(schema.additionalProperties) ?? "" : "" }); e.currentTarget.value = "" } } }} /><small>Press Enter to add. The owning service validates each named fact.</small></div>}
    </> : null}</fieldset>
  }
  if (schema.type === "array") {
    const items = Array.isArray(value) ? value : [], max = Math.min(schema.maxItems ?? 50, 100)
    return <fieldset className="ct-record-field"><legend>{title}{required ? " *" : ""}</legend>{items.map((item, index) => <div className="ct-record-array" key={index}><Field schema={schema.items ?? { type: "string" }} name={`${name}.${index + 1}`} value={item} set={(next) => set(items.map((v, i) => i === index ? next : v))} required depth={depth + 1} baseId={baseId} /><button type="button" onClick={() => set(items.filter((_, i) => i !== index))}>Remove item {index + 1}</button></div>)}<button type="button" disabled={items.length >= max} onClick={() => set([...items, schemaDefaults(schema.items ?? { type: "string" }) ?? ""])}>Add {humanLabel(name.split(".").at(-1) ?? "item")}</button>{schema.minItems && items.length < schema.minItems ? <p>At least {schema.minItems} item{schema.minItems === 1 ? "" : "s"} required.</p> : null}</fieldset>
  }
  if (schema.type === "boolean") return <label className="ct-record-field__include"><input id={id} type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} /> {title}{required ? " *" : ""}</label>
  if (schema.enum) return <label className="ct-record-field__scalar" htmlFor={id}>{title}{required ? " *" : ""}<select id={id} value={value === undefined ? "" : String(value)} required={required} onChange={(e) => set(e.target.value === "" ? undefined : schema.enum!.find((item) => String(item) === e.target.value))}><option value="">Choose {title}</option>{schema.enum.map((item) => <option key={String(item)} value={String(item)}>{humanLabel(String(item))}</option>)}</select></label>
  const numeric = schema.type === "integer" || schema.type === "number"
  const long = !numeric && (schema.maxLength ?? 200) > 1000 && schema.format !== "date-time"
  const attrs = { id, required, value: typeof value === "string" || typeof value === "number" ? String(value) : "", maxLength: schema.maxLength, minLength: schema.minLength, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(e.target.value === "" ? undefined : numeric ? Number(e.target.value) : e.target.value) }
  return <label className="ct-record-field__scalar" htmlFor={id}>{title}{required ? " *" : ""}{long ? <textarea {...attrs} rows={3} /> : <input {...attrs} type={numeric ? "number" : schema.format === "email" ? "email" : schema.format === "uri" ? "url" : "text"} step={schema.type === "integer" ? 1 : "any"} min={schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + (schema.type === "integer" ? 1 : Number.EPSILON) : undefined)} max={schema.maximum} pattern={!numeric ? schema.format === "uuid" ? "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" : schema.pattern : undefined} placeholder={schema.format === "date-time" ? "2026-09-28T09:00:00Z" : undefined} />}{schema.format === "date-time" ? <small>Include the timezone. This is the effective time you are recording.</small> : null}</label>
}

export function StructuredFields({ schema, value, set, omit = [] }: { schema: FieldSchema; value: Record<string, unknown>; set: (value: Record<string, unknown>) => void; omit?: string[] }) {
  const id = useId()
  return <div className="ct-record-fields">{Object.entries(schema.properties ?? {}).filter(([key]) => !omit.includes(key)).map(([key, child]) => <Field key={key} schema={child} name={key} value={value[key]} set={(next) => { const updated = { ...value }; if (next === undefined) delete updated[key]; else updated[key] = next; set(updated) }} required={Boolean(schema.required?.includes(key))} depth={0} baseId={id} />)}</div>
}

export function RecordedFields({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ol>{value.slice(0, 100).map((entry, index) => <li key={index}><RecordedFields value={entry} /></li>)}</ol>
  if (value && typeof value === "object") return <dl className="ct-record-values">{Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, entry]) => <div key={key}><dt>{humanLabel(key)}</dt><dd><RecordedFields value={entry} /></dd></div>)}</dl>
  if (typeof value === "string" && /^https:\/\/[^\s]+$/.test(value)) return <a href={value} target="_blank" rel="noopener noreferrer">Open recorded link</a>
  return <span>{value === null ? "No value" : value === undefined ? "Omitted" : String(value)}</span>
}
