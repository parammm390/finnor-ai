import { ensure, ArtifactError } from '@finnor/ooxml';
export interface CellRef {column:number;row:number;absoluteColumn:boolean;absoluteRow:boolean}
export function parseA1(value:string):CellRef {const m=/^(\$?)([A-Z]{1,3})(\$?)([1-9]\d{0,6})$/i.exec(value);ensure(m,'INVALID_A1');let column=0;for(const c of m[2]!.toUpperCase())column=column*26+c.charCodeAt(0)-64;const row=Number(m[4]);ensure(column<=16384&&row<=1048576,'A1_OUT_OF_RANGE');return {column,row,absoluteColumn:m[1]==='$',absoluteRow:m[3]==='$'};}
export function columnName(column:number):string {ensure(Number.isInteger(column)&&column>=1&&column<=16384,'A1_OUT_OF_RANGE');let result='';while(column){column--;result=String.fromCharCode(65+column%26)+result;column=Math.floor(column/26);}return result;}
export function a1(r:CellRef):string {ensure(r.row>=1&&r.row<=1048576,'A1_OUT_OF_RANGE');return (r.absoluteColumn?'$':'')+columnName(r.column)+(r.absoluteRow?'$':'')+r.row;}
export function rangeAddresses(range:string,limit=10000):string[]{const parts=range.split(':');ensure(parts.length<=2,'INVALID_RANGE');const a=parseA1(parts[0]!),b=parseA1(parts[1]??parts[0]!);ensure(b.row>=a.row&&b.column>=a.column,'INVALID_RANGE');ensure((b.row-a.row+1)*(b.column-a.column+1)<=limit,'RANGE_LIMIT');const out:string[]=[];for(let r=a.row;r<=b.row;r++)for(let c=a.column;c<=b.column;c++)out.push(columnName(c)+r);return out;}
export type FormulaToken={kind:'word'|'number'|'string'|'sheet'|'structured'|'error'|'operator';text:string;start:number;end:number};
export function tokenizeFormula(formula:string):FormulaToken[]{ensure(formula.length<=32768,'FORMULA_TOO_LONG');let i=formula.startsWith('=')?1:0;const out:FormulaToken[]=[];
 while(i<formula.length){if(/\s/.test(formula[i]!)){i++;continue;}const start=i,c=formula[i]!;let kind:FormulaToken['kind'];
 if(c==='"'||c==="'"){kind=c==='"'?'string':'sheet';i++;let closed=false;while(i<formula.length){if(formula[i]===c){i++;if(formula[i]===c){i++;continue;}closed=true;break;}i++;}ensure(closed,'MALFORMED_FORMULA_STRING');}
 else if(c==='['){kind='structured';let depth=0;do{if(formula[i]==='[')depth++;if(formula[i]===']')depth--;i++;ensure(i-start<=4096,'FORMULA_STRUCTURE_LIMIT');}while(depth&&i<formula.length);ensure(depth===0,'MALFORMED_STRUCTURED_REFERENCE');}
 else {const rest=formula.slice(i);let m:RegExpExecArray|null;if((m=/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest))){kind='number';i+=m[0].length;}else if((m=/^\$?[A-Za-z_\\][A-Za-z0-9_.$\\]*/.exec(rest))){kind='word';i+=m[0].length;}else if((m=/^#(?:REF!|VALUE!|DIV\/0!|N\/A|NAME\?|NUM!|NULL!|SPILL!|CALC!)/.exec(rest))){kind='error';i+=m[0].length;}else{ensure('+-*/^&=<>%,:;(){}!@#'.includes(c),'UNSUPPORTED_FORMULA_TOKEN');kind='operator';i+=['<=','>=','<>'].includes(formula.slice(i,i+2))?2:1;}}
 out.push({kind,text:formula.slice(start,i),start,end:i});ensure(out.length<=8192,'FORMULA_TOKEN_LIMIT');
 }return out;
}
// Bounded expression grammar validation. No evaluation, code execution or guessed
// references. Excel reference operators are first-class grammar tokens.
export function validateFormula(tokens:FormulaToken[]):void {let pos=0,depth=0;const t=()=>tokens[pos]?.text;const consume=()=>tokens[pos++];
 const expr=(minimum=0):void=>{ensure(++depth<=128,'FORMULA_DEPTH_LIMIT');const next=consume();ensure(next,'MISSING_FORMULA_OPERAND');
 if(['+','-','@'].includes(next.text))expr(8);
 else if(next.text==='('){expr();ensure(t()===')','MALFORMED_FORMULA');consume();}
 else if(next.kind==='word'&&t()==='('){consume();if(t()!==')'){while(true){if(t()!==','&&t()!==')')expr(1);if(t()!==',')break;consume();}}ensure(t()===')','MALFORMED_FORMULA');consume();}
 else {ensure(['word','number','string','sheet','structured','error'].includes(next.kind),'MALFORMED_FORMULA');if(next.kind==='word'&&tokens[pos]?.kind==='structured')consume();if(t()==='!'){consume();const ref=consume();ensure(ref?.kind==='word'||ref?.kind==='error','MALFORMED_FORMULA_REFERENCE');}}
 while(pos<tokens.length){const op=t()!;if(op==='%'||op==='#'){consume();continue;}const prec:Record<string,number>={',':0,'=':2,'<':2,'>':2,'<=':2,'>=':2,'<>':2,'&':3,'+':4,'-':4,'*':5,'/':5,'^':6,':':7};const level=prec[op];if(level===undefined||level<minimum)break;consume();expr(level+(op==='^'?0:1));}depth--;};
 expr();ensure(pos===tokens.length,'UNSUPPORTED_FORMULA_GRAMMAR');
}
export interface FormulaDependency {sheet:string;range:string;external?:boolean;name?:string;table?:string}
export interface FormulaAnalysis {tokens:FormulaToken[];dependencies:FormulaDependency[];completeness:'complete'|'partial';warnings:string[]}
export function analyzeFormula(formula:string,sheet:string,names:Record<string,string>={},tables:Record<string,{sheet:string;range:string;columns:string[]}>= {},seen=new Set<string>()):FormulaAnalysis {
 let tokens:FormulaToken[];try{tokens=tokenizeFormula(formula);validateFormula(tokens);}catch(e){return {tokens:[],dependencies:[],completeness:'partial',warnings:[e instanceof ArtifactError?e.code:'UNSUPPORTED_FORMULA']};}
 const dependencies:FormulaDependency[]=[];const warnings:string[]=[];
 for(let i=0;i<tokens.length;i++){const token=tokens[i]!;if(token.kind==='word'&&['INDIRECT','OFFSET'].includes(token.text.toUpperCase())&&tokens[i+1]?.text==='(')warnings.push('DYNAMIC_DEPENDENCY');
 if(token.kind==='structured'){if(tokens[i+1]?.kind==='word'&&tokens[i+2]?.text==='!'){dependencies.push({sheet:token.text+tokens[i+1]!.text,range:tokens[i+3]?.text??'',external:true});warnings.push('EXTERNAL_REFERENCE');i+=3;}else if(tokens[i-1]?.kind==='word'){const table=tables[tokens[i-1]!.text];if(table){dependencies.push({sheet:table.sheet,range:table.range,table:tokens[i-1]!.text});warnings.push('STRUCTURED_REFERENCE_CONSERVATIVE_RANGE');}else warnings.push('UNRESOLVED_TABLE_REFERENCE');}else warnings.push('UNRESOLVED_STRUCTURED_REFERENCE');continue;}
 if(token.kind!=='word'&&token.kind!=='sheet')continue;if(tokens[i+1]?.text==='('||tokens[i+1]?.kind==='structured')continue;
 let targetSheet=sheet;let value=token.text;if(tokens[i+1]?.text==='!'){targetSheet=token.kind==='sheet'?token.text.slice(1,-1).replaceAll("''","'"):token.text;value=tokens[i+2]?.text??'';i+=2;}
 try{parseA1(value);let range=value;if(tokens[i+1]?.text===':'){const end=tokens[i+2]?.text??'';parseA1(end);range+=':'+end;i+=2;}const external=/^\[[^\]]+\]/.test(targetSheet);dependencies.push({sheet:targetSheet,range,...(external?{external:true}: {})});if(external)warnings.push('EXTERNAL_REFERENCE');}
 catch{const key=targetSheet+'!'+value;const expression=names[key]??names[value];if(expression&&!seen.has(key)){const next=analyzeFormula(expression,targetSheet,names,tables,new Set([...seen,key]));dependencies.push(...next.dependencies.map(d=>({...d,name:value})));warnings.push(...next.warnings);}else if(expression){warnings.push('CIRCULAR_NAME');}else if(!['TRUE','FALSE'].includes(value.toUpperCase()))warnings.push('UNRESOLVED_NAME:'+value);}
 }
 return {tokens,dependencies,completeness:warnings.length?'partial':'complete',warnings:[...new Set(warnings)]};
}
export function translateFormula(formula:string,columns:number,rows:number):string {
 const tokens=tokenizeFormula(formula);validateFormula(tokens);let result='',last=0;
 for(let i=0;i<tokens.length;i++){const t=tokens[i]!;if(t.kind!=='word'||tokens[i+1]?.text==='!'||tokens[i+1]?.text==='('||tokens[i+1]?.kind==='structured')continue;let ref:CellRef;try{ref=parseA1(t.text);}catch{continue;}
 if(!ref.absoluteColumn)ref.column+=columns;if(!ref.absoluteRow)ref.row+=rows;const value=a1(ref);result+=formula.slice(last,t.start)+value;last=t.end;
 }return result+formula.slice(last);
}
export function staticCycles(edges:ReadonlyMap<string,readonly string[]>):string[][] {const state=new Map<string,number>(),path:string[]=[],cycles:string[][]=[];
 const visit=(id:string)=>{if(state.get(id)===1){const cycle=path.slice(path.indexOf(id)).concat(id);const key=cycle.slice(0,-1).sort().join('\u0000');if(!cycles.some(existing=>existing.slice(0,-1).sort().join('\u0000')===key))cycles.push(cycle);return;}if(state.get(id)===2)return;ensure(path.length<4096,'FORMULA_GRAPH_DEPTH_LIMIT');state.set(id,1);path.push(id);for(const n of edges.get(id)??[])if(edges.has(n))visit(n);path.pop();state.set(id,2);};for(const id of edges.keys())visit(id);return cycles;}
