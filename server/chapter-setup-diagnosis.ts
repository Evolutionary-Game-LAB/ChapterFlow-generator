import {z} from 'zod';
import {chapterJson} from './chapter-setup.js';
import {ChapterSetupError} from './chapter-setup-error.js';
import type {ChapterAuthoring} from '../src/chapter-authoring.js';
import type {GenerateRequest} from './request-schema.js';
import {postJsonSafe} from './safe-http.js';

/** A bad event does not prove the design is bad. Rebuilding needs evidence in the
 * author source and a second check that does NOT see the candidate event.
 */
export async function diagnoseChapterSetup(request:GenerateRequest,setup:ChapterAuthoring,endingId:string,event:string,problem:string,transport=postJsonSafe,signal?:AbortSignal){
  const source=setup.sourceBrief??setup.brief;
  const facts=setup.contract.stateSymbols.map(f=>({id:f.id,meaning:f.meaning,bindings:setup.initialState.find(s=>s.ref.symbol===f.id)?.ref.args.map(id=>({id,label:setup.contract.entityLabels?.find(e=>e.id===id)?.label??id})),semantics:setup.factSemantics?.[f.id],initial:setup.initialState.find(s=>s.ref.symbol===f.id)?.value,initialEvidence:setup.initialEvidence?.[f.id]}));
  const ending=setup.contract.endings.find(e=>e.id===endingId)!;
  const requirements=setup.outcomes.find(e=>e.endingId===endingId)!.condition.all.map(c=>({fact:c.ref.symbol,value:c.value}));
  const ids=['',...facts.map(f=>f.id)];
  const shape={type:'object',additionalProperties:false,required:['setupIssue','fact','sourceQuote','reason'],properties:{setupIssue:{type:'string',enum:['none','fact_definition','initial_state','ending_condition']},fact:{type:'string',enum:ids},sourceQuote:{type:'string',maxLength:1000},reason:{type:'string',maxLength:500}}};
  const diagnosis=z.object({setupIssue:z.enum(['none','fact_definition','initial_state','ending_condition']),fact:z.string(),sourceQuote:z.string().max(1000),reason:z.string().max(500)}).strict().parse(await chapterJson(request,[
    {role:'system',content:'Decide whether an event interpretation problem reveals an ACTUAL defect in the fixed state design, before anyone rewrites prose. none: the author-supported setup is valid and the event or its interpretation needs correction, or evidence is insufficient. fact_definition: a proposition changes the author-specified actor/source/method/time, merges distinct meanings, or invents a completed failed episode from mere nonachievement. initial_state: the locked initial value contradicts what the author explicitly establishes BEFORE play. ending_condition: a required final literal contradicts or exceeds the requested ending. A poorly written candidate event is NOT authority for changing the setup. Do not demand an unmentioned optional fact, turn future options into initial truths, or change a valid initial value just to make an event executable. Cite an exact continuous passage from authorSource proving the design defect. With no such evidence return none. A missing action alone normally requires an event repair, not redesign. Use a short Korean reason.'},
    {role:'user',content:JSON.stringify({authorSource:source,facts,ending:ending.label,requirements,candidateEvent:event,problem})},
  ],shape,transport,signal,650));
  if(diagnosis.setupIssue==='none'||!ids.includes(diagnosis.fact)||!diagnosis.fact||!diagnosis.sourceQuote.trim()||!source.includes(diagnosis.sourceQuote))return;
  const fact=facts.find(f=>f.id===diagnosis.fact)!;
  const requirement=requirements.find(r=>r.fact===diagnosis.fact);
  if(diagnosis.setupIssue==='ending_condition'&&!requirement)return;
  // Do not leak the first reviewer's allegation (including its paraphrase of the
  // bad scene) into the independent check. Compare only the relevant design
  // field: a valid future obligation must not be confused with its initial false.
  const comparison=diagnosis.setupIssue==='ending_condition'
    ?{topic:'ending_condition',authorRequirement:ending.label,designedCondition:{proposition:fact.meaning,value:requirement!.value}}
    :diagnosis.setupIssue==='initial_state'
    ?{topic:'initial_state',authorSource:source,designedInitial:{proposition:fact.meaning,value:fact.initial,semantics:fact.semantics,evidence:fact.initialEvidence}}
    :{topic:'fact_definition',authorPassage:diagnosis.sourceQuote,designedVariable:{proposition:fact.meaning,bindings:fact.bindings}};
  const reviewShape={type:'object',additionalProperties:false,required:['sourceRelation','reason'],properties:{sourceRelation:{type:'string',enum:['agrees','contradicts','unspecified']},reason:{type:'string',maxLength:500}}};
  const review=z.object({sourceRelation:z.enum(['agrees','contradicts','unspecified']),reason:z.string().max(500)}).strict().parse(await chapterJson(request,[
    {role:'system',content:'저자가 요구한 내용과 설계된 변수/값 하나를 직접 비교하세요. agrees: 설계가 저자 요구와 맞음. contradicts: 설계 자체가 저자 요구의 반대이거나 주체/대상/출처/시점을 바꿈. unspecified: 저자 내용만으로 맞다/틀리다 확정 불가. ending_condition은 결말에서 요구하는 값만 비교합니다. 저자가 X 발생을 요구하고 설계도 X=true이면 agrees입니다. 아직 발생하지 않았다는 것은 최종 조건 오류가 아닙니다. initial_state만 플레이 시작 전의 성립 여부를 비교합니다. 미래 선택이나 결말을 초기 사실로 취급하지 마세요. 미발생 이력=false는 그 행동이 영원히 불가능하다는 뜻이 아닙니다. fact_definition은 변수의 의미와 연결 대상이 원문과 맞는지 비교합니다. 긍정 변수 이름은 현재 참이라고 주장하지 않으며 다른 시나리오에서 false일 수도 있습니다. 명시되지 않은 세부는 모순이라고 단정하지 마세요. 주어진 설계 밖의 장면을 상상하거나 보완하지 마세요. 이유는 한국어로 짧게 씁니다.'},
    {role:'user',content:JSON.stringify(comparison)},
  ],reviewShape,transport,signal,550));
  if(review.sourceRelation==='contradicts')throw new ChapterSetupError('event-exposed-setup-conflict',{...diagnosis,verifiedReason:review.reason,factDefinition:fact,ending:ending.label,instruction:'사건 문장을 이 잘못된 심볼/초기값/결말 조건에 끼워 맞추지 말고 공개 전 상태 설계 단계부터 다시 준비하세요.'});
}
