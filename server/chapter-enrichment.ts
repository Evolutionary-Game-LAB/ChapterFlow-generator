import {z} from 'zod';
import type {Story} from '../src/schema.js';
import {activeChapterApproval} from '../src/chapter-authoring.js';
import {StatefulStorylinePlanSchema} from '../src/stateful-storyline-plan.js';
import {describeStatefulSegments,statefulAnchorMenu,materializeStatefulPlan} from '../src/stateful-storyline.js';
import {verifySymbolicModel} from '../src/symbolic-verification.js';
import {chapterJson} from './chapter-setup.js';
import type {GenerateRequest} from './request-schema.js';
import {postJsonSafe} from './safe-http.js';
import {interpretEventFact} from './chapter-event.js';

export type EnrichmentReport={status:'enriched'|'partial'|'unchanged';target:number;added:number;attempts:Array<{segment?:string;accepted:boolean;reason:string}>};

/** Bounded, deterministic structural bias, not measured Detroit probabilities.
 * Prefer new decision points, short detours and routes not enriched yet. The
 * model still chooses whether a meaningful alternative fits the actual story.
 */
type CandidateLimits={maxChangedFacts:number;perEnding:number;allowBranchingSources?:boolean;maxOutgoing?:number};
export function enrichmentCandidates(story:Story,excluded:ReadonlySet<string>=new Set(),limits:CandidateLimits={maxChangedFacts:1,perEnding:2}){
  const setup=story.chapter!,plan=StatefulStorylinePlanSchema.parse(story.symbolic!.plan);
  const {approval,outcomes}=activeChapterApproval(setup,setup.contract.endings.map(e=>e.id));
  const verification=verifySymbolicModel(materializeStatefulPlan(approval,outcomes,plan).model);
  if(verification.status!=='pass')throw new Error('검사된 챕터에서만 분기를 보강할 수 있습니다.');
  const entryStates=new Map<string,Set<string>>();
  for(const c of verification.configurations){
    if(!entryStates.has(c.situationId))entryStates.set(c.situationId,new Set());
    entryStates.get(c.situationId)!.add(JSON.stringify(Object.entries(c.state).sort(([a],[b])=>a.localeCompare(b))));
  }
  const segments=describeStatefulSegments(approval,outcomes,plan);
  const endings=[...new Set(plan.storylines.map(l=>l.endingId))];
  const allowed=new Set(endings.flatMap(id=>statefulAnchorMenu(approval,outcomes,plan,id).segments.filter(s=>s.rejoinKey).map(s=>id+':'+s.id)));
  const children=new Map<string,Set<string>>();
  for(const line of plan.storylines)for(let i=0;i<line.steps.length-1;i++){
    const from=line.steps[i]!.beatKey,to=line.steps[i+1]!.beatKey;
    if(!children.has(from))children.set(from,new Set());children.get(from)!.add(to);
  }
  const seen=new Set<string>();
  const ranked=segments.flatMap(s=>{
    if(!s.rejoinKey||(s.alreadyBranches&&!limits.allowBranchingSources)||(children.get(s.fromKey)?.size??0)>=(limits.maxOutgoing??Infinity)||excluded.has(s.id)||excluded.has('anchor:'+s.fromKey)||excluded.has('ending:'+s.sourceEndingId)||!allowed.has(s.sourceEndingId+':'+s.id))return [];
    // A small local writer gets one starting state. Do not silently select one
    // history of a shared node that is reachable in multiple different states.
    if(entryStates.get('s_'+s.fromKey)?.size!==1)return [];
    const line=plan.storylines[s.storylineIndex]!,span=s.rejoinIndex-s.fromIndex-1;
    if(span<1||span>3||line.steps.length-span+2>20||plan.beats.length+2>40||plan.storylines.length>=12)return [];
    // Do not bypass an existing decision. This makes each operation a local diamond
    // and keeps already accepted choices and their continuation available.
    const replaced=line.steps.slice(s.fromIndex+1,s.rejoinIndex);
    if(replaced.some(step=>(children.get(step.beatKey)?.size??0)>1))return [];
    const signature=JSON.stringify([s.fromKey,s.rejoinKey,s.stateAfterPrefix]);
    if(seen.has(signature))return [];seen.add(signature);
    const previous=segments.find(other=>other.storylineIndex===s.storylineIndex&&other.fromIndex===s.rejoinIndex-1);
    if(!previous)return [];
    const joinState=Object.fromEntries(previous.stateAfterPrefix.map(a=>[a.atom,a.value]));
    // One local objective per small-model request. Simultaneously replacing a
    // discovery, its information source and another consequence proved fragile.
    // Longer author-requested branches remain available through manual editing.
    if(s.stateAfterPrefix.filter(a=>a.value!==joinState[a.atom]).length>limits.maxChangedFacts)return [];
    const routeChoices=line.steps.filter(step=>(children.get(step.beatKey)?.size??0)>1).length;
    const sameEndingExtras=plan.storylines.filter(line=>line.endingId===s.sourceEndingId).length-1;
    const changesTrackedFact=replaced.some(step=>plan.beats.find(b=>b.key===step.beatKey)!.effects.length>0);
    return [{...s,replacedKeys:replaced.map(step=>step.beatKey),joinState,
      score:(s.fromIndex>0?8:0)+(span<=2?4:0)+(changesTrackedFact?6:0)-routeChoices*2-sameEndingExtras*6-s.storylineIndex*.1}];
  }).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  // Several suffix lengths from one anchor must not crowd all other decisions
  // out of the small model's menu. Offer distinct anchors and ending families.
  const menu:typeof ranked=[],anchors=new Set<string>(),perEnding=new Map<string,number>();
  for(const candidate of ranked){
    if(anchors.has(candidate.fromKey)||(perEnding.get(candidate.sourceEndingId)??0)>=limits.perEnding)continue;
    menu.push(candidate);anchors.add(candidate.fromKey);perEnding.set(candidate.sourceEndingId,(perEnding.get(candidate.sourceEndingId)??0)+1);
    if(menu.length===6)break;
  }
  return menu;
}

