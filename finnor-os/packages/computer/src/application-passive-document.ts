import type { ApplicationDocument, ApplicationDocumentForm, ApplicationFormControl, ApplicationPublicSource } from "./application-provider";

/** Closed passive HTML grammar, not browser-equivalent HTML or a script engine.
 * Unsupported/ambiguous structure is refused, never repaired heuristically. */
type Fault = (code: string) => never;
interface Element {
  tag: string;
  attributes: Record<string, string>;
  children: Element[];
  parent: Element | null;
  text: string;
}
const tags = new Set(("html head title meta style body header footer h1 h2 h3 h4 h5 h6 nav a main ul ol li section article fieldset legend p div span form input select option textarea button label dl dt dd pre aside strong em br hr code table thead tbody tr th td").split(" "));
const voidTags = new Set(["meta", "input", "br", "hr"]);
const attributes = new Set(("lang charset name content class id aria-label role href action method enctype target type value required disabled selected multiple readonly pattern maxlength autocomplete inputmode for").split(" "));
const booleans = new Set(["required", "disabled", "selected", "multiple", "readonly"]);
const overrides = new Set(["formaction", "formmethod", "formenctype", "formtarget", "formnovalidate"]);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const headings = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "legend"]);
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const newline = (value: string) => value.replace(/\r\n|\r|\n/g, "\r\n");
const text = (node: Element): string => node.tag ? node.children.map(text).join("") : node.text;
const descendants = (node: Element): Element[] => node.children.flatMap(child => [child, ...descendants(child)]);
const has = (node: Element, attribute: string) => Object.hasOwn(node.attributes, attribute);

function decode(value: string, fault: Fault): string {
  let output = "", at = 0;
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  while (at < value.length) {
    const next = value.indexOf("&", at);
    if (next < 0) { output += value.slice(at); break; }
    output += value.slice(at, next);
    const end = value.indexOf(";", next + 1);
    if (end < 0 || end - next > 16) fault("X2_PASSIVE_UNSUPPORTED_ENTITY");
    const entity = value.slice(next + 1, end);
    if (Object.hasOwn(named, entity)) output += named[entity];
    else {
      const numeric = /^#(?:x([0-9a-f]+)|([0-9]+))$/i.exec(entity);
      if (!numeric) fault("X2_PASSIVE_UNSUPPORTED_ENTITY");
      const point = Number.parseInt(numeric[1] ?? numeric[2]!, numeric[1] ? 16 : 10);
      if (!Number.isSafeInteger(point) || point === 0 || point > 0x10ffff
        || point >= 0xd800 && point <= 0xdfff || point < 32 && ![9, 10, 13].includes(point)) {
        fault("X2_PASSIVE_UNSUPPORTED_ENTITY");
      }
      output += String.fromCodePoint(point);
    }
    at = end + 1;
  }
  return output;
}

