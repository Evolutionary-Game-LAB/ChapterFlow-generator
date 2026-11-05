import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {StorySchema,type Story} from '../src/schema.js';
import {parseSymbolicStoryPayload} from '../src/symbolic-story-payload.js';
import {activeChapterApproval,parseChapterAuthoring,validateChapterBinding,type ChapterAuthoring} from '../src/chapter-authoring.js';
import {projectSymbolicStory} from '../src/symbolic-story-projection.js';
import {StatefulStorylinePlanSchema} from '../src/stateful-storyline-plan.js';
import type {ProgressSink} from '../src/generation-progress.js';
import {generateChapterRoute} from './chapter-route.js';
import {ensureNarrativeQuality,QualityGateError,type QualityTraceSink,type RouteReviewCache} from './automatic-quality.js';
import {prepareChapterContract} from './chapter-setup.js';
import {prepareChapterContext} from './chapter-context.js';
import {layoutChapter} from '../src/chapter-layout.js';
import {validateStatefulPlan,StatefulPlanError} from '../src/stateful-storyline.js';
import {assertEndingConditionsDistinguishable,prepareEndingConditions} from './chapter-ending.js';
import {postJsonSafe} from './safe-http.js';
import type {GenerateRequest} from './request-schema.js';
import {chooseChapterBranch,designChapter} from './chapter-design.js';
import {interpretInitialFact} from './chapter-initial-state.js';
import {refineChapterVocabulary,assertChapterSymbolCompatibility} from './chapter-symbol-design.js';
import {ChapterSetupError} from './chapter-setup-error.js';
import {diagnoseChapterSetup} from './chapter-setup-diagnosis.js';
import {explicitChapterEndings} from '../src/chapter-brief.js';
import {chooseChapterEnrichment,planChapterEnrichment,reviewChapterEnrichment,type EnrichmentReport} from './chapter-enrichment.js';
import {buildChapterGameplay} from '../src/chapter-gameplay-binding.js';
import {RESULT_BRANCH_POLICY} from '../src/chapter-result-branches.js';

import {BranchComplexitySchema} from '../src/chapter-complexity.js';
const Settings=z.object({mode:z.enum(['mock','openai-compatible']),endpoint:z.string().max(2048),model:z.string().min(1).max(200),apiKey:z.string().max(4096),temperature:z.number().min(0).max(2)}).strict();
export const ChapterRequestSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('create'),brief:z.string().trim().min(10).max(12000),branchComplexity:BranchComplexitySchema.default('medium'),settings:Settings}).strict(),
  z.object({operation:z.literal('branch'),story:StorySchema,fromKey:z.string().regex(/^beat_[a-z0-9_]+$/),endingId:z.string().min(1),instruction:z.string().trim().min(1).max(2000),settings:Settings}).strict(),
  z.object({operation:z.literal('complete'),story:StorySchema,settings:Settings}).strict(),
  z.object({operation:z.literal('enrich'),story:StorySchema,settings:Settings}).strict(),
]);

export type ChapterCheckpoint={story:Story;completedEndings:number;totalEndings:number};
export const chapterBudgetMs=(operation:'create'|'branch'|'complete'|'enrich')=>(operation==='branch'?12:operation==='enrich'?30:45)*60*1000;
/** Optional work must leave time to return the already validated chapter. */
export const chapterEnrichmentBudgetMs=(operation:'create'|'branch'|'complete'|'enrich',startedAt:number,now=Date.now())=>Math.max(0,Math.min(12*60*1000,chapterBudgetMs(operation)-(now-startedAt)-15_000));

export function assertChapterComplete(story:Story){
  if(!story.chapter||!story.symbolic)throw new Error('챕터 원본이 없습니다.');
  buildChapterGameplay(story.symbolic,story.gameplay,story.chapterEdits);
  validateChapterBinding(story.chapter,story.symbolic);
  const full=activeChapterApproval(story.chapter,story.chapter.contract.endings.map(e=>e.id));
  validateStatefulPlan(full.approval,full.outcomes,StatefulStorylinePlanSchema.parse(story.symbolic.plan),true);
}

