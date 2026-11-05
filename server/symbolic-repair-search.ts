import type {SymbolicStoryPayload} from '../src/symbolic-story-payload.js';
import type {PatchPolicy} from '../src/patch-audit.js';
import {materializeLogicPatch} from '../src/patch-application.js';
import {StatefulStorylinePlanSchema} from '../src/stateful-storyline-plan.js';
/** Bounded search over symbolic edits. Minimal depth among explored candidates, not global optimality. */
export function searchSymbolicRepair(baseline:SymbolicStoryPayload,policy:PatchPolicy,options:{maxCandidates?:number;maxEdits?:number;fields?:readonly ('effects'|'precondition')[]}={},record:(event:Record<string,unknown>)=>void=()=>{}){
 const original=StatefulStorylinePlanSchema.parse(baseline.plan),limit=options.maxCandidates??128,maxEdits=options.maxEdits??2;
 const fields=options.fields??['effects','precondition'];
 if(!fields.length||new Set(fields).size!==fields.length||fields.some(f=>f!=='effects'&&f!=='precondition'))throw Error('Invalid symbolic search fields');
 if(!Number.isInteger(limit)||limit<1||limit>512||!Number.isInteger(maxEdits)||maxEdits<1||maxEdits>2)throw Error('Invalid symbolic search budget');
 try {materializeLogicPatch(baseline,original,policy);return {status:'unchanged-policy-satisfied' as const,tested:0};} catch {}
 const atoms=baseline.outcomes.initialState.filter(a=>typeof a.value==='boolean').map(a=>a.ref);
 const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
 const visited=new Set([canonical(original)]);let tested=0,frontier=[original];
 for(let depth=1;depth<=maxEdits;depth++){
  const next:typeof frontier=[];
  for(const parent of frontier)for(const beat of parent.beats.filter(b=>policy.editableBeatKeys.includes(b.key))){
   const mutations:Array<{field:'precondition'|'effects';values:any[];operation:string}>=[];
   for(const field of fields){
    const terms=field==='effects'?beat.effects:beat.precondition.all;
    for(let i=0;i<terms.length;i++){
     mutations.push({field,values:terms.filter((_v,j)=>j!==i),operation:'remove-'+field+'-'+i});
     if(typeof terms[i].value==='boolean')mutations.push({field,values:terms.map((t,j)=>j===i?{...t,value:!t.value}:t),operation:'flip-'+field+'-'+i});
    }
    for(const ref of atoms)if(!terms.some(t=>canonical(t.ref)===canonical(ref)))for(const value of [false,true])mutations.push({field,values:[...terms,{ref,op:field==='effects'?'set':'eq',value}],operation:'add-'+field});
   }
   for(const mutation of mutations){
    const candidate={...parent,beats:parent.beats.map(b=>b.key===beat.key?{...b,[mutation.field]:mutation.field==='effects'?mutation.values:{all:mutation.values}}:b)};
    const key=canonical(candidate);if(visited.has(key))continue;visited.add(key);
    if(tested>=limit)return {status:'exhausted' as const,tested};tested++;
    try{const result=materializeLogicPatch(baseline,candidate,policy);record({type:'symbolic-candidate',depth,index:tested,candidate,audit:result.audit});return {status:'candidate-unreviewed' as const,tested,depth,candidate:StatefulStorylinePlanSchema.parse(result.payload.plan),payload:result.payload};}
    catch(error){record({type:'symbolic-candidate-rejected',depth,index:tested,candidate,error:String(error)});next.push(candidate);}
   }
  }
  frontier=next;
 }
 return {status:'exhausted' as const,tested};
}