function opening(raw: string, fault: Fault): { tag: string; attributes: Record<string, string>; selfClosing: boolean } {
  const name = /^([A-Za-z][A-Za-z0-9-]*)/.exec(raw);
  if (!name) return fault("X2_PASSIVE_MALFORMED_DOCUMENT");
  const tag = name[1]!.toLowerCase();
  if (!tags.has(tag)) fault("X2_PASSIVE_ACTIVE_DOCUMENT");
  const found: Record<string, string> = Object.create(null);
  let at = name[0].length, selfClosing = false;
  while (at < raw.length) {
    const gap = /^\s+/.exec(raw.slice(at));
    if (gap) at += gap[0].length;
    if (at === raw.length) break;
    if (raw.slice(at) === "/") { selfClosing = true; break; }
    if (!gap) fault("X2_PASSIVE_MALFORMED_ATTRIBUTE");
    const key = /^([A-Za-z_:][A-Za-z0-9_.:-]*)/.exec(raw.slice(at));
    if (!key) fault("X2_PASSIVE_MALFORMED_ATTRIBUTE");
    const attribute = key[1]!.toLowerCase();
    if (Object.hasOwn(found, attribute)) fault("X2_PASSIVE_AMBIGUOUS_ATTRIBUTE");
    if (attribute.startsWith("on")) fault("X2_PASSIVE_ACTIVE_DOCUMENT");
    if (attribute === "form") fault("X2_PASSIVE_EXTERNAL_CONTROL");
    if (overrides.has(attribute)) fault("X2_PASSIVE_SUBMIT_OVERRIDE");
    if (!attributes.has(attribute)) fault("X2_PASSIVE_MALFORMED_ATTRIBUTE");
    at += key[0].length;
    const space = /^\s*/.exec(raw.slice(at))![0];
    at += space.length;
    let value = "";
    if (raw[at] === "=") {
      at++;
      at += /^\s*/.exec(raw.slice(at))![0].length;
      const quote = raw[at++];
      if (quote !== '"' && quote !== "'") fault("X2_PASSIVE_MALFORMED_ATTRIBUTE");
      const end = raw.indexOf(quote, at);
      if (end < 0) fault("X2_PASSIVE_MALFORMED_ATTRIBUTE");
      value = decode(raw.slice(at, end).replace(/[\t\n\r]/g, " "), fault);
      at = end + 1;
    } else if (!booleans.has(attribute)) fault("X2_PASSIVE_MALFORMED_ATTRIBUTE");
    else at -= space.length; // Preserve separation for the next boolean attribute.
    found[attribute] = value;
  }
  if (selfClosing && !voidTags.has(tag)) fault("X2_PASSIVE_UNBALANCED_DOCUMENT");
  return { tag, attributes: found, selfClosing };
}

function tree(html: string, fault: Fault): Element {
  if (Buffer.byteLength(html, "utf8") > 32 * 1024) fault("X2_SOURCE_BYTE_BOUND");
  const root: Element = { tag: "ROOT", attributes: {}, children: [], parent: null, text: "" };
  const stack = [root], ids = new Set<string>();
  let at = 0, nodes = 0, doctype = false;
  const include = (node: Element) => {
    if (++nodes > 2048 || stack.length > 32) fault("X2_PASSIVE_STRUCTURE_BOUND");
    stack.at(-1)!.children.push(node);
  };
  while (at < html.length) {
    if (html[at] !== "<") {
      const end = html.indexOf("<", at), stop = end < 0 ? html.length : end;
      const value = decode(html.slice(at, stop).replace(/\r\n|\r/g, "\n"), fault);
      include({ tag: "", attributes: {}, children: [], parent: stack.at(-1)!, text: value });
      at = stop; continue;
    }
    const declaration = /^<!doctype html\s*>/i.exec(html.slice(at));
    if (declaration) {
      if (doctype || stack.length !== 1 || root.children.some(child => child.tag || child.text.trim())) fault("X2_PASSIVE_MALFORMED_DOCUMENT");
      doctype = true; at += declaration[0].length; continue;
    }
    if (html.startsWith("<!--", at)) {
      const end = html.indexOf("-->", at + 4);
      if (end < 0 || html.slice(at + 4, end).includes("--")) fault("X2_PASSIVE_MALFORMED_DOCUMENT");
      at = end + 3; continue;
    }
    if (html.startsWith("</", at)) {
      const close = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>/.exec(html.slice(at));
      if (!close || stack.length === 1 || stack.at(-1)!.tag !== close[1]!.toLowerCase()) fault("X2_PASSIVE_UNBALANCED_DOCUMENT");
      stack.pop(); at += close[0].length; continue;
    }
    let end = at + 1, quote = "";
    for (; end < html.length; end++) {
      const character = html[end]!;
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      else if (character === "<") fault("X2_PASSIVE_MALFORMED_DOCUMENT");
    }
    if (end === html.length || quote) fault("X2_PASSIVE_MALFORMED_DOCUMENT");
    const parsed = opening(html.slice(at + 1, end), fault);
    if (parsed.tag === "form" && stack.some(node => node.tag === "form")) fault("X2_PASSIVE_NESTED_FORM");
    if (parsed.tag === "form" && stack.some(node => ["p", "button", "label", "select", "option", "textarea",
      "table", "thead", "tbody", "tr"].includes(node.tag))
      || stack.at(-1)!.tag === "select" && parsed.tag !== "option"
      || parsed.tag === "option" && stack.at(-1)!.tag !== "select"
      || ["option", "textarea"].includes(stack.at(-1)!.tag)) {
      fault("X2_PASSIVE_AMBIGUOUS_STRUCTURE");
    }
    if (parsed.attributes.id) {
      if (ids.has(parsed.attributes.id)) fault("X2_PASSIVE_AMBIGUOUS_ID");
      ids.add(parsed.attributes.id);
    }
    const node: Element = { ...parsed, children: [], parent: stack.at(-1)!, text: "" };
    include(node); at = end + 1;
    if (parsed.tag === "style") {
      // Inert raw text. No CSS parsing, rendering or resource requests.
      const close = /<\/style\s*>/i.exec(html.slice(at));
      if (!close || html.slice(at, at + close.index).includes("<")) fault("X2_PASSIVE_UNBALANCED_DOCUMENT");
      at += close.index + close[0].length;
    } else if (!voidTags.has(parsed.tag)) stack.push(node);
  }
  if (stack.length !== 1) fault("X2_PASSIVE_UNBALANCED_DOCUMENT");
  const elements = root.children.filter(child => child.tag);
  if (elements.length !== 1 || elements[0]!.tag !== "html"
    || root.children.some(child => !child.tag && child.text.trim())) fault("X2_PASSIVE_MALFORMED_DOCUMENT");
  return root;
}

