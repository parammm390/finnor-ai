import {
  NS,
  OfficePackage,
  children,
  descendants,
  ensure,
  finishIR,
  innerReplacement,
  node,
  replaceXml,
  semanticHash,
  xmlEscape,
  type SemanticIR,
  type SemanticNode,
  type XmlNode,
  type XmlReplacement,
} from "@finnor/ooxml";

export interface PresentationIR extends SemanticIR {
  slides: Array<{ id: string; part: string; ordinal: number }>;
}

function relationshipPart(part: string): string {
  const slash = part.lastIndexOf("/");
  const directory = slash < 0 ? "" : part.slice(0, slash + 1);
  const name = slash < 0 ? part : part.slice(slash + 1);
  return `${directory}_rels/${name}.rels`;
}

function plainNode(id: string, part: string, kind: string, data: Record<string, unknown>): SemanticNode {
  return { id, part, path: id, kind, data, hash: semanticHash(data) };
}

export function parsePresentation(pkg: OfficePackage): PresentationIR {
  ensure(pkg.format === "pptx", "NOT_PRESENTATION");
  const presentation = pkg.xml(pkg.mainPart);
  const presentationRelationships = pkg.relationships(pkg.mainPart);
  const slides = descendants(presentation, "sldId", NS.presentation).map((item, ordinal) => {
    const relationship = presentationRelationships.find((candidate) => candidate.id === item.attrs["r:id"]);
    ensure(relationship?.resolved && item.attrs.id, "MISSING_SLIDE");
    return { id: item.attrs.id, part: relationship.resolved, ordinal };
  });
  const masterRefs = presentationRelationships.filter((item) => item.type.endsWith("/slideMaster")).map((item) => item.resolved ?? item.target);
  const nodes: SemanticNode[] = [node(pkg.mainPart, presentation, "presentation", {
    slideOrder: slides.map((item) => item.id),
    masterRefs,
    slideSize: children(presentation, "sldSz", NS.presentation)[0]?.attrs ?? null,
  }, "presentation")];
  const warnings: string[] = [];
  const interpreted = [pkg.mainPart];

  for (const slide of slides) {
    const xml = pkg.xml(slide.part);
    const relationships = pkg.relationships(slide.part);
    interpreted.push(slide.part);
    const layout = relationships.find((item) => item.type.endsWith("/slideLayout"));
    const notesRelationship = relationships.find((item) => item.type.endsWith("/notesSlide"));
    nodes.push(node(slide.part, xml, "slide", {
      slideId: slide.id,
      layout: layout?.resolved ?? layout?.target ?? null,
      notes: notesRelationship?.resolved ?? notesRelationship?.target ?? null,
      hidden: descendants(presentation, "sldId", NS.presentation).find((item) => item.attrs.id === slide.id)?.attrs.show === "0",
    }, `slide:${slide.id}`));

    const visit = (current: XmlNode, grouped = false): void => {
      const isGroup = current.local === "grpSp";
      if (["sp", "graphicFrame", "pic", "grpSp", "cxnSp"].includes(current.local) && current.uri === NS.presentation) {
        const properties = descendants(current, "cNvPr", NS.presentation)[0];
        const shapeId = properties?.attrs.id;
        ensure(shapeId, "SHAPE_WITHOUT_ID");
        const tables = descendants(current, "tbl", NS.drawing);
        const imageRelationships = descendants(current, "blip", NS.drawing).map((item) => item.attrs["r:embed"]).filter(Boolean);
        const chartRelationships = descendants(current, "chart").map((item) => item.attrs["r:id"]).filter(Boolean);
        nodes.push(node(slide.part, current, isGroup ? "groupShape" : current.local === "pic" ? "image" : tables.length ? "table" : "shape", {
          shapeId,
          name: properties?.attrs.name ?? null,
          text: descendants(current, "t", NS.drawing).map((item) => item.text).join(""),
          placeholder: descendants(current, "ph", NS.presentation).map((item) => item.attrs),
          geometry: descendants(current, "xfrm", NS.drawing).map((item) => item.children.map((child) => ({ kind: child.local, ...child.attrs }))),
          images: imageRelationships,
          chartRefs: chartRelationships,
          editable: !grouped && !isGroup,
        }, `shape:${slide.id}:${shapeId}`));
        for (const [index, cell] of descendants(current, "tc", NS.drawing).entries()) {
          nodes.push(node(slide.part, cell, "tableCell", {
            text: descendants(cell, "t", NS.drawing).map((item) => item.text).join(""),
            editable: !grouped,
          }, `shape:${slide.id}:${shapeId}:cell:${index}`));
        }
        for (const relationshipId of imageRelationships) {
          const relationship = relationships.find((item) => item.id === relationshipId);
          nodes.push(plainNode(`imageRef:${slide.id}:${shapeId}:${relationshipId}`, slide.part, "imageRef", {
            relationshipId,
            target: relationship?.resolved ?? relationship?.target ?? null,
            external: relationship?.external ?? false,
          }));
        }
        for (const relationshipId of chartRelationships) {
          const relationship = relationships.find((item) => item.id === relationshipId);
          const chartPart = relationship?.resolved;
          if (chartPart) {
            const chart = pkg.xml(chartPart);
            nodes.push(node(chartPart, chart, "chart", {
              relationshipId,
              references: descendants(chart, "f").map((item) => item.text),
              seriesText: descendants(chart, "v").map((item) => item.text).slice(0, 1_000),
            }, `chart:${slide.id}:${shapeId}:${relationshipId}`));
          }
        }
      }
      if (isGroup) warnings.push("GROUP_SHAPE_PRESERVED");
      for (const child of current.children) visit(child, grouped || isGroup);
    };
    visit(xml);

    if (descendants(xml, "transition", NS.presentation).length || descendants(xml, "timing", NS.presentation).length) {
      warnings.push("ANIMATION_TRANSITION_PRESERVED");
    }
    for (const relationship of relationships.filter((item) => item.external)) {
      warnings.push("EXTERNAL_RELATIONSHIP_NOT_FETCHED");
      nodes.push(plainNode(`external:${slide.id}:${relationship.id}`, slide.part, "externalReference", {
        relationshipType: relationship.type,
        target: relationship.target,
        fetched: false,
      }));
    }
    if (notesRelationship?.resolved) {
      const notes = pkg.xml(notesRelationship.resolved);
      nodes.push(node(notesRelationship.resolved, notes, "notes", {
        text: descendants(notes, "t", NS.drawing).map((item) => item.text).join(""),
      }, `notes:${slide.id}`));
      interpreted.push(notesRelationship.resolved);
    }
    for (const comments of relationships.filter((item) => item.type.endsWith("/comments") && item.resolved)) {
      const root = pkg.xml(comments.resolved!);
      for (const [index, comment] of descendants(root, "cm").entries()) {
        nodes.push(node(comments.resolved!, comment, "comment", { text: descendants(comment, "text").map((item) => item.text).join("") }, `comment:${slide.id}:${index}`));
      }
      interpreted.push(comments.resolved!);
    }
  }

  const ir = finishIR(pkg, "presentation-ir.v1", nodes, warnings, interpreted);
  return { ...ir, slides };
}