export async function chooseChapterEnrichment(story:Story,request:GenerateRequest,excluded:ReadonlySet<string>,transport=postJsonSafe,signal?:AbortSignal){
  const candidates=enrichmentCandidates(story,excluded);
  if(!candidates.length)return undefined;
  const plan=StatefulStorylinePlanSchema.parse(story.symbolic!.plan);
  const scene=(key:string)=>({title:plan.beats.find(b=>b.key===key)!.title,summary:(story.symbolic!.details.scenes[key] as {summary:string}).summary});
  // Choosing a location and inventing its alternative are separate bounded tasks.
  const schema={type:'object',additionalProperties:false,required:['segment','kind','reason'],properties:{segment:{type:'string',enum:['none',...candidates.map(c=>c.id)]},kind:{type:'string',enum:['alternative-approach','setback-recovery']},reason:{type:'string',minLength:1,maxLength:240}}};
  const answer=z.object({segment:z.string(),kind:z.enum(['alternative-approach','setback-recovery']),reason:z.string().min(1).max(240)}).strict().parse(await chapterJson(request,[{role:'system',content:'이야기에서 다른 접근 방법을 넣을 중간 구간 하나만 고르세요. 지금은 사건을 쓰지 않습니다. 각 후보는 replace를 다른 행동으로 대체한 뒤 continuation으로 합류합니다. 조사 방법, 설득 전략, 장애 극복 방법을 바꿀 여지가 있는 구간을 고르세요. 같은 행동의 표현만 바꾸는 구간은 피하세요. alternative-approach는 다른 수단, setback-recovery는 실패 뒤 다른 수단으로 회복입니다. 비슷하게 적절하면 rank가 높은 후보를 우선합니다. 적절한 후보가 전혀 없거나 작가가 선형 이야기를 명시했으면 none입니다. reason은 한국어 한 문장.'},{role:'user',content:JSON.stringify({brief:story.chapter!.brief,candidates:candidates.map(c=>({id:c.id,rank:c.score,justCompleted:scene(c.fromKey),replace:c.replacedKeys.map(k=>scene(k).title),continuation:scene(c.rejoinKey!),requiredStateBeforeContinuation:c.joinState}))})}],schema,transport,signal,400));
  if(answer.segment==='none')return undefined;
  const selected=candidates.find(c=>c.id===answer.segment);
  if(!selected)throw new Error('선택할 수 없는 보강 경로입니다.');
  return planChapterEnrichment(story,request,{selected,...answer},transport,signal);
}

