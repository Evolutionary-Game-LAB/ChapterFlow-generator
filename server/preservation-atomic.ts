import {z} from 'zod';
import type {SymbolicStoryPayload} from '../src/symbolic-story-payload.js';
import {compilePreservationPolicy,preservationContext,preservationSources} from './preservation-policy.js';
export const AtomicJudgment=z.object({verdict:z.enum(['must_be_true','must_be_false','not_required','ambiguous']),sourceIds:z.array(z.string()).max(4),reason:z.string().min(1).max(240)}).strict();
export type AtomicResult=z.infer<typeof AtomicJudgment>;
export const atomicPrompt='한 가지 명제만 판단하세요. 작가 요구와 기호의 뜻을 근거로 답하고 다른 사건이나 경로의 상태를 섞지 마세요. 기존 심볼 구현은 제공되지 않으므로 추정해서 복원하지 마세요. 사건 목록은 시간순이며, 선택지를 소개하는 문장은 실제 선택 또는 완료된 행위가 아닙니다. 계약이 요구하는 true는 must_be_true, false는 must_be_false입니다. 조건이 요구되지 않으면 not_required, 작가 의도 자체가 모호하거나 서술 자체가 계약과 모순되면 ambiguous입니다. 여러 경로에서 서로 다른 값이 정당하게 가능하다는 것은 모호함이 아닙니다. 공통 필수값이 없는 전제조건 질문에는 not_required로 답하세요. false가 요구된다는 것과 요구 자체가 없다는 것을 구분하세요. 상태가 이미 유지된다는 사실은 매 사건이 그 값을 대입해야 한다는 뜻이 아닙니다. sourceIds에는 이 판단을 지지하는 작가 원문 ID만 넣으세요. 해당 경로의 선택이나 행동을 직접 명시한 문장을 우선 인용하고, 다른 경로에 관한 문장으로 대신하지 마세요. reason은 짧은 한 문장으로 쓰세요. 설명을 추론 과정으로 늘이지 마세요. JSON만 반환하세요.';
export function atomicRequests(payload:SymbolicStoryPayload,scope:readonly string[]){
 const context=preservationContext(payload,scope),sources=preservationSources(payload),atoms=payload.outcomes.initialState;
 if(atoms.some(a=>typeof a.value!=='boolean'))throw Error('Atomic boolean extraction cannot represent numeric atoms; abstain instead of dropping numeric requirements');
 if(!scope.length||new Set(scope).size!==scope.length||scope.some(k=>!context.events.some(e=>e.key===k)))throw Error('Invalid atomic scope');
 const quoteSources=sources.filter(s=>s.kind!=='definition');
 const schema={type:'object',additionalProperties:false,required:['verdict','sourceIds','reason'],properties:{verdict:{type:'string',enum:['must_be_true','must_be_false','not_required','ambiguous']},sourceIds:{type:'array',maxItems:4,items:{type:'string',enum:quoteSources.map(s=>s.id)}},reason:{type:'string',minLength:1,maxLength:240}}};
 const requests=[];
 for(const beatKey of scope){
  const event=context.events.find(e=>e.key===beatKey)!;
  const routes=context.routes.filter(r=>r.beatKeys.includes(beatKey));
  for(const [atomIndex,atom] of atoms.entries()){
   const definition=[...payload.approval.contract.stateSymbols,...payload.approval.contract.relationshipSymbols].find(s=>s.id===atom.ref.symbol);
   const common={authorSources:quoteSources,symbol:{ref:atom.ref,meaning:definition?.meaning,initialValue:atom.value},targetEvent:{title:event.title,prose:event.prose}};
   for(const kind of ['precondition','effect'] as const){
    const question=kind==='precondition'?'이 사건에 진입하기 위한 필수 전제조건으로, 이 기호의 값이 모든 진입 경로에서 반드시 특정 값이어야 한다고 작가가 요구하는가? 단지 앞에서 그렇게 된 상태와 필수 전제조건은 다르다. 공통 필수값이 없으면 not_required.':'작가 요구상 이 사건 자체가 이 기호를 true 또는 false로 직접 설정하는 행위인가? 이전 값을 그대로 유지해야 한다면 not_required이다. 다른 사건이 이미 만든 상태라는 이유로 새 대입을 요구하지 마라.';
    requests.push({id:kind+':'+beatKey+':'+atomIndex,kind,beatKey,ref:atom.ref,storylineIndex:null as number|null,schema,input:{...common,question,enteringPaths:routes.map(r=>({events:r.beatKeys.slice(0,r.beatKeys.indexOf(beatKey)+1).map(k=>{const e=context.events.find(v=>v.key===k)!;return {title:e.title,prose:e.prose};})}))}});
   }
   for(const route of routes){
    const path=route.beatKeys.slice(0,route.beatKeys.indexOf(beatKey)+1).map(k=>{const e=context.events.find(v=>v.key===k)!;return {title:e.title,prose:e.prose};});
    requests.push({id:'route-state:'+beatKey+':'+route.storylineIndex+':'+atomIndex,kind:'route-state' as const,beatKey,ref:atom.ref,storylineIndex:route.storylineIndex,schema,input:{...common,question:'아래 하나의 경로에서 사건들이 차례로 일어났다. 마지막 사건 직후 이 기호는 작가 요구를 지키려면 true여야 하는가, false여야 하는가? 다른 경로는 고려하지 않는다. 계약이 이 상태를 요구하지 않으면 not_required.',path}});
   }
  }
 }
 if(requests.length>120)throw Error('Atomic extraction exceeds 120 judgments');
 return requests;
}
export type AtomicRequest=ReturnType<typeof atomicRequests>[number];
export function validateAtomic(raw:unknown,payload:SymbolicStoryPayload):AtomicResult{
 const r=AtomicJudgment.parse(raw),sources=preservationSources(payload).filter(s=>s.kind!=='definition');
 if(new Set(r.sourceIds).size!==r.sourceIds.length||r.sourceIds.some(id=>!sources.some(s=>s.id===id)))throw Error('Unknown or repeated author source');
 if(r.verdict.startsWith('must_')&&!r.sourceIds.length)throw Error('Required fact lacks author evidence');
 return r;
}
export async function extractAtomicPolicy(payload:SymbolicStoryPayload,scope:readonly string[],call:(request:AtomicRequest)=>Promise<AtomicResult>){
 const requests=atomicRequests(payload,scope),judgments=[];
 const obligations:any[]=[],routeObligations:any[]=[],used=new Set<string>();let ambiguous=false;
 for(const request of requests){
  const judgment=validateAtomic(await call(request),payload);judgments.push({id:request.id,judgment});
  if(judgment.verdict==='ambiguous')ambiguous=true;
  if(!judgment.verdict.startsWith('must_'))continue;
  judgment.sourceIds.forEach(id=>used.add(id));
  const value=judgment.verdict==='must_be_true',base={beatKey:request.beatKey,rationale:judgment.reason,sourceIds:judgment.sourceIds};
  if(request.kind==='route-state')routeObligations.push({...base,storylineIndex:request.storylineIndex,requiredState:{all:[{ref:request.ref,op:'eq',value}]}});
  else obligations.push({...base,requiredConditions:{all:request.kind==='precondition'?[{ref:request.ref,op:'eq',value}]:[]},requiredEffects:request.kind==='effect'?[{ref:request.ref,op:'set',value}]:[]});
 }
 const coverage=preservationSources(payload).map(s=>({sourceId:s.id,disposition:used.has(s.id)?'enforced':'context-only',reason:used.has(s.id)?'Cited by scope-specific atomic requirements':'No additional atomic requirement established; fixed scope, routes and endings remain enforced. Omission requires independent policy review.'}));
 const preservation=compilePreservationPolicy({status:ambiguous||!used.size?'abstain':'ready',reason:ambiguous?'At least one atomic judgment is ambiguous':'Scope-specific atomic requirements; omitted author functions must pass policy review',obligations,routeObligations,choiceObligations:[],coverage},payload,scope);
 return {preservation,judgments};
}