export type PresentationOperation =
  | { type: "replace_text" | "replace_table_cell" | "update_notes"; anchor: string; expectedHash: string; text: string }
  | { type: "reorder_slides"; ids: string[]; expectedHash: string }
  | { type: "replace_image"; anchor: string; expectedHash: string; bytesBase64: string }
  | { type: "duplicate_slide"; sourceSlideId: string; expectedHash: string };

function find(nodeValue: XmlNode, path: string): XmlNode | undefined {
  if (nodeValue.path === path) return nodeValue;
  for (const child of nodeValue.children) {
    const result = find(child, path);
    if (result) return result;
  }
  return undefined;
}

function nextRelationshipId(pkg: OfficePackage, part: string): string {
  const used = new Set(pkg.relationships(part).map((item) => item.id));
  for (let index = 1; index <= 100_000; index += 1) if (!used.has(`rId${index}`)) return `rId${index}`;
  throw new Error("RELATIONSHIP_ID_LIMIT");
}

function nextSlidePart(pkg: OfficePackage): string {
  for (let index = 1; index <= 100_000; index += 1) {
    const candidate = `ppt/slides/slide${index}.xml`;
    if (!pkg.parts.has(candidate)) return candidate;
  }
  throw new Error("SLIDE_PART_LIMIT");
}

