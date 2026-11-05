import type {EndingOutcomeApproval} from './ending-outcomes.js';
import type {StatefulStorylinePlan} from './stateful-storyline-plan.js';
import {evaluateGuard,symbolicAtomKey} from './playtest/symbolic-engine.js';

/** Necessary symbolic feasibility only; it does not certify narrative reachability from a prefix. */
export function suffixFeasibility(outcomes:EndingOutcomeApproval, suffix:StatefulStorylinePlan['beats'], endingId:string, limit=4096):'possible'|'impossible'|'unknown' {
 const relevant=new Set([...suffix.flatMap(b=>[...b.precondition.all,...b.effects]),...outcomes.outcomes.flatMap(o=>o.condition.all)].map(c=>symbolicAtomKey(c.ref)));
 const atoms=outcomes.initialState.filter(a=>relevant.has(symbolicAtomKey(a.ref)));
 const count=atoms.reduce((n,a)=>n*(typeof a.value==='boolean'?2:101),1);
 if(count>limit)return 'unknown'; // Never prune an unsearched numeric or large case.
 for(let i=0;i<count;i++){
  let code=i;const state:Record<string,boolean|number>={};
  for(const a of atoms){const size=typeof a.value==='boolean'?2:101;const digit=code%size;code=Math.floor(code/size);state[symbolicAtomKey(a.ref)]=size===2?digit===1:digit;}
  let blocked=false;
  for(const beat of suffix){
   if(!evaluateGuard(state,beat.precondition)){blocked=true;break;}
   for(const e of beat.effects){const key=symbolicAtomKey(e.ref);state[key]=e.op==='set'?(typeof e.value==='number'?Math.round(e.value*100):e.value):Math.max(0,Math.min(100,(state[key] as number)+Math.round((e.value as number)*100)));}
  }
  if(blocked)continue;
  const matches=outcomes.outcomes.filter(o=>evaluateGuard(state,o.condition));
  if(matches.length===1&&matches[0]!.endingId===endingId)return 'possible';
 }
 return 'impossible';
}
