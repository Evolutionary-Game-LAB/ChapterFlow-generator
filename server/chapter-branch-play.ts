import {z} from 'zod';
import {chapterJson} from './chapter-setup.js';
import {postJsonSafe} from './safe-http.js';
import type {GenerateRequest} from './request-schema.js';
import type {ChapterFactSemantics} from '../src/chapter-fact-semantics.js';
import {interpretEventFact} from './chapter-event.js';

const Assignment=z.object({atom:z.string(),value:z.boolean()}).strict();
export const BranchPlayDraft=z.object({
  branchMode:z.enum(['result','choice']),
  play:z.string().trim().min(1).max(500),
  changes:z.array(Assignment).max(1),
  reason:z.string().trim().min(1).max(500),
}).strict();
export type BranchPlayDraft=z.infer<typeof BranchPlayDraft>;
export type BranchPlayContext={
  fromKey:string;
  completedPrefix:Array<{title:string;summary:string}>;
  instruction:string;
  facts:Array<{atom:string;meaning:string;before:boolean|number;semantics?:ChapterFactSemantics}>;
  siblings:Array<{title:string;summary:string;changes:Array<{atom:string;value:boolean|number}>}>;
  target:{label:string;required:Array<{atom:string;value:boolean|number}>};
  continuation?:Array<{title:string;summary:string}>;
  requiredBeforeContinuation?:Record<string,boolean|number>;
};
export type BranchPlayPlan=BranchPlayDraft & {
  // The model selects a real change, never a second, independent guard value.
  entryAfterPlay:Array<{atom:string;value:boolean}>;
};

export function branchPlayCandidates(context:BranchPlayContext){
  return context.facts.flatMap(fact=>{
    if(typeof fact.before!=='boolean')return [];
    const value=!fact.before;
    // Unknown reversibility is conservative. Never erase an acquired history.
    if(!value&&fact.semantics?.scope!=='current')return [];
    const required=context.target.required.find(c=>c.atom===fact.atom)?.value;
    const join=context.requiredBeforeContinuation?.[fact.atom];
    if(fact.semantics?.scope!=='current'&&((required!==undefined&&required!==value)||(join!==undefined&&join!==value)))return [];
    return [{atom:fact.atom,meaning:fact.meaning,before:fact.before,value,semantics:fact.semantics}];
  });
}

export function validateBranchPlayDraft(raw:unknown,context:BranchPlayContext):BranchPlayPlan{
  const draft=BranchPlayDraft.parse(raw),allowed=branchPlayCandidates(context);
  if(new Set(draft.changes.map(c=>c.atom)).size!==draft.changes.length)throw new Error('중복된 분기 심볼');
  if(draft.branchMode==='result'&&!draft.changes.length)throw new Error('결과형 분기에 실제 변화가 없습니다.');
  if(draft.branchMode==='choice'&&draft.changes.length)throw new Error('자유 선택 분기는 결과 변화를 강제하지 않습니다.');
  for(const change of draft.changes)if(!allowed.some(c=>c.atom===change.atom&&c.value===change.value))throw new Error('허용되지 않은 분기 상태 변화');
  return {...draft,entryAfterPlay:draft.changes.map(c=>({...c}))};
}

/** Bounded proposals and action grounding BEFORE prose. Executable effects still come exclusively
 * from the independent, mandatory event interpreters, never from this proposal.
 * Failure discards this optional plan; it does not bypass any route validation. */
