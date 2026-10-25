import {writeZip,xmlEscape} from '@finnor/ooxml';

/** Public fixture bytes; the expected financial values live in each boundary
 * case and are never calculated by the production reader. */
export function dataRoomWorkbook(options:{company?:string;revenue?:string;numericRevenue?:boolean;formula?:boolean}={}){
 const cells=[
  {row:1,address:'A1',value:options.company??'Atlas Software'},
  {row:2,address:'A2',value:'USD in thousands'},
  {row:3,address:'A3',value:'2025-01-01 to 2025-12-31'},
  {row:5,address:'A5',value:'Net revenue'},
  {row:5,address:'B5',value:options.revenue??'1,234.50',numeric:options.numericRevenue,formula:options.formula},
  {row:6,address:'A6',value:'Operating costs'},
  {row:6,address:'B6',value:'(70)'},
 ];
 const rows=new Map<number,string[]>();
 for(const cell of cells){
  const value=xmlEscape(cell.value),xml=`<c r="${cell.address}" t="${cell.numeric?'n':'inlineStr'}">${cell.formula?'<f>999+1</f>':''}${cell.numeric?`<v>${value}</v>`:`<is><t>${value}</t></is>`}</c>`;
  rows.set(cell.row,[...(rows.get(cell.row)??[]),xml]);
 }
 const sheet=[...rows].map(([row,values])=>`<row r="${row}">${values.join('')}</row>`).join('');
 return writeZip(new Map(Object.entries({
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Income statement" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
 }).map(([path,value])=>[path,Buffer.from(value)])));
}

export function dataRoomContext(company='Atlas Software'){
 return [
  {role:'entity' as const,cell:'A1',text:company},
  {role:'period' as const,cell:'A3',text:'2025-01-01 to 2025-12-31'},
  {role:'currency' as const,cell:'A2',text:'USD in thousands'},
  {role:'scale' as const,cell:'A2',text:'USD in thousands'},
 ];
}
