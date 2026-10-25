import type {PrimaryIntake,PrimarySourceProfile} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {principal} from '../owner-context';
import {primarySourceEndpoint} from '../../../governed-execution/src/primary-records';

const environmentByMode={ordinary_disposable:'DEVELOPMENT',protected:'LIVE'} as const;
export const primaryEnvironmentForMode=(mode:PrimaryIntake['mode'])=>environmentByMode[mode];
export function primaryRuntimeEnvironment(){
 if(process.env.FINNOR_V2_PROFILE==='production_primary'&&process.env.FINNOR_PRIMARY_TRANSPORT_POLICY_FILE)return 'LIVE' as const;
 if(process.env.FINNOR_V2_PROFILE==='ordinary_disposable'&&process.env.NODE_ENV!=='production')return 'DEVELOPMENT' as const;
 throw Error('LIVE_PRIMARY_SOURCE_AUTHORITY_AND_S8_ADMISSION_UNAVAILABLE');
}
export function assertPrimaryRuntimeMode(mode:PrimaryIntake['mode']){
 const environment=primaryRuntimeEnvironment();
 if(environment!==primaryEnvironmentForMode(mode))throw Error('PRIMARY_EXECUTION_PROFILE_MISMATCH');
 return environment;
}
export async function assertPrimarySourceAdmission(ctx:PeMutationContext,source:PrimarySourceProfile){
 primarySourceEndpoint(source);
 if(source.environment==='LIVE')await (await import('../../../capability-evolution/src/primary-admission')).admittedPrimarySource(source,{kind:'current',tenantId:ctx.auth.tenantId,principalId:principal(ctx)});
}