export async function planBranchPlay(request:GenerateRequest,context:BranchPlayContext,transport=postJsonSafe,signal?:AbortSignal,trace?:(event:Record<string,unknown>)=>void):Promise<BranchPlayPlan|undefined>{
  const allowed=branchPlayCandidates(context);
  if(!allowed.length){trace?.({type:'chapter-branch-play-skipped',fromKey:context.fromKey,reason:'No reversible or unestablished existing fact is available.'});return;}
  const text={type:'string',minLength:1,maxLength:500};
  const schema={type:'object',additionalProperties:false,required:['branchMode','play','changes','reason'],properties:{
    branchMode:{type:'string',enum:['result','choice']},play:text,reason:text,
    changes:{type:'array',maxItems:1,items:{type:'object',additionalProperties:false,required:['atom','value'],properties:{atom:{type:'string',enum:allowed.map(c=>c.atom)},value:{type:'boolean'}}}},
  }};
  const started=Date.now();
  let previousProblem:unknown;
  for(let attempt=0;attempt<2;attempt++){
  try{
    const raw=await chapterJson(request,[{role:'system',content:
      'Plan ONE branch gameplay contract in Korean BEFORE writing its new route. The supplied prefix is already completed. While its LAST event is active, the developer can connect the proposed play to gameplay; its actual result changes existing symbols. The next event is entered with a SEPARATE start trigger after that result. Design the allowed play and resulting symbol value TOGETHER; the server derives the next event entry condition from that SAME value. Prefer branchMode=result with exactly ONE primary result from allowedChanges when a concrete immediate action can establish it. Read the exact meaning of the atom you select. Changes must be CAUSED AND COMPLETED in play itself: obtaining a document is NOT reading and understanding its contents; entering a room is NOT discovering its secret; refusing a person is NOT forgiving them. State the actual action AND its completed primary result explicitly in play. Write only the current gameplay, not a future scene or intention. Other incidental changes will be interpreted later; do not list every ending fact. Give a meaningful alternative to existing siblings. Ground play in the current location, resources and motives. Include necessary nearby access/preparation in the same short action if plausible. Do NOT jump straight to a distant payoff, teleport, reveal a secret without its actual source, or borrow an action from the unchanged continuation. Do not change facts already established, erase history, or invent symbols, decision flags or chapter-specific rules. The value false means false, not a failed attempt. If the only plausible next action has no tracked result, use branchMode=choice, changes=[] and explain why. Do not force a result merely to satisfy the format. Preserve all target and continuation requirements. These are PROPOSED actions, not evidence that anything has happened. Return JSON only.'
    },{role:'user',content:JSON.stringify({task:'joint-branch-play-v1',...context,allowedChanges:allowed,previousProblem})}],schema,transport,signal,1000);
    const plan=validateBranchPlayDraft(raw,context);
    // Check the action itself, excluding the proposed next scene as evidence.
    // Reuse the real interpreter (quotation, roles/method and history checks),
    // rather than ask the planner to affirm its own selected assignments.
    let rejected:unknown;
    for(const change of plan.changes){
      const fact=context.facts.find(f=>f.atom===change.atom)!;
      const completionSchema={type:'object',additionalProperties:false,required:['completion','quote','reason'],properties:{completion:{type:'string',enum:['completed','not_completed','unclear']},quote:{type:'string',maxLength:600},reason:{type:'string',maxLength:240}}};
      const completion=z.object({completion:z.enum(['completed','not_completed','unclear']),quote:z.string().max(600),reason:z.string().max(240)}).strict().parse(await chapterJson(request,[
        {role:'system',content:'제안된 게임플레이 문장과 결과 명제 하나를 비교합니다. proposedAfter 값이 행동 끝에 실제로 확정됩니까? completed는 그 결과를 명시적으로 완수한 경우뿐입니다. 준비, 의도, 접근, 시도, 물건 확보만 하고 본 목표를 수행하지 않은 것은 not_completed입니다. 자료를 확보하거나 단서를 발견했다고 그 내용의 진실까지 알았다고 볼 수 없습니다. 질문했다고 답을 들은 것이 아니며, 구조를 시도했다고 구조를 마친 것이 아닙니다. 이미 값이 성립한 상태의 단순 언급도 새로운 변화의 증거가 아닙니다. unclear는 원문이 모호할 때입니다. completed라면 결과가 완료된 정확한 원문 구절을 quote에 인용하세요. 개요나 미래 장면을 상상해서 채우지 마세요.'},
        {role:'user',content:JSON.stringify({fact:fact.meaning,before:fact.before,proposedAfter:change.value,play:plan.play})},
      ],completionSchema,transport,signal,330));
      if(completion.completion!=='completed'||!completion.quote.trim()||!plan.play.includes(completion.quote.trim())){
        rejected={plan,atom:change.atom,meaning:fact.meaning,verdict:completion,instruction:'The primary result is not completed in play. Plan an actually completed, causally plausible action or retain a free choice without this assignment.'};break;
      }
      const verdict=await interpretEventFact(request,fact.meaning,fact.before as boolean,plan.play,transport,signal,undefined,{
        previous:context.completedPrefix,following:context.continuation,startLocation:'현재 분기 지점',semantics:fact.semantics,
      });
      if(verdict.change!==String(change.value)||(verdict.needs!=='none'&&(verdict.needs==='true')!==fact.before)){
        rejected={plan,atom:change.atom,meaning:fact.meaning,verdict,instruction:'The selected change must be completed by play itself. Correct this ONE proposal using a plausible immediate action; otherwise choose choice with no changes. Do not borrow the next scene as evidence.'};break;
      }
    }
    if(rejected){
      trace?.({type:'chapter-branch-play-rejected',fromKey:context.fromKey,attempt,evidence:rejected});
      if(attempt===0){previousProblem=rejected;continue;}
      trace?.({type:'chapter-branch-play-fallback',fromKey:context.fromKey,elapsedMs:Date.now()-started,reason:'Both proposals failed independent action grounding.'});return;
    }
    trace?.({type:'chapter-branch-play-planned',fromKey:context.fromKey,attempt,elapsedMs:Date.now()-started,plan});
    return plan;
  }catch(error){
    signal?.throwIfAborted();
    trace?.({type:'chapter-branch-play-fallback',fromKey:context.fromKey,elapsedMs:Date.now()-started,reason:String(error).slice(0,1000)});
    return;
  }
  }
}

/** Reject ungrounded proposals, not independently validated story routes. */
export function assessBranchPlay(plan:BranchPlayPlan,changes:Array<{atom:string;value:boolean}>){
  const missing=plan.entryAfterPlay.filter(expected=>!changes.some(c=>c.atom===expected.atom&&c.value===expected.value));
  return {status:plan.branchMode==='choice'?'choice':missing.length?'unrealized':'verified',missing} as const;
}
