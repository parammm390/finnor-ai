import { createHash } from 'node:crypto';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { SaxesParser } from 'saxes';

export const ARTIFACT_LIMITS = Object.freeze({ bytes: 10_485_760, expandedBytes: 67_108_864, parts: 4096, xmlBytes: 8_388_608, xmlNodes: 200_000, xmlDepth: 128, irBytes: 16_777_216, pdfPages: 500, ratio: 1000, parseMs: 30_000 });
export class ArtifactError extends Error {
 constructor(readonly code: string, message: string = code) { super(message); this.name='ArtifactError'; }
}
export function ensure(value: unknown, code: string): asserts value { if (!value) throw new ArtifactError(code); }
export async function withArtifactDeadline<T>(work: Promise<T>, timeoutMs: number = ARTIFACT_LIMITS.parseMs): Promise<T> {
 ensure(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=120_000,'INVALID_ARTIFACT_PARSE_TIMEOUT');
 let timer: ReturnType<typeof setTimeout>|undefined;
 try {
  return await Promise.race([
   work,
   new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new ArtifactError('ARTIFACT_PARSE_TIMEOUT')),timeoutMs);}),
  ]);
 } finally {if(timer)clearTimeout(timer);}
}
export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: unknown): string {
 if(value===null) return 'null';
 if(typeof value==='number') { ensure(Number.isFinite(value),'NON_FINITE_NUMBER'); return Object.is(value,-0)?'0':JSON.stringify(value); }
 if(typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 ensure(typeof value==='object','INVALID_CANONICAL_VALUE');
 return '{'+Object.keys(value as object).filter(k=>(value as Record<string,unknown>)[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
export const semanticHash=(value: unknown):string=>sha256(canonical(value));
const CRC_TABLE=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++) c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(bytes: Uint8Array): number {let c=0xffffffff;for(const b of bytes)c=CRC_TABLE[(c^b)&255]!^(c>>>8);return (c^0xffffffff)>>>0;}
export function safePart(name:string):string {
 ensure(name.length>0&&name.length<=512&&!name.startsWith('/')&&!name.includes('\\')&&!/[\x00-\x1f\x7f]/.test(name),'UNSAFE_PART_PATH');
 ensure(!name.split('/').some(p=>p==='..'||p==='.'||p==='')&&!/^[a-z]+:/i.test(name),'UNSAFE_PART_PATH');
 ensure(!/%(?:2e|2f|5c)/i.test(name),'ENCODED_PART_PATH');return name;
}
export interface XmlNode { name:string; local:string; uri:string; attrs:Record<string,string>; children:XmlNode[]; text:string; start:number; openEnd:number; closeStart:number; end:number; path:string }
export const NS={sheet:'http://schemas.openxmlformats.org/spreadsheetml/2006/main',word:'http://schemas.openxmlformats.org/wordprocessingml/2006/main',presentation:'http://schemas.openxmlformats.org/presentationml/2006/main',drawing:'http://schemas.openxmlformats.org/drawingml/2006/main',rels:'http://schemas.openxmlformats.org/package/2006/relationships',officeRel:'http://schemas.openxmlformats.org/officeDocument/2006/relationships',content:'http://schemas.openxmlformats.org/package/2006/content-types'};
export function parseXml(source:string):XmlNode {
 ensure(Buffer.byteLength(source)<=ARTIFACT_LIMITS.xmlBytes,'XML_TOO_LARGE');
 ensure(!/<!\s*(?:DOCTYPE|ENTITY)/i.test(source),'XML_DTD_FORBIDDEN');
 const parser=new SaxesParser({xmlns:true,position:true});const stack:XmlNode[]=[];let root:XmlNode|undefined;let count=0;
 parser.on('error',()=>{throw new ArtifactError('MALFORMED_XML');});
 parser.on('opentag',tag=>{
  ensure(++count<=ARTIFACT_LIMITS.xmlNodes&&stack.length<ARTIFACT_LIMITS.xmlDepth,'XML_COMPLEXITY_LIMIT');
  // Saxes positions count UTF-16 code units, matching source slices. The last '<'
  // starts this tag; literal '<' is forbidden in attribute values by XML grammar.
  const end=parser.position;const start=source.lastIndexOf('<',end-1);const parent=stack.at(-1);
  const attrs:Record<string,string>={};for(const a of Object.values(tag.attributes))attrs[a.name]=a.value;
  const node:XmlNode={name:tag.name,local:tag.local,uri:tag.uri,attrs,children:[],text:'',start,openEnd:end,closeStart:end,end,path:(parent?.path??'')+'/'+tag.name+'['+(1+(parent?.children.filter(x=>x.name===tag.name).length??0))+']'};
  if(parent)parent.children.push(node);else{ensure(!root,'MULTIPLE_XML_ROOTS');root=node;}stack.push(node);
 });
 parser.on('text',s=>{if(stack.length)stack.at(-1)!.text+=s;});
 parser.on('cdata',s=>{if(stack.length)stack.at(-1)!.text+=s;});
 parser.on('closetag',tag=>{const n=stack.pop()!;n.end=parser.position;n.closeStart=tag.isSelfClosing?n.openEnd:source.lastIndexOf('</',n.end-1);});
 parser.write(source).close();ensure(root,'MISSING_XML_ROOT');return root;
}
export function children(n:XmlNode,local:string,uri?:string):XmlNode[]{return n.children.filter(c=>c.local===local&&(!uri||c.uri===uri));}
export function descendants(n:XmlNode,local:string,uri?:string):XmlNode[]{const result:XmlNode[]=[];const visit=(x:XmlNode)=>{for(const c of x.children){if(c.local===local&&(!uri||c.uri===uri))result.push(c);visit(c);}};visit(n);return result;}
export function textContent(n:XmlNode):string{return n.text+n.children.map(textContent).join('');}
export function xmlEscape(value:string):string {ensure(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),'INVALID_XML_TEXT');return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
export interface XmlReplacement {start:number;end:number;value:string}
export function replaceXml(source:string,changes:XmlReplacement[]):string {
 const sorted=[...changes].sort((a,b)=>a.start-b.start);let last=0;let result='';
 for(const c of sorted){ensure(c.start>=last&&c.end>=c.start&&c.end<=source.length,'OVERLAPPING_XML_PATCH');result+=source.slice(last,c.start)+c.value;last=c.end;}
 result+=source.slice(last);parseXml(result);return result;
}
export function innerReplacement(source:string,n:XmlNode,value:string):XmlReplacement {
 if(source.slice(n.start,n.openEnd).endsWith('/>'))return {start:n.start,end:n.end,value:source.slice(n.start,n.openEnd-2)+'>'+value+'</'+n.name+'>'};
 return {start:n.openEnd,end:n.closeStart,value};
}
export function attributeReplacement(source:string,n:XmlNode,key:string,value:string):XmlReplacement {
 const open=source.slice(n.start,n.openEnd);const escaped=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const rx=new RegExp('\\s'+escaped+'\\s*=\\s*(["\'])(.*?)\\1');
 const attr=' '+key+'="'+xmlEscape(value)+'"';const next=rx.test(open)?open.replace(rx,attr):open.replace(/\/?\>$/,m=>attr+m);
 return {start:n.start,end:n.openEnd,value:next};
}
export interface Part {name:string;bytes:Buffer;hash:string}
export interface Relationship {id:string;type:string;target:string;external:boolean;resolved:string|null}
export class OfficePackage {
 readonly parts=new Map<string,Part>();readonly format:'xlsx'|'xlsm'|'docx'|'pptx';readonly mainPart:string;
 constructor(readonly source:Buffer) {
  ensure(source.length<=ARTIFACT_LIMITS.bytes,'ARTIFACT_TOO_LARGE');ensure(source.length>=22,'INVALID_ZIP');
  let e=-1;for(let i=source.length-22;i>=Math.max(0,source.length-65557);i--){if(source.readUInt32LE(i)===0x06054b50&&i+22+source.readUInt16LE(i+20)===source.length){e=i;break;}}
  ensure(e>=0,'INVALID_ZIP');ensure(source.readUInt16LE(e+4)===0&&source.readUInt16LE(e+6)===0,'MULTIDISK_UNSUPPORTED');
  const count=source.readUInt16LE(e+10),central=source.readUInt32LE(e+16),centralSize=source.readUInt32LE(e+12);
  ensure(count>0&&count<=ARTIFACT_LIMITS.parts&&count===source.readUInt16LE(e+8),'ZIP_PART_LIMIT');ensure(central+centralSize===e,'INVALID_ZIP_DIRECTORY');
  let p=central,total=0;const spans:Array<[number,number]>=[];
  for(let i=0;i<count;i++) {
   ensure(p+46<=e&&source.readUInt32LE(p)===0x02014b50,'INVALID_ZIP_ENTRY');
   const flags=source.readUInt16LE(p+8),method=source.readUInt16LE(p+10),crc=source.readUInt32LE(p+16),compressed=source.readUInt32LE(p+20),size=source.readUInt32LE(p+24),nl=source.readUInt16LE(p+28),el=source.readUInt16LE(p+30),cl=source.readUInt16LE(p+32),off=source.readUInt32LE(p+42);
   ensure(!(flags&1)&&!(flags&64),'ENCRYPTED_PACKAGE_UNSUPPORTED');ensure(method===0||method===8,'ZIP_COMPRESSION_UNSUPPORTED');
   ensure(p+46+nl+el+cl<=e&&nl>0,'INVALID_ZIP_ENTRY');const raw=source.subarray(p+46,p+46+nl);
   const name=new TextDecoder('utf-8',{fatal:true}).decode(raw);p+=46+nl+el+cl;
   // Directory entries carry no artifact part and must still have safe names.
   const directory=name.endsWith('/');safePart(directory?name.slice(0,-1):name);
   ensure(!this.parts.has(name),'DUPLICATE_ZIP_PART');
   ensure(size<=ARTIFACT_LIMITS.expandedBytes&&size/Math.max(compressed,1)<=ARTIFACT_LIMITS.ratio,'ZIP_BOMB');total+=size;ensure(total<=ARTIFACT_LIMITS.expandedBytes,'ZIP_EXPANSION_LIMIT');
   ensure(off+30<=central&&source.readUInt32LE(off)===0x04034b50,'INVALID_LOCAL_HEADER');
   const lnl=source.readUInt16LE(off+26),lel=source.readUInt16LE(off+28);const begin=off+30+lnl+lel;const end=begin+compressed;
   ensure(end<=central&&source.readUInt16LE(off+8)===method&&source.readUInt16LE(off+6)===flags&&source.subarray(off+30,off+30+lnl).equals(raw),'ZIP_HEADER_MISMATCH');
   ensure(!spans.some(([a,b])=>off<b&&end>a),'OVERLAPPING_ZIP_ENTRIES');spans.push([off,end]);
   let bytes:Buffer;try{bytes=method===0?Buffer.from(source.subarray(begin,end)):inflateRawSync(source.subarray(begin,end),{maxOutputLength:Math.max(size,1)});}catch{throw new ArtifactError('INVALID_COMPRESSED_PART');}
   ensure(bytes.length===size&&crc32(bytes)===crc,'ZIP_CHECKSUM_MISMATCH');
   if(directory){ensure(size===0,'INVALID_ZIP_DIRECTORY_ENTRY');continue;}
   this.parts.set(name,{name,bytes,hash:sha256(bytes)});
   if(name.endsWith('.xml')||name.endsWith('.rels'))this.xml(name);
  }
  ensure(p===e,'ZIP_DIRECTORY_SIZE_MISMATCH');
  const types=this.xml('[Content_Types].xml');ensure(types.local==='Types'&&types.uri===NS.content,'INVALID_CONTENT_TYPES');
  const roots=this.relationships('').filter(r=>r.type.endsWith('/officeDocument')&&!r.external);ensure(roots.length===1&&roots[0]!.resolved,'INVALID_OFFICE_MAIN_RELATIONSHIP');this.mainPart=roots[0]!.resolved!;
  const mainType=children(types,'Override',NS.content).find(n=>n.attrs.PartName==='/'+this.mainPart)?.attrs.ContentType;
  const kinds:Record<string,OfficePackage['format']>={'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml':'xlsx','application/vnd.ms-excel.sheet.macroEnabled.main+xml':'xlsm','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml':'docx','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml':'pptx'};
  ensure(mainType&&kinds[mainType],'UNSUPPORTED_OFFICE_FORMAT');this.format=kinds[mainType]!;ensure(this.parts.has(this.mainPart),'MISSING_MAIN_PART');
  for(const name of this.parts.keys())if(name.endsWith('.rels'))this.relationships(name==='_rels/.rels'?'':posix.join(posix.dirname(posix.dirname(name)),posix.basename(name,'.rels')));
 }
 xml(name:string):XmlNode{return parseXml(this.text(name));}
 text(name:string):string {const p=this.parts.get(name);ensure(p,'MISSING_PACKAGE_PART');try{return new TextDecoder('utf-8',{fatal:true}).decode(p.bytes);}catch{throw new ArtifactError('UNSUPPORTED_XML_ENCODING');}}
 relationships(part:string):Relationship[]{
  const name=part?posix.join(posix.dirname(part),'_rels',posix.basename(part)+'.rels'):'_rels/.rels';if(!this.parts.has(name))return [];
  const root=this.xml(name);ensure(root.local==='Relationships'&&root.uri===NS.rels,'INVALID_RELATIONSHIPS');const ids=new Set<string>();
  return children(root,'Relationship',NS.rels).map(n=>{
   const {Id:id,Type:type,Target:target,TargetMode:mode}=n.attrs;ensure(id&&type&&target&&!ids.has(id),'INVALID_RELATIONSHIP');ids.add(id);
   ensure(mode===undefined||mode==='Internal'||mode==='External','INVALID_RELATIONSHIP_MODE');const external=mode==='External';let resolved:string|null=null;
   if(!external){ensure(!target.includes('\\')&&!target.includes('%')&&!target.includes('#')&&!/^[a-z]+:/i.test(target),'UNSAFE_RELATIONSHIP');resolved=posix.normalize(target.startsWith('/')?target.slice(1):posix.join(posix.dirname(part),target));safePart(resolved);ensure(this.parts.has(resolved),'DANGLING_RELATIONSHIP');}
   return {id,type,target,external,resolved};
  });
 }
 patch(replacements:ReadonlyMap<string,Buffer>,allowedParts:readonly string[]):Buffer {
  ensure([...replacements.keys()].every(k=>allowedParts.includes(k)),'UNDECLARED_PART_MUTATION');
  if([...replacements].every(([k,b])=>this.parts.get(k)?.bytes.equals(b)))return Buffer.from(this.source);
  const parts=new Map([...this.parts].map(([k,v])=>[k,v.bytes]));for(const [k,v]of replacements){safePart(k);parts.set(k,v);}
  const output=writeZip(parts);const reparsed=new OfficePackage(output);ensure(reparsed.format===this.format,'FORMAT_CHANGED');
  for(const [k,v]of this.parts)if(!replacements.has(k))ensure(reparsed.parts.get(k)?.hash===v.hash,'UNTOUCHED_PART_CHANGED');
  return output;
 }
}
export function writeZip(parts:ReadonlyMap<string,Buffer>):Buffer {
 ensure(parts.size<=ARTIFACT_LIMITS.parts,'ZIP_PART_LIMIT');const local:Buffer[]=[],central:Buffer[]=[];let offset=0,total=0;
 for(const [name,bytes]of parts){safePart(name);total+=bytes.length;ensure(total<=ARTIFACT_LIMITS.expandedBytes,'ZIP_EXPANSION_LIMIT');const n=Buffer.from(name),deflated=deflateRawSync(bytes);const useDeflate=bytes.length/Math.max(deflated.length,1)<=ARTIFACT_LIMITS.ratio;const compressed=useDeflate?deflated:bytes;const crc=crc32(bytes);const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(0x800,6);l.writeUInt16LE(useDeflate?8:0,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(compressed.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(n.length,26);
 const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(useDeflate?8:0,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);local.push(l,n,compressed);central.push(c,n);offset+=l.length+n.length+compressed.length;}
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(parts.size,8);end.writeUInt16LE(parts.size,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);const out=Buffer.concat([...local,cd,end]);ensure(out.length<=ARTIFACT_LIMITS.bytes,'ARTIFACT_TOO_LARGE');return out;
}
export interface SemanticNode {id:string;part:string;path:string;kind:string;hash:string;data:Record<string,unknown>}
export interface SemanticIR {schema:string;kind:string;nodes:SemanticNode[];warnings:string[];opaqueParts:Record<string,string>;semanticHash:string}
export function node(part:string,n:XmlNode,kind:string,data:Record<string,unknown>,id=part+'#'+n.path):SemanticNode {return {id,part,path:n.path,kind,hash:semanticHash(data),data};}
export function finishIR(pkg:OfficePackage,schema:string,nodes:SemanticNode[],warnings:string[],interpreted:readonly string[]):SemanticIR {
 const opaqueParts=Object.fromEntries([...pkg.parts].filter(([k])=>!interpreted.includes(k)).map(([k,v])=>[k,v.hash]));
 const result={schema,kind:pkg.format,nodes,warnings:[...new Set(warnings)].sort(),opaqueParts};ensure(Buffer.byteLength(canonical(result))<=ARTIFACT_LIMITS.irBytes,'IR_TOO_LARGE');return {...result,semanticHash:semanticHash(result)};
}
export interface SemanticChange {id:string;kind:string;before?:string;after?:string}
export function diffIR(a:SemanticIR,b:SemanticIR):SemanticChange[]{const left=new Map(a.nodes.map(n=>[n.id,n])),right=new Map(b.nodes.map(n=>[n.id,n]));const out:SemanticChange[]=[];
 for(const id of [...new Set([...left.keys(),...right.keys()])].sort()){const x=left.get(id),y=right.get(id);if(x?.hash===y?.hash)continue;out.push({id,kind:!x?'added':!y?'removed':x.kind==='cell'?(x.data.formula!==y.data.formula?'formula-change':x.data.value!==y.data.value?'value-change':x.data.cached!==y.data.cached?'cached-value-change':'format-only'):'modified',before:x?.hash,after:y?.hash});}
 for(const id of [...new Set([...Object.keys(a.opaqueParts),...Object.keys(b.opaqueParts)])].sort())if(a.opaqueParts[id]!==b.opaqueParts[id])out.push({id,kind:'OPAQUE_PART_CHANGED',before:a.opaqueParts[id],after:b.opaqueParts[id]});return out;
}