export function assertChapterPreserved(before:Story,after:Story) {
  if(!before.symbolic||!after.symbolic)throw new Error('서사 원본이 없습니다.');
  const a=StatefulStorylinePlanSchema.parse(before.symbolic.plan),b=StatefulStorylinePlanSchema.parse(after.symbolic.plan);
  const same=(x:unknown,y:unknown)=>JSON.stringify(x)===JSON.stringify(y);
  const {endings:_oldEndings,...oldContract}=before.symbolic.approval.contract;
  const {endings:_newEndings,...newContract}=after.symbolic.approval.contract;
  if(!same(oldContract,newContract))throw new Error('기존 인물 또는 사실의 의미가 변경되었습니다.');
  if(!same(a.storylines,b.storylines.slice(0,a.storylines.length))||b.storylines.length!==a.storylines.length+1)throw new Error('기존 경로가 변경되어 갈래를 반영하지 않았습니다.');
  for(const beat of a.beats)if(!same(beat,b.beats.find(v=>v.key===beat.key)))throw new Error('기존 사건의 규칙이 변경되어 갈래를 반영하지 않았습니다.');
  for(const [key,raw] of Object.entries(before.symbolic.details.scenes)) {
    const old=raw as {summary:string;locationId:string;presentCharacters:string[]};
    const next=after.symbolic.details.scenes[key] as typeof old|undefined;
    if(!next||!same([old.summary,old.locationId,old.presentCharacters],[next.summary,next.locationId,next.presentCharacters]))throw new Error('기존 장면이 변경되어 갈래를 반영하지 않았습니다.');
  }
  if(!same(before.symbolic.outcomes.initialState,after.symbolic.outcomes.initialState))throw new Error('시작 상태가 변경되었습니다.');
  for(const ending of before.symbolic.outcomes.outcomes)if(!same(ending,after.symbolic.outcomes.outcomes.find(e=>e.endingId===ending.endingId)))throw new Error('기존 결말 조건이 변경되었습니다.');
  if(!same(before.chapterEdits,after.chapterEdits))throw new Error('사용자 편집 내용이 변경되었습니다.');
  const oldGameplay=buildChapterGameplay(before.symbolic,before.gameplay,before.chapterEdits);
  const newGameplay=buildChapterGameplay(after.symbolic,after.gameplay,after.chapterEdits);
  for(const event of oldGameplay?.events??[]){
    const next=newGameplay?.events.find(e=>e.id===event.id);
    if(!next||!same(event.entryCondition,next.entryCondition)||event.startTrigger!==next.startTrigger)throw new Error('기존 사건 시작 규칙이 변경되었습니다.');
    for(const signal of event.signals)if(!same(signal,next.signals.find(s=>s.id===signal.id)))throw new Error('기존 게임플레이 신호가 변경되었습니다.');
    for(const exit of event.exits)if(!same(exit,next.exits.find(e=>e.to===exit.to)))throw new Error('기존 사건 진입 연결이 변경되었습니다.');
  }
}

export function verifyPlannedChapterEndings(setup:ChapterAuthoring,plan:ReturnType<typeof StatefulStorylinePlanSchema.parse>){
  const full=activeChapterApproval(setup,setup.contract.endings.map(e=>e.id));
  return validateStatefulPlan(full.approval,full.outcomes,plan);
}

