import {readFile,writeFile} from 'node:fs/promises';
import {calibrateDevelopment} from '../../packages/private-equity/src/compute-search/calibration';
import {currentCodeIdentity} from '../../packages/private-equity/src/evidence-execution/store';
if(process.argv.length!==4)throw Error('EXPECTED_DATASET_AND_NEW_REPORT_PATH');
const bytes=await readFile(process.argv[2]!);if(bytes.length>1048576)throw Error('P2_CALIBRATION_BYTE_BOUND');
const data=JSON.parse(bytes.toString()),code=await currentCodeIdentity();if(data.frozenCodeDigest!==code.digest)throw Error('P2_CALIBRATION_CODE_CUT_CHANGED');
const report=calibrateDevelopment(data);await writeFile(process.argv[3]!,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output:process.argv[3],status:report.status,productionRoutingAdmitted:report.productionRoutingAdmitted}));
