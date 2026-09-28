// Authoring utility. The PPTX is the product input; no rendering dependency ships
// in the web bundle. Pass the bundled pptxgenjs module directory as argv[2].
const path = require('node:path')
const pptxgen = require(process.argv[2] || 'pptxgenjs')
const pptx = new pptxgen()
pptx.layout = 'LAYOUT_WIDE'
pptx.author = 'CENTROPY'
pptx.subject = 'Default editable IC working draft with canonical source bindings'
pptx.title = 'CENTROPY default IC template'
pptx.company = 'CENTROPY'
pptx.lang = 'en-GB'
pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: 'en-GB' }
const ink = '13213B', blue = '315FD6', muted = '526079'
function text(slide, value, x, y, w, h, size, color = ink, bold = false) {
  slide.addText(value, { x, y, w, h, fontFace: 'Arial', fontSize: size, color, bold,
    margin: 0, breakLine: false, valign: 'top', paraSpaceAfterPt: 10 })
}
function slide(title) {
  const s = pptx.addSlide()
  s.background = { color: 'F8FAFE' }
  text(s, title, .65, .45, 12, .7, 32, ink, true)
  text(s, 'CENTROPY default template. Working draft for human committee review.', .65, 7.05, 12, .25, 11, muted)
  return s
}
let s = slide('{{company_name}}')
text(s, 'Investment committee working draft', .65, 1.55, 12, .9, 36, blue, true)
text(s, '{{decision_context}}', .65, 3.1, 12, 2.6, 24)
s = slide('Recorded recommendation')
text(s, '{{recommendation}}', .65, 1.6, 12, 3.8, 23)
text(s, '{{source_cutoff}}', .65, 5.8, 12, .9, 14, muted)
s = slide('Revenue case and model outputs')
text(s, '{{revenue_case}}', .65, 1.5, 5.7, 4.9, 20)
text(s, '{{returns}}', 6.95, 1.5, 5.7, 4.9, 20)
s = slide('Open risks and diligence findings')
text(s, '{{risk_findings}}', .65, 1.5, 12, 5.25, 21)
s = slide('Exact model and memo basis')
text(s, '{{model_lineage}}', .65, 1.5, 12, 2.2, 18)
text(s, '{{memo_basis}}', .65, 4.2, 12, 2.3, 18)
s = slide('Linked evidence')
text(s, '{{source_inventory}}', .65, 1.5, 12, 5.2, 18)
pptx.writeFile({ fileName: path.resolve(__dirname, '../finnor-os/tests/artifact-corpus/centropy-ic-default-template.pptx') })