/** Put actionable obligations before bulky execution traces in a small model's retry. */
export function chapterRetryDiagnostic(error:unknown,setup:ChapterAuthoring){
  if(!(error instanceof StatefulPlanError))return String(error).slice(0,3000);
  const evidence=error.evidence as Record<string,unknown>;
  const obligations=evidence.allRouteObligations as {missingFinalFacts?:Array<{atom:string;current:unknown;required:unknown}>;blockedEvents?:unknown[]}|undefined;
  const missing=(evidence.missingFinalFacts??obligations?.missingFinalFacts) as Array<{atom:string;current:unknown;required:unknown}>|undefined;
  const competing=evidence.competingEndings as Array<{endingId:string;currentlySatisfiedFacts:Array<{atom:string;value:unknown}>}>|undefined;
  const required=evidence.requiredEnding as ChapterAuthoring['outcomes'][number]|undefined;
  if(competing?.length&&required){
    const fact=(atom:string,value:unknown)=>({atom,meaning:setup.contract.stateSymbols.find(s=>s.id===atom.split('(')[0])?.meaning??atom,value});
    // The old string truncation hid these conflicts behind thousands of
    // transition/state characters. Keep complete structured evidence instead.
    return JSON.stringify({code:error.code,target:{endingId:required.endingId,label:setup.contract.endings.find(e=>e.id===required.endingId)?.label,requiredFacts:required.condition.all.map(c=>fact(`${c.ref.symbol}(${c.ref.args.join(',')})`,c.value))},alsoSatisfied:competing.map(e=>({endingId:e.endingId,label:setup.contract.endings.find(v=>v.id===e.endingId)?.label,facts:e.currentlySatisfiedFacts.map(f=>fact(f.atom,f.value))})),missingFinalFacts:missing?.map(f=>({...fact(f.atom,f.required),current:f.current})),instruction:'The terminal state satisfies competing endings. Preserve every target requirement and the accepted prefix. Regenerate only the private route with concrete actions that realize the target without also realizing the competing ending. Do not erase completed history, force unrelated state changes, or change any ending condition. If the conflict already follows from the shared prefix, choose an earlier permitted branching point.'});
  }
  if(!missing?.length)return String(error).slice(0,3000);
  return JSON.stringify({code:error.code,missingFinalFacts:missing.map(f=>({meaning:setup.contract.stateSymbols.find(s=>s.id===f.atom.split('(')[0])?.meaning??f.atom,current:f.current,required:f.required})),blockedEvents:obligations?.blockedEvents,instruction:evidence.instruction??obligations}).slice(0,3000);
}

async function prepare(request:GenerateRequest,transport:typeof postJsonSafe,progress:ProgressSink,signal:AbortSignal|undefined,record:QualityTraceSink,setupFeedback=''):Promise<ChapterAuthoring> {
  const sourceBrief=request.brief!;
  explicitChapterEndings(sourceBrief); // Reject an invalid explicit list before making model calls.
  progress({stage:'seed',message:'개요의 빈 부분을 짧은 이야기 설정으로 보완 중'});
  const creativeContext=await prepareChapterContext(request,sourceBrief,transport,signal);
  request={...request,brief:creativeContext?sourceBrief+'\n\n자동 보완한 작가용 배경 설정 (플레이어가 이미 아는 사실이 아님):\n'+creativeContext:sourceBrief};
  let feedback=setupFeedback;
  for(let attempt=1;attempt<=2;attempt++){
    try{return await preparePrivateSetup({...request},sourceBrief,creativeContext,feedback,transport,progress,signal,record);}
    catch(error){
      signal?.throwIfAborted();
      if(!(error instanceof ChapterSetupError))throw error;
      record({type:'chapter-setup-rejected',attempt,code:error.code,evidence:error.evidence});
      if(attempt===2)throw error;
      feedback=error.message;
      progress({stage:'retry',message:'시작 상태와 결말이 충돌한 심볼 설정을 다시 정리 중'});
    }
  }
  throw new Error('챕터 설정을 준비하지 못했습니다.');
}