export function patchPresentation(pkg: OfficePackage, operations: PresentationOperation[]): Buffer {
  const ir = parsePresentation(pkg);
  const replacements = new Map<string, XmlReplacement[]>();
  const parts = new Map<string, Buffer>();
  const add = (part: string, replacement: XmlReplacement) => replacements.set(part, [...(replacements.get(part) ?? []), replacement]);
  ensure(operations.filter((item) => item.type === "duplicate_slide").length <= 1, "MULTIPLE_SLIDE_DUPLICATION_UNSUPPORTED");

  for (const operation of operations) {
    if (operation.type === "reorder_slides") {
      const presentationNode = ir.nodes.find((item) => item.id === "presentation")!;
      ensure(presentationNode.hash === operation.expectedHash, "STALE_ANCHOR");
      ensure(operation.ids.length === ir.slides.length && new Set(operation.ids).size === operation.ids.length && operation.ids.every((id) => ir.slides.some((slide) => slide.id === id)), "INVALID_SLIDE_ORDER");
      const root = pkg.xml(pkg.mainPart);
      const container = children(root, "sldIdLst", NS.presentation)[0];
      ensure(container, "MISSING_SLIDE_LIST");
      const source = pkg.text(pkg.mainPart);
      const entries = children(container, "sldId", NS.presentation);
      add(pkg.mainPart, innerReplacement(source, container, operation.ids.map((id) => {
        const entry = entries.find((item) => item.attrs.id === id)!;
        return source.slice(entry.start, entry.end);
      }).join("")));
      continue;
    }

    if (operation.type === "duplicate_slide") {
      const sourceSlide = ir.slides.find((item) => item.id === operation.sourceSlideId);
      const sourceNode = ir.nodes.find((item) => item.id === `slide:${operation.sourceSlideId}`);
      ensure(sourceSlide && sourceNode?.hash === operation.expectedHash, "STALE_ANCHOR");
      const sourceRelationships = pkg.relationships(sourceSlide.part);
      ensure(!sourceRelationships.some((item) => item.external || item.type.endsWith("/notesSlide") || item.type.endsWith("/comments")), "SLIDE_DUPLICATION_UNSUPPORTED_RELATIONSHIP");
      const numericIds = ir.slides.map((item) => Number(item.id)).filter(Number.isSafeInteger);
      const newSlideId = String(Math.max(255, ...numericIds) + 1);
      const newRelationshipId = nextRelationshipId(pkg, pkg.mainPart);
      const newPart = nextSlidePart(pkg);

      const presentation = pkg.xml(pkg.mainPart);
      const slideList = children(presentation, "sldIdLst", NS.presentation)[0];
      ensure(slideList, "MISSING_SLIDE_LIST");
      add(pkg.mainPart, { start: slideList.closeStart, end: slideList.closeStart, value: `<p:sldId id="${newSlideId}" r:id="${newRelationshipId}"/>` });

      const presentationRelationshipsPart = relationshipPart(pkg.mainPart);
      const presentationRelationships = pkg.xml(presentationRelationshipsPart);
      add(presentationRelationshipsPart, { start: presentationRelationships.closeStart, end: presentationRelationships.closeStart, value: `<Relationship Id="${newRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${newPart.split("/").at(-1)!}"/>` });

      const contentTypes = pkg.xml("[Content_Types].xml");
      add("[Content_Types].xml", { start: contentTypes.closeStart, end: contentTypes.closeStart, value: `<Override PartName="/${newPart}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` });
      parts.set(newPart, Buffer.from(pkg.parts.get(sourceSlide.part)!.bytes));
      const sourceRelationshipsPart = relationshipPart(sourceSlide.part);
      if (pkg.parts.has(sourceRelationshipsPart)) parts.set(relationshipPart(newPart), Buffer.from(pkg.parts.get(sourceRelationshipsPart)!.bytes));
      continue;
    }

    const target = ir.nodes.find((item) => item.id === operation.anchor);
    ensure(target && target.hash === operation.expectedHash, "STALE_ANCHOR");
    ensure(target.data.editable !== false, "GROUP_SHAPE_WRITE_UNSUPPORTED");
    const root = pkg.xml(target.part);
    const xmlNode = find(root, target.path)!;
    if (operation.type === "replace_image") {
      ensure(target.kind === "image", "NOT_IMAGE");
      const relationshipIds = target.data.images as string[];
      ensure(relationshipIds.length === 1, "AMBIGUOUS_IMAGE");
      const relationship = pkg.relationships(target.part).find((item) => item.id === relationshipIds[0]);
      ensure(relationship?.resolved && !relationship.external, "EXTERNAL_IMAGE_WRITE_UNSUPPORTED");
      const bytes = Buffer.from(operation.bytesBase64, "base64");
      const current = pkg.parts.get(relationship.resolved)!.bytes;
      const png = (value: Buffer) => value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = (value: Buffer) => value[0] === 255 && value[1] === 216;
      ensure((png(bytes) && png(current)) || (jpeg(bytes) && jpeg(current)), "IMAGE_FORMAT_MISMATCH");
      let uses = 0;
      for (const [part] of pkg.parts) {
        if (part.endsWith(".rels")) uses += descendants(pkg.xml(part), "Relationship", NS.rels).filter((item) => item.attrs.Target?.endsWith(relationship.target.split("/").at(-1)!)).length;
      }
      ensure(uses === 1, "SHARED_IMAGE_WRITE_UNSUPPORTED");
      parts.set(relationship.resolved, bytes);
      continue;
    }

    ensure((operation.type === "update_notes" && target.kind === "notes")
      || (operation.type === "replace_table_cell" && target.kind === "tableCell")
      || (operation.type === "replace_text" && target.kind === "shape"), "UNSUPPORTED_PRESENTATION_TARGET");
    ensure(operation.text.length <= 100_000, "TEXT_TOO_LARGE");
    const slots = descendants(xmlNode, "t", NS.drawing);
    ensure(slots.length > 0, "EMPTY_TEXT_TARGET");
    slots.forEach((item, index) => add(target.part, innerReplacement(pkg.text(target.part), item, xmlEscape(index === 0 ? operation.text : ""))));
  }

  for (const [part, changes] of replacements) parts.set(part, Buffer.from(replaceXml(pkg.text(part), changes)));
  return pkg.patch(parts, [...parts.keys()]);
}
