import type {ClosingWorkContinuation} from './closing';

export interface AcquisitionClosingContext{
 applicable:boolean;
 workId:string;
 dealId:string|null;
 continuation:ClosingWorkContinuation|null;
 deadlineAt:string|null;
 validUntil:string|null;
 expectedSpecDigest:string|null;
 limits:{maxSteps:number;maxActions:number;maxQueries:number;stepCount:number;actionCount:number;queryCount:number}|null;
 acquisition:{decisionId:string;runId:string;resultDigest:string}|null;
 cases:Array<{id:string;state:string;outcome:string|null}>;
 selected:{icCaseId:string;state:string;outcome:string|null;decisionId:string|null;decisionReceiptId:string|null;basisDigest:string}|null;
 conditions:Array<{id:string;revision:number;type:string;state:string;required:boolean;discharged:boolean;title:string;ownerEmployeeId:string|null;workId:string|null;dueAt:string|null;contentDigest:string}>;
 dependencies:Array<{key:string;revision:number}>;
 eligible:boolean;
 blockers:string[];
 authorityGranted:false;
}
