import {EvidenceRequestSchema,type EvidenceRequest} from '@finnor/shared-types';
import {validateProgram} from './operators';
export function parseRequest(body:unknown):EvidenceRequest{const request=EvidenceRequestSchema.parse(body);const inputs=new Set(request.inputs.map(i=>i.inputId));if(inputs.size!==request.inputs.length)throw Error('DUPLICATE_INPUT_ID');validateProgram(request.program,inputs);
 for(const output of request.acceptance.materialOutputs)if(!request.program.outputs.includes(output))throw Error('MATERIAL_OUTPUT_NOT_PUBLISHED');return request;}