async function preparePrivateSetup(request:GenerateRequest,sourceBrief:string,creativeContext:string|undefined,feedback:string,transport:typeof postJsonSafe,progress:ProgressSink,signal:AbortSignal|undefined,record:QualityTraceSink):Promise<ChapterAuthoring>{
  progress({stage:'seed',message:'인물과 이야기의 핵심 사실 정리 중'});
  const vocabulary=await prepareChapterContract({...request,brief:sourceBrief},transport,signal,(index,total)=>progress({stage:'seed',message:`결말 구분에 필요한 사실 확인 중 (${index}/${total})`}),feedback,message=>progress({stage:'seed',message}));
  const {contract,playerId,subjects,semantics:factSemantics,revisions}=await refineChapterVocabulary(request,vocabulary,sourceBrief,transport,signal,(index,total)=>progress({stage:'seed',message:`현재 상태와 완료 이력 구분 중 (${index}/${total})`}));
  record({type:'chapter-symbol-design',dictionaryRevisions:vocabulary.dictionaryRevisions,revisions,facts:subjects,semantics:factSemantics});
  progress({stage:'seed',message:'시작 상황과 가능한 결말 구성 중'});
  const initial:Record<string,boolean>={};
  const initialEvidence:NonNullable<ChapterAuthoring['initialEvidence']>={};
  for(const [index,fact] of subjects.entries()){
    progress({stage:'seed',message:`개요에 명시된 시작 상태 확인 중 (${index+1}/${subjects.length})`});
    const resolved=await interpretInitialFact(request,sourceBrief,fact.meaning,transport,signal,factSemantics[fact.symbol]);
    initial[fact.symbol]=resolved.value;
    initialEvidence[fact.symbol]={basis:resolved.basis,quote:resolved.quote,reason:resolved.reason};
  }
  const defaults=Object.values(initialEvidence).filter(e=>e.basis==='authored_default').map(e=>e.quote);
  if(defaults.length)request={...request,brief:request.brief+'\n\n비어 있던 현재 시작 상태의 기본 설정 (향후 행동이나 결말이 아님):\n'+defaults.join('\n')};
  const conditions:Record<string,Array<{fact:string;value:boolean}>>={};
  for(const [index,ending] of contract.endings.entries()){
    progress({stage:'seed',message:`결말별 진행 조건 정리 중 (${index+1}/${contract.endings.length})`});
    conditions[ending.id]=await prepareEndingConditions({...request,brief:sourceBrief,approvedContract:contract},ending.label,subjects,transport,signal,factSemantics);
  }
  assertEndingConditionsDistinguishable(contract.endings,conditions);
  const setup=parseChapterAuthoring({brief:request.brief,sourceBrief,creativeContext,contract,playerId,revision:randomUUID(),model:request.model,setupMode:'generated',factSemantics,initialEvidence,initialState:subjects.map(s=>({ref:{symbol:s.symbol,args:s.args},value:initial[s.symbol]})),outcomes:contract.endings.map(e=>({endingId:e.id,condition:{all:conditions[e.id]!.map(({fact:symbol,value})=>({ref:{symbol,args:subjects.find(s=>s.symbol===symbol)!.args},op:'eq',value}))}}))});
  assertChapterSymbolCompatibility(setup);
  return setup;
}

export async function generateChapter(raw:unknown,transport=postJsonSafe,progress:ProgressSink=()=>{},record:QualityTraceSink=()=>{},signal?:AbortSignal,onCheckpoint:(checkpoint:ChapterCheckpoint)=>void=()=>{}) {
  const startedAt=Date.now();
  const input=ChapterRequestSchema.parse(raw);
  let checkpointPublished=false,setupFeedback='';
  for(let attempt=0;attempt<2;attempt++){
    try{return await generateChapterAttempt(raw,transport,progress,record,signal,checkpoint=>{checkpointPublished=true;onCheckpoint(checkpoint);},startedAt,setupFeedback);}
    catch(error){
      signal?.throwIfAborted();
      if(!(error instanceof ChapterSetupError)||error.code!=='event-exposed-setup-conflict')throw error;
      record({type:'chapter-setup-rebuild-required',attempt:attempt+1,checkpointPublished,operation:input.operation,evidence:error.evidence});
      // Imported chapters and externally visible checkpoints retain their exact contracts.
      if(input.operation!=='create'||checkpointPublished||attempt===1)throw error;
      setupFeedback=error.message;
      progress({stage:'retry',message:'사건에서 확인된 상태 설계 오류를 심볼·초기값·결말 조건부터 다시 정리 중'});
    }
  }
  throw new Error('챕터 설계 복구를 완료하지 못했습니다.');
}