type EnrichmentSelection={selected:ReturnType<typeof enrichmentCandidates>[number];segment:string;kind:'alternative-approach'|'setback-recovery';reason:string};
export async function planChapterEnrichment(story:Story,request:GenerateRequest,choice:EnrichmentSelection,transport=postJsonSafe,signal?:AbortSignal,feedback?:unknown){
  const {selected,...answer}=choice,plan=StatefulStorylinePlanSchema.parse(story.symbolic!.plan);
  const scene=(key:string)=>({title:plan.beats.find(b=>b.key===key)!.title,summary:(story.symbolic!.details.scenes[key] as {summary:string}).summary});
  const facts=story.chapter!.contract.stateSymbols.map(f=>{const atom=Object.keys(selected.joinState).find(a=>a.startsWith(f.id+'('))!;return {meaning:f.meaning??f.id,before:selected.stateAfterPrefix.find(a=>a.atom===atom)?.value,after:selected.joinState[atom]};});
  const commitmentsSchema={type:'object',additionalProperties:false,required:['priorCommitments'],properties:{priorCommitments:{type:'array',maxItems:3,items:{type:'string',minLength:1,maxLength:240}}}};
  const {priorCommitments}=z.object({priorCommitments:z.array(z.string().min(1).max(240)).max(3)}).strict().parse(await chapterJson(request,[{role:'system',content:'다음 사건의 문장에서 이미 일어났다고 전제하는 과거 사실만 최대 3개 추출하세요. 물건을 누구에게서 받았는지, 누구의 안내를 따랐는지처럼 문장에 명시된 출처·관계도 유지합니다. 예: "민수가 준 지도를 챙겨 떠난다"는 "민수가 플레이어에게 지도를 건넸다"를 전제합니다. 앞으로 이번 문장에서 실행할 행동, 추측한 감정이나 새로운 설정은 적지 마세요. 명시적 과거 전제가 없으면 빈 배열입니다. 한 항목에 간단한 긍정형 문장 하나씩 씁니다.'},{role:'user',content:JSON.stringify({nextEvent:scene(selected.rejoinKey!)})}],commitmentsSchema,transport,signal,450));
  const proposalSchema={type:'object',additionalProperties:false,required:['instruction'],properties:{instruction:{type:'string',minLength:10,maxLength:650}}};
  const proposal=z.object({instruction:z.string().min(10).max(650)}).strict().parse(await chapterJson(request,[{role:'system',content:'짧은 대체 구간의 행동을 한국어 2~3문장으로 기획하세요. 시작은 justCompleted 직후입니다. 반드시 localGoal.mustAchieve를 이번 구간에서 달성하고 keepTrue/keepFalse를 유지하세요. priorCommitments는 다음 사건이 이미 일어났다고 전제하는 사실이므로 바꾸면 안 됩니다. 같은 결과에 도달하되 originalApproach와 다른 설득 근거·조사 전략·장애 극복 수단을 쓰세요. 같은 기능의 새 물건을 이유 없이 다시 구하거나 이름만 바꾸는 것은 다른 전략이 아닙니다. 인물이 비밀 노출을 돕는다면 이유가 있어야 합니다. 이미 끝난 행동을 반복하거나 nextEvent를 미리 수행하지 마세요. repairReason이 있으면 그 오류를 먼저 해결하도록 이전 수단을 버리고 다시 기획하세요. 구체적인 행동과 결과만 쓰고 코드나 편집 명령은 쓰지 마세요.'},{role:'user',content:JSON.stringify({repairReason:(feedback as {error?:string}|undefined)?.error,priorCommitments,localGoal:{mustAchieve:facts.filter(f=>f.before!==f.after).map(f=>({fact:f.meaning,value:f.after})),keepTrue:facts.filter(f=>f.before===f.after&&f.after===true).map(f=>f.meaning),keepFalse:facts.filter(f=>f.before===f.after&&f.after===false).map(f=>f.meaning)},justCompleted:scene(selected.fromKey),originalApproach:selected.replacedKeys.map(scene),nextEvent:scene(selected.rejoinKey!)})}],proposalSchema,transport,signal,750));
  return {selected,...answer,...proposal,priorCommitments};
}

