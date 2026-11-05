import {z} from 'zod';
import {ChapterDesignSchema,activeChapterApproval,type ChapterAuthoring} from '../src/chapter-authoring.js';
import type {Story} from '../src/schema.js';
import {StatefulStorylinePlanSchema} from '../src/stateful-storyline-plan.js';
import {statefulAnchorMenu,describeStatefulSegments} from '../src/stateful-storyline.js';
import {chapterJson} from './chapter-setup.js';
import type {GenerateRequest} from './request-schema.js';
import {postJsonSafe} from './safe-http.js';

/** Plan the differences between outcomes before writing the first route. No executable rules are invented here. */
export async function designChapter(setup:ChapterAuthoring,request:GenerateRequest,transport=postJsonSafe,signal?:AbortSignal){
  const sentence={type:'string',minLength:1,maxLength:500};
  const route={type:'object',additionalProperties:false,required:['approach','branchOpportunity','payoff'],properties:{approach:sentence,branchOpportunity:sentence,payoff:sentence}};
  const schema={type:'object',additionalProperties:false,required:['commonSituation','routes'],properties:{commonSituation:{type:'string',minLength:1,maxLength:700},routes:{type:'object',additionalProperties:false,required:setup.contract.endings.map(e=>e.id),properties:Object.fromEntries(setup.contract.endings.map(e=>[e.id,route]))}}};
  let problem:unknown;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const raw=await chapterJson(request,[{role:'system',content:'Design ONE branching chapter in Korean. Plan all supplied endings together before writing scenes. commonSituation is a shared opening conflict, before any irreversible discovery, commitment or ending. For each ending, approach describes a distinctive player strategy and its obstacle, branchOpportunity identifies the natural earlier decision where it can diverge, including a concrete allowed gameplay action and which supplied fact its immediate result changes. Prefer decisions with an observable result that can gate the next event; do not invent a new fact or rush a distant payoff. Shared preparation must leave those actions possible. payoff explains how actions earn that outcome and its cost. A failed objective still needs a causal consequence. Share useful preparation; let later decisions branch from earlier routes when plausible. Do not make unrelated stories, repeat the entire opening for each ending, or merely rename the last event. Preserve the same hidden truth, character motives, declared entities and author constraints across every route. Never invent a new ending or erase knowledge to reach a failure ending. All fields are short prose, not state assignments. This is an authoring plan, not events that already happened.'},{role:'user',content:JSON.stringify({brief:setup.brief,entities:setup.contract.entityLabels,facts:setup.contract.stateSymbols,endings:setup.contract.endings,endingConditions:setup.outcomes,previousProblem:problem})}],schema,transport,signal,2600);
      const design=ChapterDesignSchema.parse(raw);
      const ids=setup.contract.endings.map(e=>e.id);
      if(Object.keys(design.routes).length!==ids.length||ids.some(id=>!design.routes[id]))throw new Error('모든 결말의 접근 방법이 필요합니다.');
      return design;
    }catch(error){signal?.throwIfAborted();if(attempt===1)throw error;problem=String(error).slice(0,1000);}
  }
  throw new Error('챕터 설계를 완료하지 못했습니다.');
}

/** The model selects only a real, executable prefix; the writer receives its exact state and prose. */
export async function chooseChapterBranch(setup:ChapterAuthoring,story:Story,endingId:string,request:GenerateRequest,transport=postJsonSafe,signal?:AbortSignal,recovery?:unknown){
  const plan=StatefulStorylinePlanSchema.parse(story.symbolic!.plan);
  const {approval,outcomes}=activeChapterApproval(setup,[...plan.storylines.map(l=>l.endingId),endingId]);
  const menu=statefulAnchorMenu(approval,outcomes,plan,endingId);
  // A missing outcome gets its own resolution. Reusing a different ending's suffix can
  // replay discoveries whose prose assumes a state not encoded by that suffix's guards.
  // Manual branch editing still supports verified reconvergence.
  menu.segments=menu.segments.filter(s=>s.rejoinKey===null);
  if(!menu.segments.length)throw new Error('남은 결말로 이어질 분기 위치가 없습니다. 챕터 크기나 결말 조건을 확인해 주세요.');
  const segments=describeStatefulSegments(approval,outcomes,plan);
  const candidates=menu.segments.map(candidate=>{
    const segment=segments.find(s=>s.id===candidate.id)!;
    const steps=plan.storylines[segment.storylineIndex]!.steps.slice(0,segment.fromIndex+1);
    const anchor=steps.at(-1)!;
    const next=plan.storylines[segment.storylineIndex]!.steps[segment.fromIndex+1];
    return {...candidate,completedEvents:steps.map(s=>s.beatKey),completedThrough:{key:anchor.beatKey,prose:(story.symbolic!.details.scenes[anchor.beatKey] as {summary:string}).summary},existingNextEvent:next?{key:next.beatKey,prose:(story.symbolic!.details.scenes[next.beatKey] as {summary:string}).summary}:undefined,state:segment.stateAfterPrefix,suffix:segment.remainingSuffix.map(b=>b.key)};
  });
  const schema={type:'object',additionalProperties:false,required:['segment','choice','reason'],properties:{segment:{type:'string',enum:candidates.map(s=>s.id)},choice:{type:'string',minLength:1,maxLength:500},reason:{type:'string',minLength:1,maxLength:500}}};
  const result=z.object({segment:z.string(),choice:z.string().min(1).max(500),reason:z.string().min(1).max(500)}).strict().parse(await chapterJson(request,[{role:'system',content:'Choose a causal branching point for the missing ending, in Korean. Select exactly one allowed segment ID. The anchor event itself is completedThrough, NOT the event being replaced. existingNextEvent is the action the new choice replaces. If the alternative must avoid an action inside completedThrough, choose an earlier anchor. If the character changes tactics afterwards, keep the earlier attempt and explain the change of mind briefly. The completed prefix has ALREADY happened. A fact learned or a past action cannot be undone; choose a point BEFORE that discovery/action if the target ending requires it not to have happened. The new route should start with a meaningful alternative to the existing next action, using the current place, motive and preparations. Prefer sharing relevant preparation over restarting from arrival, but use arrival when the causal difference genuinely starts there. Do not choose late solely to minimize length. Rejoining a suffix means all its events still happen. choice describes the new player action and the distinctive route it begins. reason explains why this exact prefix can plausibly lead to the target. Consider the whole-chapter design and previous failed attempt. Never modify existing scenes or outcome definitions.'},{role:'user',content:JSON.stringify({brief:setup.brief,design:setup.design,target:setup.contract.endings.find(e=>e.id===endingId),requiredFinalFacts:setup.outcomes.find(o=>o.endingId===endingId),facts:setup.contract.stateSymbols,events:plan.beats.map(b=>({key:b.key,title:b.title,prose:(story.symbolic!.details.scenes[b.key] as {summary:string}).summary})),candidates,previousFailure:recovery})}],schema,transport,signal,850));
  const selected=candidates.find(s=>s.id===result.segment);
  if(!selected)throw new Error('모델이 존재하지 않는 분기 위치를 선택했습니다.');
  return {...result,fromKey:selected.fromKey};
}
