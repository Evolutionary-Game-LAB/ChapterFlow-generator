import {z} from 'zod';
import {chapterJson,chapterFactBudget, type compileChapterSetup} from './chapter-setup.js';
import {classifyChapterFact} from './chapter-semantics.js';
import {ChapterSetupError} from './chapter-setup-error.js';
import type {ChapterFactSemantics} from '../src/chapter-fact-semantics.js';
import type {ChapterAuthoring} from '../src/chapter-authoring.js';
import type {GenerateRequest} from './request-schema.js';
import {postJsonSafe} from './safe-http.js';

type Vocabulary=ReturnType<typeof compileChapterSetup>&{deferredOutcomes?:string[]};
const Representation=z.object({
  kind:z.enum(['positive_fact','episode_history']),
  sourceQuote:z.string().max(1200),reason:z.string().max(400),
}).strict();
const representationSchema={type:'object',additionalProperties:false,required:['kind','sourceQuote','reason'],properties:{
  kind:{type:'string',enum:['positive_fact','episode_history']},sourceQuote:{type:'string',maxLength:1200},reason:{type:'string',maxLength:400},
}};

/** Endings read facts; they must not manufacture a new gameplay action named after failure.
 * Keep an actual bounded failed attempt, but encode mere nonachievement as a positive
 * fact's false value. This happens before IDs, initial values or outcomes are published.
 */
