/** Independently authored original-byte E2E inputs. No producer, checker or
 * rule-selection imports. Expected identities come from fixture owner state. */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeZip } from '@finnor/ooxml';

export type OwnerSource = {id:string;sourceClass:string;rows:Array<Record<string,unknown>>;
  protocol?:string;bytes?:Buffer;mediaType?:string;extension?:string};
const xml=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const office=(main:string,kind:string,parts:Record<string,string>)=>writeZip(new Map(Object.entries({
  '[Content_Types].xml':`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="${kind}"/></Types>`,
  '_rels/.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`,
  ...parts,
}).map(([path,text])=>[path,Buffer.from(text)])));

export async function heterogeneousOwnerSources(input:{registrationA:string;registrationB:string;
  occurredAt:string;availableAt:string;workRecords:Array<Record<string,unknown>>}){
  const {registrationA:a,registrationB:b,occurredAt,availableAt}=input;
  const entity=(id:string,registrationId=a)=>({id,kind:'entity',entityType:'deal',registrationId});
  const documentLines=(id:string)=>[`Record ID: ${id}`,'Kind: entity','Entity Type: deal',`Registration ID: ${a}`];
  const sources:OwnerSource[]=[
    {id:'crm-original',sourceClass:'crm_deals',protocol:'csv',extension:'csv',
      rows:[entity('deal-A'),entity('deal-B',b)],bytes:Buffer.from(`Opportunity ID,Deal Number,Name\n`+
        `deal-A,${a},Conflicting Harbor\ndeal-B,${b},Conflicting Harbor\n`)},
    {id:'ledger-original',sourceClass:'financial_ledger',protocol:'tsv',extension:'tsv',
      rows:[{id:'balance-A',kind:'quantity',registrationId:a}],bytes:Buffer.from(
        'Transaction ID\tDeal Number\tAmount\tCurrency\tUnit\tPeriod\tAccounting Basis\tAccount\tPosted At\tAvailable At\n'+
        `balance-A\t${a}\t20.00\tUSD\tunits\t2026-10\toutstanding\tfacility balance\t${occurredAt}\t${availableAt}\n`)},
    {id:'work-original',sourceClass:'work_tracking',protocol:'json_records',rows:input.workRecords},
    {id:'document-text',sourceClass:'document_dms',protocol:'text',extension:'txt',
      rows:[entity('document-text-A')],bytes:Buffer.from(documentLines('document-text-A').join('\n')+'\n')},
  ];
  const docx=office('word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',{
    'word/document.xml':`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentLines('document-docx-A')
      .map(line=>`<w:p><w:r><w:t>${xml(line)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`});
  const heading=['id','kind','entityType','registrationId'],row=['document-xlsx-A','entity','deal',a];
  const sheetRow=(values:string[],index:number)=>`<row r="${index}">${values.map((v,column)=>
    `<c r="${'ABCD'[column]}${index}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`).join('')}</row>`;
  const xlsx=office('xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',{
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Records" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRow(heading,1)}${sheetRow(row,2)}</sheetData></worksheet>`});
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([612,792]);
  documentLines('document-pdf-A').forEach((line,i)=>page.drawText(line,{x:48,y:720-i*20,font,size:12}));
  sources.push(
    {id:'document-docx',sourceClass:'document_dms',protocol:'docx',extension:'docx',bytes:docx,rows:[entity('document-docx-A')],
      mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
    {id:'document-xlsx',sourceClass:'document_dms',protocol:'xlsx',extension:'xlsx',bytes:xlsx,rows:[entity('document-xlsx-A')],
      mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
    {id:'document-pdf',sourceClass:'document_dms',protocol:'pdf_text',extension:'pdf',bytes:Buffer.from(await pdf.save()),
      mediaType:'application/pdf',rows:[entity('document-pdf-A')]},
    {id:'mail-original',sourceClass:'email',protocol:'rfc822',extension:'eml',rows:[entity('mail-A')],bytes:Buffer.from(
      `Message-ID: <mail-A@test.invalid>\r\nFrom: analyst@test.invalid\r\nTo: desk@test.invalid\r\nDate: ${new Date(occurredAt).toUTCString()}\r\n`+
      `Subject: Registration assertion and exception request\r\nX-Institution-Entity-Type: deal\r\nX-Institution-Registration-ID: ${a}\r\n\r\n`+
      `This corroborates registration ${a}. An exception is requested; no approval or permission is issued.\r\n`)},
  );
  const calendarTime=(iso:string)=>iso.replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const calendarEnd=new Date(Date.parse(occurredAt)+30000).toISOString();
  sources.push(
    {id:'calendar-original',sourceClass:'calendar',protocol:'icalendar',extension:'ics',rows:[entity('calendar-A')],bytes:Buffer.from(
      `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:calendar-A\r\nDTSTART:${calendarTime(occurredAt)}\r\nDTEND:${calendarTime(calendarEnd)}\r\n`+
      `SUMMARY:Past Deal evidence meeting\r\nX-INSTITUTION-ENTITY-TYPE:deal\r\nX-INSTITUTION-REGISTRATION-ID:${a}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)},
    {id:'approval-original',sourceClass:'approval_records',protocol:'financial_xml',extension:'xml',rows:[entity('approval-A')],
      bytes:Buffer.from(`<?xml version="1.0"?><records><entity id="approval-A" entityType="deal" registrationId="${a}" status="exception_requested_not_approved"/></records>`)},
    {id:'lender-original',sourceClass:'lender_portal',protocol:'html',extension:'html',rows:[{id:'lender-A',kind:'quantity',registrationId:a}],
      bytes:Buffer.from('<!doctype html><html><body><table><tr>'+['Facility ID','Deal Number','Outstanding','Currency','Unit','Period','Accounting Basis','As Of','Available At']
        .map(v=>`<th>${v}</th>`).join('')+'</tr><tr>'+['lender-A',a,'20.00','USD','units','2026-10','outstanding',occurredAt,availableAt]
        .map(v=>`<td>${xml(v)}</td>`).join('')+'</tr></table></body></html>')},
    {id:'crm-paginated',sourceClass:'crm_deals',protocol:'paginated_json',extension:'json',rows:[entity('page-A')],bytes:Buffer.from(JSON.stringify({
      pages:[{cursor:'start',nextCursor:null,records:[entity('page-A')]}]}))},
  );
  return sources;
}
