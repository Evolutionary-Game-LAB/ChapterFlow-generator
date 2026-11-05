import {StatefulPlanError} from '../src/stateful-storyline.js';

/** Keep terminal conflicts as well as missing facts: satisfying a target is not sufficient for exclusive endings. */
export function statefulRepairEvidence(error:unknown):string {
 if(!(error instanceof StatefulPlanError))return (error instanceof Error?error.message:'Invalid candidate').slice(0,6000);
 const evidence=error.evidence as {allRouteObligations?:{firstBlock?:unknown};requiredEnding?:unknown;competingEndings?:unknown;terminal?:unknown;instruction?:unknown};
 if(!evidence?.allRouteObligations)return error.message.slice(0,6000);
 const {firstBlock,...remaining}=evidence.allRouteObligations;
 return JSON.stringify({code:error.code,firstExecutionBlock:firstBlock,routeProblems:remaining,requiredEnding:evidence.requiredEnding,
  competingEndings:evidence.competingEndings,terminal:evidence.terminal,
  instruction:'Establish the requested outcome AND keep competing ending conditions false through plausible events. Do not erase acquired knowledge or costs merely to avoid an overlap. The approved ending definitions are immutable.',
 }).slice(0,6000);
}