export async function refineChapterVocabulary(request:GenerateRequest,vocabulary:Vocabulary,sourceBrief:string,transport=postJsonSafe,signal?:AbortSignal,onFact:(index:number,total:number)=>void=()=>{}) {
  const meanings=new Map<string,ChapterFactSemantics>();
  const classify=async(meaning:string)=>{
    if(!meanings.has(meaning))meanings.set(meaning,await classifyChapterFact(request,meaning,transport,signal));
    return meanings.get(meaning)!;
  };
  const subjects:Vocabulary['subjects']=[];
  const semantics:Record<string,ChapterFactSemantics>={};
  const revisions:Array<{before:string;after:string;reason:string}>=[];
  for(const [index,original] of vocabulary.subjects.entries()){
    onFact(index+1,vocabulary.subjects.length);
    let meaning=original.meaning,kind=await classify(meaning);
    if(kind.failureMode&&kind.failureMode!=='not_failure'){
      let feedback='';
      let accepted=false;
      for(let attempt=0;attempt<2;attempt++){
        const proposal=Representation.parse(await chapterJson(request,[
          {role:'system',content:'심볼 표현을 고르기 전에 한 가지만 판단하세요. originalFact의 실패가 원래 개요에서 실제 시도한 회차나 끝난 기회의 이력으로 명시됩니까? episode_history: 구체적 시도와 거절/실패, 또는 하려고 했던 기회의 종료가 원문에 있다. 성공해도 그 회차의 실패는 남아야 한다. positive_fact: 단순히 아직 성공하지 않았음, 특정 출처에서 정보를 얻지 않음, 다른 경로를 선택함. 이런 부재는 긍정 사실의 false로 표현하면 된다. 단지 못했다/실패라는 단어만으로 시도·거절·기한을 발명하지 마세요. episode_history이면 해당 시도와 종료를 sourceBrief에서 연속 인용하세요. positive_fact이면 sourceQuote는 빈 문자열. 문장을 다시 쓰거나 원문에서 성공 사례를 찾는 작업이 아닙니다.'},
          {role:'user',content:JSON.stringify({sourceBrief,originalFact:original.meaning,feedback})},
        ],representationSchema,transport,signal,450));
        if(proposal.kind==='episode_history'&&(!proposal.sourceQuote.trim()||!sourceBrief.includes(proposal.sourceQuote))){feedback='실제 실패 시도/끝난 기회를 원문에서 인용하지 못했습니다. 단순 미달성은 긍정 사실의 false로 표현하세요.';continue;}
        const candidate=proposal.kind==='episode_history'?(kind.failureMode==='goal_failure'?z.object({meaning:z.string().trim().min(1).max(300)}).strict().parse(await chapterJson(request,[
          {role:'system',content:'원문이 실제 실패한 회차 또는 끝난 기회를 명시했습니다. 전체 목표의 막연한 실패가 아니라 그 완료된 회차를 추적하는 심볼 하나를 쓰세요. 누가 어떤 시도/기회를 언제 무엇 때문에 끝냈는지 원문 인용에 있는 구별만 보존합니다. 나중에 다른 방식으로 성공해도 이 회차의 이력은 남습니다. 시도·거절·기한·새 원인을 발명하지 마세요. 현재 미완료나 단순히 다른 경로를 선택한 것을 실패 회차로 만들지 마세요. 한국어 완료 명제 하나만 씁니다.'},
          {role:'user',content:JSON.stringify({originalFact:original.meaning,sourceQuote:proposal.sourceQuote,sourceBrief,feedback})},
        ],{type:'object',additionalProperties:false,required:['meaning'],properties:{meaning:{type:'string',minLength:1,maxLength:300}}},transport,signal,300)).meaning:original.meaning):z.object({meaning:z.string().trim().min(1).max(300)}).strict().parse(await chapterJson(request,[
          {role:'system',content:'부정 명제를 같은 주체·대상·출처·방법·시점의 긍정 명제 하나로 바꾸세요. 예: "하린은 등대에 구조 신호를 보내지 못했다." → "하린은 등대에 구조 신호를 보냈다." 이는 심볼 이름이며 실제로 그 행동이 일어났다고 주장하는 작업이 아닙니다. 그 심볼의 값은 별도 단계에서 정합니다. meaning에는 긍정 문장만 쓰세요. false/아니오/논리 설명/부정문을 넣지 마세요. 이미 추적하는 동등한 긍정 문장이 있으면 그대로 복사하세요. 다른 출처·행위자의 성공으로 대체하지 마세요. 한국어로 짧게.'},
          {role:'user',content:JSON.stringify({originalFact:original.meaning,alreadyTracked:[...subjects.map(f=>f.meaning),...vocabulary.subjects.filter(f=>f.symbol!==original.symbol).map(f=>f.meaning)],feedback})},
        ],{type:'object',additionalProperties:false,required:['meaning'],properties:{meaning:{type:'string',minLength:1,maxLength:300}}},transport,signal,200)).meaning;
        const review=z.object({relation:z.enum(['equivalent_complement','explicit_episode','changed_meaning','unclear']),reason:z.string().max(300)}).strict().parse(await chapterJson(request,[
          {role:'system',content:'심볼과 값의 의미를 독립적으로 비교하세요. 원래 명제와 proposedEquivalent 전체(명제 AND value)의 의미를 비교합니다. value=false이면 긍정 명제가 성립하지 않는다는 뜻이며 긍정 사건이 발생했다고 주장하지 않습니다. equivalent_complement: 원래 단순 미달성과 긍정 명제=false가 같은 주체·대상·출처·방법·시점을 나타냄. explicit_episode: 원문이 실제 실패 시도/기회 종료를 명시하며 원래 이력을 그대로 보존함. changed_meaning: 출처/주체/시점이 달라짐, 실제 실패 회차를 단순 부재로 지움, 또는 의미가 바뀜. unclear: 판단 불가. 원래 명제는 가능한 한 결말의 조건이지 sourceBrief 전체를 요약하는 문장이 아닙니다. 개요에 성공과 실패 두 가능성이 있다는 이유로 올바른 심볼 표현을 거부하지 마세요.'},
          {role:'user',content:JSON.stringify({sourceBrief,originalFact:original.meaning,proposedEquivalent:{proposition:candidate,value:proposal.kind==='episode_history'},sourceQuote:proposal.sourceQuote})},
        ],{type:'object',additionalProperties:false,required:['relation','reason'],properties:{relation:{type:'string',enum:['equivalent_complement','explicit_episode','changed_meaning','unclear']},reason:{type:'string',maxLength:300}}},transport,signal,360));
        if(review.relation!==(proposal.kind==='positive_fact'?'equivalent_complement':'explicit_episode')){feedback=review.reason;continue;}
        const next=await classify(candidate);
        if(proposal.kind==='positive_fact'&&next.failureMode!=='not_failure'){feedback='긍정 사실로 바뀌지 않았습니다. 실패/미달성 결과 자체를 다시 심볼로 만들지 마세요.';continue;}
        if(proposal.kind==='episode_history'&&(next.scope!=='history'||!['failed_attempt','missed_opportunity'].includes(next.failureMode??''))){feedback='독립된 실패 회차를 표현하지 못했습니다. 전체 목표의 미달성은 긍정 사실의 false로 표현하세요.';continue;}
        meaning=candidate;kind=next;accepted=true;revisions.push({before:original.meaning,after:meaning,reason:review.reason});break;
      }
      if(!accepted)throw new ChapterSetupError('ambiguous-outcome-symbol',{fact:original.meaning,reason:feedback});
    }
    if(vocabulary.deferredOutcomes?.includes(original.meaning)){
      // A preliminary classifier may call a concrete failure an outcome label.
      // Defer that judgment, but never publish the unresolved label: after source
      // refinement the resulting variable must describe one observable fact.
      const forms=['concrete_fact','failed_episode','outcome_label','compound','unclear'] as const;
      const checked=z.object({predicateQuote:z.string().max(300),factForm:z.enum(forms),reason:z.string().max(300)}).strict().parse(await chapterJson(request,[
        {role:'system',content:'변수 이름의 핵심 술어를 predicateQuote에 그대로 인용하고 종류를 고르세요. concrete_fact: 구체적인 상태 또는 사건 하나(소지, 지식 획득, 사망, 생존/살아남음, 부상, 구조, 탈출 등). failed_episode: 특정 시도·기회가 실패하거나 달성되지 않았음. outcome_label: 무슨 상태나 행동인지 없이 성공/승리/좋은 결말이라고 평가만 함. compound: 여러 독립 사실을 묶음. unclear: 불명확. 생존 여부처럼 관찰 가능한 결과도 concrete_fact입니다. 이름 속 인물, 시제, 현재 참인지 여부는 분류 기준이 아닙니다. 아직 일어나지 않은 사건도 기록할 수 있는 변수입니다. predicateQuote는 입력에 있는 연속 문자열이어야 합니다.'},
        {role:'user',content:JSON.stringify({proposition:meaning})},
      ],{type:'object',additionalProperties:false,required:['predicateQuote','factForm','reason'],properties:{predicateQuote:{type:'string',maxLength:300},factForm:{type:'string',enum:forms},reason:{type:'string',maxLength:300}}},transport,signal,350));
      const verifiedEpisode=kind.scope==='history'&&['failed_attempt','missed_opportunity'].includes(kind.failureMode??'');
      const observable=checked.factForm==='concrete_fact'||checked.factForm==='failed_episode'&&verifiedEpisode;
      if(!observable||!checked.predicateQuote.trim()||!meaning.includes(checked.predicateQuote))throw new ChapterSetupError('unresolved-outcome-symbol',{fact:meaning,reason:checked.reason});
    }
    const duplicate=subjects.find(f=>f.meaning===meaning);
    if(duplicate){
      if(JSON.stringify(duplicate.args)!==JSON.stringify(original.args))throw new ChapterSetupError('symbol-subject-conflict',{meaning});
      continue;
    }
    const symbol=`fact_${subjects.length+1}`;
    subjects.push({...original,symbol,meaning});semantics[symbol]=kind;
  }
  if(subjects.length>chapterFactBudget(vocabulary.contract.endings.length))throw new ChapterSetupError('symbol-budget',{count:subjects.length});
  const contract={...vocabulary.contract,stateSymbols:subjects.map(f=>({id:f.symbol,meaning:f.meaning,type:'boolean' as const,parameterCount:1 as const}))};
  return {...vocabulary,contract,subjects,semantics,revisions};
}

/** Impossible monotone obligations are setup errors, not reasons to rewrite a scene. */
export function assertChapterSymbolCompatibility(setup:Pick<ChapterAuthoring,'contract'|'initialState'|'outcomes'|'factSemantics'>){
  for(const value of setup.initialState){
    if(value.value!==true||setup.factSemantics?.[value.ref.symbol]?.scope!=='history')continue;
    const endings=setup.outcomes.filter(e=>e.condition.all.some(c=>c.ref.symbol===value.ref.symbol&&JSON.stringify(c.ref.args)===JSON.stringify(value.ref.args)&&c.value===false));
    if(endings.length)throw new ChapterSetupError('initial-history-ending-conflict',{fact:setup.contract.stateSymbols.find(s=>s.id===value.ref.symbol)?.meaning,initial:true,endings:endings.map(e=>setup.contract.endings.find(x=>x.id===e.endingId)?.label),instruction:'이미 성립한 이력을 지워야 하는 결말 조건은 만들 수 없습니다. 현재 상태와 완료 이력, 초기 근거, 결말에 정말 필요한 조건을 다시 확인하세요.'});
  }
}