/** State equivalence alone cannot justify prose reconvergence or a meaningful choice. */
export async function reviewChapterEnrichment(before:Story,after:Story,selection:NonNullable<Awaited<ReturnType<typeof chooseChapterEnrichment>>>,request:GenerateRequest,transport=postJsonSafe,signal?:AbortSignal){
  const a=StatefulStorylinePlanSchema.parse(before.symbolic!.plan),b=StatefulStorylinePlanSchema.parse(after.symbolic!.plan);
  const text=(story:Story,key:string)=>({title:(story.symbolic!.plan as typeof a).beats.find(v=>v.key===key)!.title,prose:(story.symbolic!.details.scenes[key] as {summary:string}).summary});
  const added=b.beats.filter(beat=>!a.beats.some(old=>old.key===beat.key));
  // Derive the old continuation's ordinary physical requirements separately,
  // then inspect each for an explicit negation by the new passage. These are
  // counterfactual review assumptions, NEVER generated runtime state or effects.
  const needsSchema={type:'object',additionalProperties:false,required:['continuationNeeds'],properties:{continuationNeeds:{type:'array',maxItems:3,items:{type:'string',minLength:1,maxLength:240}}}};
  const needs=z.object({continuationNeeds:z.array(z.string().min(1).max(240)).max(3)}).strict().parse(await chapterJson(request,[{role:'system',content:'이어질 사건 1~2개를 실행하기 위한 기본적인 물리적 조건을 최대 3개만 적으세요. 하나의 긍정형 현재 상태 문장씩 씁니다. 글이나 시각적 증거를 확인하려면 볼 수 있는 밝기와 자료 접근이 필요하고, 대면 대화에는 상대와 대화 가능한 위치가 필요합니다. 실제로 이 행동을 막는 조건만 적고 인물의 감정·성공한 결말·이미 진실을 앎 등은 전제로 쓰지 마세요. 새로운 물건이나 이야기 규칙을 발명하지 마세요. 별도 물리적 전제가 없는 추상적 선택이면 빈 배열입니다. 한국어로 씁니다.'},{role:'user',content:JSON.stringify({continuation:selection.selected.remainingSuffix.slice(0,2).map(beat=>text(before,beat.key))})}],needsSchema,transport,signal,450));
  for(const need of needs.continuationNeeds){
    const decision=await interpretEventFact(request,need,true,added.map(beat=>text(after,beat.key).prose).join('\n'),transport,signal);
    if(decision.change==='false'||decision.change==='uncertain')throw new Error('분기 합류 연속성: gap · 뒤 사건의 전제 ['+need+']를 새 구간이 유지하지 못함: '+decision.reason);
  }
  const newApproach=added.map(beat=>text(after,beat.key));
  // Separate tactic novelty from reconvergence. A joint "meaningful" verdict
  // rejected different methods just because their required outcome was equal.
  const methodSchema={type:'object',additionalProperties:false,required:['method','reason'],properties:{method:{type:'string',enum:['different','same','uncertain']},reason:{type:'string',minLength:1,maxLength:350}}};
  const method=z.object({method:z.enum(['different','same','uncertain']),reason:z.string().min(1).max(350)}).strict().parse(await chapterJson(request,[{role:'system',content:'두 구간에서 플레이어가 사용하는 수단만 비교하세요. 같은 목표와 결과에 도달하도록 설계된 대체 경로입니다. 결과·결말이 같다는 이유로 same을 고르면 안 됩니다. 설득 근거, 증거 탐색 전략, 접근·장애 극복 수단이 구체적으로 바뀌면 different입니다. 기존 수단을 시도하다 실패해 실제로 다른 수단으로 전환하는 것도 different입니다. 같은 행동의 명칭·말투·감각 묘사만 바뀌거나, 의미 없는 대기·이동·심부름만 추가되면 same입니다. 뚜렷한 행동 차이를 확인할 수 없으면 uncertain입니다. 이유에는 두 수단의 구체적인 차이 또는 중복을 한국어 한 문장으로 적으세요.'},{role:'user',content:JSON.stringify({originalApproach:selection.selected.replacedKeys.map(k=>text(before,k)),newApproach})}],methodSchema,transport,signal,450));
  if(method.method!=='different')throw new Error('분기 의미·합류 검토: cosmetic · '+method.reason);
  const schema={type:'object',additionalProperties:false,required:['verdict','reason'],properties:{verdict:{type:'string',enum:['compatible','gap','uncertain']},reason:{type:'string',minLength:1,maxLength:350}}};
  const result=z.object({verdict:z.enum(['compatible','gap','uncertain']),reason:z.string().min(1).max(350)}).strict().parse(await chapterJson(request,[{role:'system',content:'prefix → newApproach → continuation 순서로 실제 실행했을 때 서술에 구체적인 모순이나 빠진 인과 과정이 있는지만 검사하세요. 인물의 명시된 동기와 반대되는 무근거 협조, 확정된 진실 변경, 앞에서 받지 않은 물건·약속을 받았다고 가정하는 뒤 사건, 같은 발견을 처음처럼 반복하는 경우는 gap입니다. 새 구간의 마지막 사건과 합류 뒤 첫 사건을 특히 살피세요. 조명·위치·접근이 달라졌다면 뒤 행동이 가능한지 확인하세요. 명시적 모순이 없으면 compatible, 문장이 불명확하면 uncertain입니다. 원래 경로와 같은 결과로 합류하는 것은 정상이며 차별성·분량·재미는 판단하지 마세요. 제공되지 않은 전제를 발명하지 마세요. reason은 구체적인 한국어 한 문장입니다.'},{role:'user',content:JSON.stringify({brief:before.chapter!.brief,prefix:a.storylines[selection.selected.storylineIndex]!.steps.slice(0,selection.selected.fromIndex+1).map(s=>text(before,s.beatKey)),newApproach,continuation:selection.selected.remainingSuffix.map(beat=>text(before,beat.key))})}],schema,transport,signal,500));
  if(result.verdict!=='compatible')throw new Error('분기 의미·합류 검토: inconsistent · '+result.reason);
  return {verdict:'meaningful' as const,reason:method.reason,continuity:result.reason};
}