function control(node: Element, all: Element[], form: Element, fault: Fault): ApplicationFormControl {
  const kind = node.tag === "select" ? "select" : node.tag === "textarea" ? "textarea" : (node.attributes.type ?? "text").toLowerCase();
  const name = node.attributes.name ?? "";
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name) || name.split(/[.:]/).some(key => forbidden.has(key))
    || !["hidden", "text", "date", "select", "textarea"].includes(kind) || has(node, "multiple")) {
    fault("X2_PASSIVE_UNSUPPORTED_CONTROL");
  }
  const labels = all.filter(item => item.tag === "label"
    && (node.attributes.id && item.attributes.for === node.attributes.id || descendants(item).includes(node)));
  const options = node.tag === "select" ? descendants(node).filter(item => item.tag === "option") : [];
  if (options.length > 32) fault("X2_DOCUMENT_STRUCTURE_BOUND");
  if (options.some(option => has(option, "disabled")) || node.tag === "select" && !options.length) fault("X2_PASSIVE_UNSUPPORTED_CONTROL");
  const selected = options.filter(option => has(option, "selected"));
  const values = options.map(option => option.attributes.value ?? compact(text(option)));
  if (selected.length > 1 || new Set(values).size !== values.length || labels.length > 1) fault("X2_PASSIVE_AMBIGUOUS_CONTROL");
  if (node.tag === "textarea" && node.children.some(child => child.tag)) fault("X2_PASSIVE_UNSUPPORTED_CONTROL");
  const maxLength = node.attributes.maxlength === undefined ? null : Number(node.attributes.maxlength);
  if (maxLength !== null && (!/^(?:0|[1-9][0-9]*)$/.test(node.attributes.maxlength!) || !Number.isSafeInteger(maxLength) || maxLength > 32768)) fault("X2_PASSIVE_UNSUPPORTED_CONTROL");
  let disabled = has(node, "disabled"), parent = node.parent;
  while (parent && parent !== form) { disabled ||= parent.tag === "fieldset" && has(parent, "disabled"); parent = parent.parent; }
  return { name, kind, label: labels.length ? compact(text(labels[0]!)) || null : null,
    value: node.tag === "select" ? values[options.indexOf(selected[0] ?? options[0]!)]!
      : node.tag === "textarea" ? text(node) : node.attributes.value ?? "",
    required: has(node, "required"), disabled, pattern: node.attributes.pattern ?? null, maxLength, options: values };
}

