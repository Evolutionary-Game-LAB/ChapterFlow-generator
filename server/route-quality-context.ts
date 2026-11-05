import type {SymbolicStoryPayload} from '../src/symbolic-story-payload.js';
import {StatefulStorylinePlanSchema} from '../src/stateful-storyline-plan.js';
import {approveAuthorContract} from '../src/author-contract.js';
import {approveEndingOutcomes} from '../src/ending-outcomes.js';
import {validateStatefulPlan} from '../src/stateful-storyline.js';
import {analyzeStoryExecution} from '../src/story-execution-analysis.js';
import {reviewEvidence} from './quality-evidence.js';
/** Partition all authored route visits and every additional reachable transition; never drop recombinations. */
export function routeReviewContexts(payload:SymbolicStoryPayload){
 const a=payload.approval,approval=approveAuthorContract(a.brief,a.contract,a.playerId,a.revision),outcomes=approveEndingOutcomes(approval,payload.outcomes.revision,payload.outcomes.initialState,payload.outcomes.outcomes),plan=StatefulStorylinePlanSchema.parse(payload.plan);
 const {model}=validateStatefulPlan(approval,outcomes,plan,true),execution=analyzeStoryExecution(model,plan);
 const base={brief:a.brief,contract:a.contract,endingConditions:outcomes.outcomes,availablePaths:plan.storylines.map((r,i)=>({storylineIndex:i,endingId:r.endingId,events:r.steps.map(s=>({key:s.beatKey,title:plan.beats.find(b=>b.key===s.beatKey)!.title}))})),instruction:'이번 실행 경로를 독립적으로 평가한다.'};
 base.instruction='아래 orderedEvents는 하나의 실제 실행이다. 이 경로의 서술과 이 경로의 상태를 비교한다. 다른 선택은 availablePaths에 별도로 존재하므로 이 경로가 다른 선택을 하지 않았다고 오류로 보지 않는다.';
 const evidence=reviewEvidence(payload);
 const parts=[...execution.routes.map(r=>({id:'route:'+r.storylineIndex,visits:r.visits})),...execution.additionalExecutions.map((e,i)=>({id:'additional:'+i,visits:[e]}))];
 if(parts.length>36)throw Error('Route-wise semantic review exceeds 36 contexts; no reachable context was silently skipped');
 return parts.map(part=>{const keys=new Set(part.visits.map(v=>v.sceneKey));return {id:part.id,keys:[...keys],evidence:evidence.filter(e=>!e.sceneKey||keys.has(e.sceneKey)),candidate:{...base,contextId:part.id,orderedEvents:part.visits.map(v=>{const b=plan.beats.find(b=>b.key===v.sceneKey),scene=payload.details.scenes[v.sceneKey] as {summary:string};return {sceneKey:v.sceneKey,title:payload.skeleton.scenes.find(s=>s.key===v.sceneKey)?.title,prose:scene.summary,precondition:b?.precondition,effects:b?.effects,before:v.before,after:v.after};})}};});
}