async function generateChapterAttempt(raw:unknown,transport:typeof postJsonSafe,progress:ProgressSink,record:QualityTraceSink,signal:AbortSignal|undefined,onCheckpoint:(checkpoint:ChapterCheckpoint)=>void,startedAt:number,setupFeedback:string) {
  const input=ChapterRequestSchema.parse(raw);
  signal?.throwIfAborted();
  if(input.settings.mode==='mock')throw new Error('챕터 생성에는 실제 모델 연결이 필요합니다. 기존 Mock 데모는 연구 도구에서 사용할 수 있습니다.');
  const baseline=input.operation==='create'?undefined:input.story;
  if(baseline){if(!baseline.chapter||!baseline.symbolic)throw new Error('생성한 챕터의 원본이 필요합니다.');parseSymbolicStoryPayload(baseline.symbolic);validateChapterBinding(baseline.chapter,baseline.symbolic);}
  const request:GenerateRequest={...input.settings,temperature:0,responseMode:'narrative-plan-outcomes',messages:[{role:'user',content:input.operation==='create'?input.brief:baseline!.chapter!.brief}],brief:input.operation==='create'?input.brief:baseline!.chapter!.brief};
  const setup=baseline?parseChapterAuthoring(baseline.chapter):await prepare(request,transport,progress,signal,record,setupFeedback);
  const previous=baseline?StatefulStorylinePlanSchema.parse(baseline.symbolic!.plan):undefined;
  if(input.operation==='branch'&&!previous!.beats.some(b=>b.key===input.fromKey))throw new Error('갈래를 추가할 사건이 없습니다.');
  const targets=input.operation==='enrich'?[]:input.operation==='branch'?[input.endingId]:setup.contract.endings.filter(e=>!previous?.storylines.some(l=>l.endingId===e.id)).map(e=>e.id);
  if(input.operation==='enrich')assertChapterComplete(baseline!);
  if(!targets.length&&input.operation!=='enrich')throw new Error('이미 모든 결말로 이어지는 경로가 있습니다. 사건을 선택해 새 갈래를 추가할 수 있습니다.');
  if(!targets.every(id=>setup.contract.endings.some(e=>e.id===id)))throw new Error('이야기에 없는 결말입니다.');
  if(input.operation!=='branch'&&input.operation!=='enrich'&&!setup.design){
    progress({stage:'seed',message:'모든 결말의 접근 방법과 공통 사건 설계 중'});
    setup.design=await designChapter(setup,request,transport,signal);
  }
  record({type:'chapter-setup',setup});
  const wrapped:typeof postJsonSafe=async(url,body,headers,callSignal)=>{
    signal?.throwIfAborted();
    return transport(url,body,headers,signal?AbortSignal.any([signal,...(callSignal?[callSignal]:[])]):callSignal);
  };
  let current=baseline;
  const reviewCache:RouteReviewCache=new Map();
  let lastQuality:Awaited<ReturnType<typeof ensureNarrativeQuality>>['quality']|undefined;
  const routeReports:Array<{endingId:string;attempts:number;fromKey?:string;reason?:string}>=[];
  for(const target of targets){
    const prior=current;
    const priorPlan=prior?StatefulStorylinePlanSchema.parse(prior.symbolic!.plan):undefined;
    const {approval,outcomes}=activeChapterApproval(setup,[...(priorPlan?.storylines.map(l=>l.endingId)??[]),target]);
    Object.assign(request,{brief:setup.brief,messages:[{role:'user',content:setup.brief}],approvedContract:approval.contract,playerId:setup.playerId,approvalRevision:setup.revision,approvedOutcomeInitialState:outcomes.initialState,approvedEndingOutcomes:outcomes.outcomes});
    const completed=new Set(priorPlan?.storylines.map(l=>l.endingId)).size;
    const total=setup.contract.endings.length;
    const routeProgress:ProgressSink=event=>progress({...event,message:`결말 ${Math.min(completed+1,total)}/${total} · ${event.message}`,chapter:{completed,total,endingLabel:setup.contract.endings.find(e=>e.id===target)!.label}});
    let recovery:unknown;
    for(let attempt=1;attempt<=2;attempt++) {
      signal?.throwIfAborted();
      let choice:Awaited<ReturnType<typeof chooseChapterBranch>>|undefined;
      record({type:'chapter-attempt',endingId:target,attempt});
      try {
        if(prior&&input.operation!=='branch'){
          routeProgress({stage:'expansion',message:'앞선 사건과 상태를 비교해 분기 위치 선택 중'});
          choice=await chooseChapterBranch(setup,prior,target,request,wrapped,signal,recovery);
          record({type:'chapter-branch-choice',endingId:target,attempt,...choice});
        }
        const branch=prior?{baseline:prior.symbolic!,fromKey:input.operation==='branch'?input.fromKey:choice!.fromKey,endingId:target,instruction:input.operation==='branch'?input.instruction:choice!.choice}:undefined;
        const result=await generateChapterRoute(request,wrapped,routeProgress,{singleRoute:!branch,branch,signal,setup,design:input.operation==='branch'?undefined:setup.design,segmentId:choice?.segment,coherenceTrace:record,factSemantics:setup.factSemantics},recovery);
        // Partial checkpoints still have to respect ALL planned outcome definitions.
        verifyPlannedChapterEndings(setup,result.plan);
        const payload={approval:{brief:setup.brief,contract:approval.contract,playerId:setup.playerId,revision:setup.revision},outcomes:{revision:setup.revision,initialState:[...outcomes.initialState],outcomes:[...outcomes.outcomes]},plan:result.plan,skeleton:result.skeleton,details:result.details};
        const {payload:accepted,quality}=await ensureNarrativeQuality(payload,request,wrapped,undefined,routeProgress,record,{strategy:'atomic-symbolic',reviewStrategy:'route-wise',reviewOnly:true,reviewCache,incrementalScope:{pendingEndings:setup.contract.endings.filter(e=>!approval.contract.endings.some(a=>a.id===e.id)).map(e=>e.label),branchInstruction:input.operation==='branch'?input.instruction:undefined,branchStorylineIndex:branch?result.plan.storylines.length-1:undefined}});
        signal?.throwIfAborted();
        const story=projectSymbolicStory({approval,outcomes,plan:accepted.plan,skeleton:accepted.skeleton,details:accepted.details});
        story.chapter=setup;
        if(prior?.chapterEdits)story.chapterEdits=structuredClone(prior.chapterEdits);
        story.gameplay=buildChapterGameplay(story.symbolic!,undefined,story.chapterEdits,prior?.gameplay?.branchPolicy);
        validateChapterBinding(setup,story.symbolic);
        if(prior){assertChapterPreserved(prior,story);story.storyId=prior.storyId;story.meta=prior.meta;}
        layoutChapter(story,prior,branch?.fromKey);
        current=story;lastQuality=quality;
        routeReports.push({endingId:target,attempts:attempt,fromKey:branch?.fromKey,reason:choice?.reason});
        record({type:'chapter-accepted',endingId:target,attempt,quality});
        break;
      } catch(error) {
        record({type:'chapter-attempt-failed',endingId:target,attempt,error:String(error)});
        if(error instanceof ChapterSetupError)throw error;
        if(signal?.aborted)throw error;
        const diagnostic=error instanceof QualityGateError?error.diagnostics as {verdict?:unknown;reason?:unknown;diagnostic?:unknown;contextId?:unknown}:undefined;
        if(error instanceof QualityGateError&&error.code==='quality-unresolved'){
          routeProgress({stage:'retry',message:'전체 경로 검토에서 드러난 심볼 설계 오류 여부 확인 중'});
          // A fallible whole-route verdict is only a lead. The diagnosis still
          // needs author evidence and a second scene-free check before rebuilding.
          await diagnoseChapterSetup(request,setup,target,'',JSON.stringify({stage:'whole_route_review',verdict:diagnostic?.verdict,reason:diagnostic?.reason}),transport,signal);
        }
        if(attempt===2)throw error;
        recovery={error:chapterRetryDiagnostic(error,setup),previousBranch:choice,diagnostics:diagnostic?{verdict:diagnostic.verdict,reason:diagnostic.reason,contextId:diagnostic.contextId,diagnostic:diagnostic.diagnostic}:undefined};
        routeProgress({stage:'retry',message:'검증된 경로를 보존하며 이번 결말의 경로만 다시 구성 중'});
      }
    }
    // A checkpoint is a recoverable draft, never a successful complete result.
    if(input.operation!=='branch'&&current){
      const built=new Set(StatefulStorylinePlanSchema.parse(current.symbolic!.plan).storylines.map(l=>l.endingId)).size;
      if(built<setup.contract.endings.length)onCheckpoint({story:current,completedEndings:built,totalEndings:setup.contract.endings.length});
    }
  }
  if(!current)throw new Error('챕터 생성을 완료하지 못했습니다.');
  if(input.operation!=='branch')assertChapterComplete(current);
  let enrichment:EnrichmentReport|undefined;
  if(input.operation!=='branch'){
    // A complete, playable baseline survives optional enrichment failure, cancellation
    // or a broken stream. The UI lets the author open this checkpoint directly.
    const checkpoint=()=>onCheckpoint({story:current!,completedEndings:setup.contract.endings.length,totalEndings:setup.contract.endings.length});
    checkpoint();
    enrichment={status:'unchanged',target:3,added:0,attempts:[]};
    const excluded=new Set<string>();let recovery:unknown;
    let retryChoice:Awaited<ReturnType<typeof chooseChapterEnrichment>>=undefined;
    const enrichmentBudget=chapterEnrichmentBudgetMs(input.operation,startedAt);
    record({type:'chapter-enrichment-budget',budgetMs:enrichmentBudget});
    const enrichmentSignal=AbortSignal.any([AbortSignal.timeout(enrichmentBudget),...(signal?[signal]:[])]);
    const enrichmentTransport:typeof postJsonSafe=(url,body,headers,callSignal)=>wrapped(url,body,headers,AbortSignal.any([enrichmentSignal,...(callSignal?[callSignal]:[])]));
    const {approval,outcomes}=activeChapterApproval(setup,setup.contract.endings.map(e=>e.id));
    Object.assign(request,{brief:setup.brief,messages:[{role:'user',content:setup.brief}],approvedContract:approval.contract,playerId:setup.playerId,approvalRevision:setup.revision,approvedOutcomeInitialState:outcomes.initialState,approvedEndingOutcomes:outcomes.outcomes});
    for(let attempt=0;enrichmentBudget>0&&attempt<6&&enrichment.added<enrichment.target;attempt++){
      signal?.throwIfAborted();
      let choice:Awaited<ReturnType<typeof chooseChapterEnrichment>>=undefined;
      const retrying:boolean=!!retryChoice;
      const prior=current;
      const enrichProgress:ProgressSink=event=>progress({...event,message:`중간 분기 보강 ${enrichment!.added+1}/${enrichment!.target} · ${event.message}`,chapter:{completed:setup.contract.endings.length,total:setup.contract.endings.length,endingLabel:'여러 접근 경로 구성'}});
      try{
        enrichmentSignal.throwIfAborted();
        enrichProgress({stage:'expansion',message:retrying?'이번 분기의 합류와 진행 조건 다시 구성 중':'다른 접근 방법을 넣을 사건 선택 중'});
        // A rejection belongs to its proposed passage. Feeding its instruction
        // into a different candidate makes a small model copy the old tactic
        // into an unrelated location, rather than plan from the new local goal.
        choice=retryChoice?await planChapterEnrichment(prior,request,retryChoice,wrapped,enrichmentSignal,recovery):await chooseChapterEnrichment(prior,request,excluded,wrapped,enrichmentSignal);
        if(!choice)break;
        record({type:'chapter-enrichment-choice',attempt:attempt+1,...choice});
        const branch={baseline:prior.symbolic!,fromKey:choice.selected.fromKey,endingId:choice.selected.sourceEndingId,instruction:choice.instruction};
        const result=await generateChapterRoute(request,wrapped,enrichProgress,{singleRoute:false,branch,signal:enrichmentSignal,setup,segmentId:choice.segment,coherenceTrace:record,factSemantics:setup.factSemantics,localBranch:{joinState:choice.selected.joinState,maxEvents:2,priorCommitments:choice.priorCommitments}},retrying?{error:(recovery as {error:string}).error}:undefined);
        verifyPlannedChapterEndings(setup,result.plan);
        const payload={approval:{brief:setup.brief,contract:approval.contract,playerId:setup.playerId,revision:setup.revision},outcomes:{revision:setup.revision,initialState:[...outcomes.initialState],outcomes:[...outcomes.outcomes]},plan:result.plan,skeleton:result.skeleton,details:result.details};
        const candidate=projectSymbolicStory({approval,outcomes,plan:result.plan,skeleton:result.skeleton,details:result.details});candidate.chapter=setup;
        if(current?.chapterEdits)candidate.chapterEdits=structuredClone(current.chapterEdits);
        candidate.gameplay=buildChapterGameplay(candidate.symbolic!,undefined,candidate.chapterEdits,prior.gameplay?.branchPolicy);
        const meaning=await reviewChapterEnrichment(prior,candidate,choice,request,wrapped,enrichmentSignal);
        // Includes every authored route and extra reachable state context after merging.
        const {quality}=await ensureNarrativeQuality(payload,request,enrichmentTransport,undefined,enrichProgress,record,{strategy:'atomic-symbolic',reviewStrategy:'route-wise',reviewOnly:true,reviewCache,incrementalScope:{pendingEndings:[],branchStorylineIndex:result.plan.storylines.length-1}});
        signal?.throwIfAborted();enrichmentSignal.throwIfAborted();
        assertChapterPreserved(prior,candidate);assertChapterComplete(candidate);
        candidate.storyId=prior.storyId;candidate.meta=prior.meta;layoutChapter(candidate,prior,branch.fromKey);
        current=candidate;lastQuality=quality;enrichment.added++;
        enrichment.attempts.push({segment:choice.segment,accepted:true,reason:meaning.reason});
        record({type:'chapter-enrichment-accepted',attempt:attempt+1,segment:choice.segment,kind:choice.kind,meaning});
        // Finish this pass across existing chapter regions before considering
        // branches inside the just-created detour on a later enrichment run.
        const oldKeys=new Set(StatefulStorylinePlanSchema.parse(prior.symbolic!.plan).beats.map(b=>b.key));
        for(const beat of result.plan.beats)if(!oldKeys.has(beat.key))excluded.add('anchor:'+beat.key);
        recovery=undefined;retryChoice=undefined;checkpoint();
      }catch(error){
        if(signal?.aborted)throw error;
        const diagnostic=error instanceof QualityGateError?error.diagnostics as {verdict?:unknown;reason?:unknown;contextId?:unknown}:undefined;
        const reason=(String(error)+(diagnostic?' '+JSON.stringify({verdict:diagnostic.verdict,reason:diagnostic.reason,contextId:diagnostic.contextId}):'')).slice(0,2000);
        enrichment.attempts.push({segment:choice?.segment,accepted:false,reason});
        record({type:'chapter-enrichment-rejected',attempt:attempt+1,segment:choice?.segment,error:reason});
        if(error instanceof ChapterSetupError){
          record({type:'chapter-setup-rebuild-required',checkpointPublished:true,operation:input.operation,evidence:error.evidence});
          break;
        }
        const localFailure=error instanceof StatefulPlanError||diagnostic?.contextId===`route:${StatefulStorylinePlanSchema.parse(prior.symbolic!.plan).storylines.length}`||reason.includes('분기 의미·합류 검토: inconsistent')||reason.includes('분기 합류 연속성: gap');
        retryChoice=choice&&!retrying&&localFailure?choice:undefined;
        if(choice&&!retryChoice){
          excluded.add(choice.segment);
          // Move the remaining budget to another ending family after an
          // unproductive proposal, instead of trying nearby variants repeatedly.
          excluded.add('ending:'+choice.selected.sourceEndingId);
        }
        recovery={error:reason,previousChoice:choice?{segment:choice.segment,instruction:choice.instruction}:undefined};
        enrichProgress({stage:'retry',message:retryChoice?'검사된 챕터를 보존하며 이번 분기만 한 번 보완 중':'검사된 챕터를 보존하고 다른 분기 후보 확인 중'});
        if(enrichmentSignal.aborted)break;
      }
    }
    enrichment.status=enrichment.added===enrichment.target?'enriched':enrichment.added?'partial':'unchanged';
    record({type:'chapter-enrichment-summary',...enrichment});
  }
  signal?.throwIfAborted();
  const completedEndings=new Set(StatefulStorylinePlanSchema.parse(current.symbolic!.plan).storylines.map(l=>l.endingId)).size;
  // A brand-new chapter has no user-placed nodes to preserve. Lay out all joins
  // together so detours do not accumulate long backwards edges in new results.
  if(input.operation==='create'){
    // Optional deterministic refinement runs only after a complete baseline exists.
    // A failed refinement must never turn a successful generation into a failure.
    try{
      current.gameplay=buildChapterGameplay(current.symbolic!,undefined,current.chapterEdits,RESULT_BRANCH_POLICY);
      record({type:'chapter-result-branches',policy:RESULT_BRANCH_POLICY});
    }catch(error){record({type:'chapter-result-branches-skipped',reason:String(error)});}
    layoutChapter(current);
  }
  return {story:current,quality:lastQuality??{status:'passed' as const},operation:input.operation,coverage:{completedEndings,totalEndings:setup.contract.endings.length},routeReports,enrichment};
}