export function parsePassiveApplicationDocument(source: ApplicationPublicSource, url: string, fault: Fault): ApplicationDocument {
  if (source.status !== 200 || source.contentType?.split(";")[0]?.trim().toLowerCase() !== "text/html") fault("X2_DOCUMENT_UNSUPPORTED");
  const root = tree(source.text, fault), all = descendants(root), formNodes = all.filter(node => node.tag === "form");
  const listNodes = all.filter(node => node.tag === "dl");
  if (formNodes.length > 16 || listNodes.length > 16) fault("X2_DOCUMENT_STRUCTURE_BOUND");
  const forms = formNodes.map((node, index): ApplicationDocumentForm => {
    const children = descendants(node), controls = children.filter(item => ["input", "select", "textarea"].includes(item.tag));
    if (controls.length > 32) fault("X2_DOCUMENT_STRUCTURE_BOUND");
    const parsed = controls.map(item => control(item, all, node, fault));
    if (new Set(parsed.map(item => item.name)).size !== parsed.length) fault("X2_PASSIVE_AMBIGUOUS_CONTROL");
    if (children.some(item => item.tag === "button" && (has(item, "name") || !["submit", "button"].includes((item.attributes.type ?? "submit").toLowerCase())))) fault("X2_PASSIVE_UNSUPPORTED_CONTROL");
    const ownHeading = children.find(item => item.tag === "legend");
    const framing = node.parent?.children.find(item => headings.has(item.tag));
    const submit = children.find(item => item.tag === "button" && (item.attributes.type ?? "submit").toLowerCase() === "submit");
    let action: string;
    try { action = new URL(node.attributes.action ?? url, url).href; }
    catch { return fault("X2_PASSIVE_MALFORMED_DOCUMENT"); }
    return { index, label: compact(node.attributes["aria-label"] ?? text(ownHeading ?? framing ?? submit ?? node)),
      method: (node.attributes.method ?? "GET").toUpperCase(), action,
      encoding: (node.attributes.enctype ?? "application/x-www-form-urlencoded").toLowerCase(),
      target: node.attributes.target ?? "", overrides: false, controls: parsed };
  });
  const descriptions = listNodes.map(node => {
    const children = node.children.filter(child => child.tag), entries: Array<{ name: string; value: string }> = [];
    if (children.filter(child => child.tag === "dt").length > 32) fault("X2_DOCUMENT_STRUCTURE_BOUND");
    for (let index = 0; index < children.length; index += 2) {
      const term = children[index], value = children[index + 1];
      if (term?.tag !== "dt" || value?.tag !== "dd" || descendants(term).some(child => child.tag === "dl")
        || descendants(value).some(child => child.tag === "dl")) fault("X2_PASSIVE_AMBIGUOUS_DESCRIPTION");
      entries.push({ name: compact(text(term)), value: text(value) });
    }
    return { label: node.parent?.attributes["aria-label"] ?? null, entries };
  });
  return { source, url, transport: "PASSIVE_HTML", forms, descriptions };
}

/** Reconstruct successful controls from the captured form, independently of
 * the already prepared body. Preserve actual control order and line endings. */
export function passiveFormWire(form: ApplicationDocumentForm, controls: Record<string, string>, fault: Fault) {
  const successful = form.controls.filter(control => !control.disabled), names = successful.map(control => control.name);
  if (new Set(names).size !== names.length || Object.keys(controls).some(name => !names.includes(name))
    || names.some(name => !Object.hasOwn(controls, name) || typeof controls[name] !== "string")) {
    fault("X2_PASSIVE_FORM_CONTROL_SUBSTITUTION");
  }
  if (form.overrides || form.target && form.target !== "_self" || !["GET", "POST"].includes(form.method)
    || form.encoding !== "application/x-www-form-urlencoded") fault("X2_PASSIVE_FORM_WIRE_MISMATCH");
  const encoded = new URLSearchParams();
  for (const control of successful) {
    const value = controls[control.name]!;
    if (control.kind === "select" && !control.options.includes(value)) fault("X2_PASSIVE_FORM_CONTROL_SUBSTITUTION");
    encoded.append(newline(control.name), newline(value));
  }
  const url = new URL(form.action);
  if (form.method === "GET") { url.search = encoded.toString(); return { method: "GET", url: url.href, body: null, contentType: null }; }
  return { method: "POST", url: url.href, body: encoded.toString(), contentType: "application/x-www-form-urlencoded" };
}
