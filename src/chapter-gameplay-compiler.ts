import {compileChapterGameplay,ChapterGameplaySchema, type ChapterGameplay} from './chapter-gameplay.js';
import {type SymbolicStoryPayload} from './symbolic-story-payload.js';
import {compileOutcomeBoundPlanDetails} from './skeleton-detail-compiler.js';
import {approveAuthorContract} from './author-contract.js';
import {approveEndingOutcomes} from './ending-outcomes.js';
import {gameplayEnding, replayGameplayRoute} from './playtest/chapter-gameplay-runtime.js';
import {applyChapterEdits,type ChapterEdits} from './chapter-edits.js';
import {linkResultBranches,RESULT_BRANCH_POLICY,type AuthoredGameplayRoute} from './chapter-result-branches.js';

/** Publish-boundary adapter. Internal LLM plans, diagnostics and repair candidates
 * keep their original shape; integration rules are compiled only after validation.
 */
export function compileAuthoredChapterGameplay(payload: SymbolicStoryPayload, existing?: ChapterGameplay, edits?:ChapterEdits, policy?:ChapterGameplay['branchPolicy']): ChapterGameplay {
  const plan = payload.plan;
  if (!('format' in plan) || plan.format !== 'stateful-storylines-v2') throw new Error('게임플레이 신호는 챕터 형식에서 지원합니다.');
  const approval = approveAuthorContract(payload.approval.brief, payload.approval.contract, payload.approval.playerId, payload.approval.revision);
  const outcomes = approveEndingOutcomes(approval, payload.outcomes.revision, payload.outcomes.initialState, payload.outcomes.outcomes);
  let gameplay = compileChapterGameplay(compileOutcomeBoundPlanDetails(approval, outcomes, payload.skeleton, payload.details));
  if(payload.eventAuthoring){
    const actions=payload.eventAuthoring.actions;
    const keys=new Set<string>();
    for(const action of actions){
      const key=action.from+':'+action.to;
      if(keys.has(key))throw new Error('중복된 사건 행동 계약');
      keys.add(key);
      const source=gameplay.events.find(e=>e.id===action.from);
      const exit=source?.exits.find(e=>e.to===action.to);
      const signal=source?.signals.find(s=>s.id===exit?.requiredSignal);
      if(!signal||!exit)throw new Error('존재하지 않는 사건 행동 계약');
      if(action.mode==='result'&&!signal.effects.length)throw new Error('결과형 행동의 상태 변화 누락');
      signal.label=action.label;
      for(const c of action.when??[]){
        const matches=gameplay.initialState.filter(v=>v.ref.symbol===c.fact);
        if(matches.length!==1)throw new Error('플레이 시작 조건의 심볼이 없거나 모호합니다.');
        const clause={ref:matches[0]!.ref,op:'eq' as const,value:c.value};
        if(!signal.condition.all.some(v=>JSON.stringify(v)===JSON.stringify(clause)))signal.condition.all.push(clause);
      }
    }
    for(const source of gameplay.events)for(const exit of source.exits){
      if(source.id!=='start'&&!exit.to.startsWith('end_')&&!keys.has(source.id+':'+exit.to))throw new Error('사건 행동 계약 누락');
    }
    if(payload.eventAuthoring.terminalConfirmations){
      for(const source of gameplay.events)for(const exit of source.exits){
        const target=gameplay.events.find(e=>e.id===exit.to);
        const signal=source.signals.find(s=>s.id===exit.requiredSignal);
        if(target?.endingId&&signal&&!signal.effects.length)signal.label='결말 확인';
      }
    }
    // Make destination admission explicit as well as preserving edge-specific guards.
    for(const event of gameplay.events){
      const incoming=gameplay.events.flatMap(e=>e.exits.filter(x=>x.to===event.id));
      if(incoming.length)event.entryCondition={all:incoming[0]!.condition.all.filter(c=>incoming.every(x=>x.condition.all.some(v=>JSON.stringify(v)===JSON.stringify(c))))};
    }
    const seenEntries=new Set<string>();
    for(const entry of payload.eventAuthoring.entries??[]){
      const event=gameplay.events.find(e=>e.id===entry.eventId);
      if(!event||seenEntries.has(entry.eventId))throw new Error('존재하지 않거나 중복된 사건 진입 조건');
      seenEntries.add(entry.eventId);
      const clauses=entry.conditions.map(c=>{
        const matches=gameplay.initialState.filter(v=>v.ref.symbol===c.fact);
        if(matches.length!==1)throw new Error('사건 진입 조건의 심볼이 없거나 모호합니다.');
        return {ref:matches[0]!.ref,op:'eq' as const,value:c.value};
      });
      const merge=(all:typeof event.entryCondition.all)=>[...new Map(all.map(c=>[JSON.stringify(c),c])).values()];
      event.entryCondition={all:merge([...event.entryCondition.all,...clauses])};
      for(const source of gameplay.events)for(const exit of source.exits)if(exit.to===event.id){
        exit.condition={all:merge([...exit.condition.all,...clauses])};
        if(payload.eventAuthoring.guardUnchangedEntries){
          const play=source.signals.find(s=>s.id===exit.requiredSignal)!;
          // If this play cannot change a required fact, it must already hold.
          // Changed facts still gate the destination by their AFTER value.
          const unchanged=clauses.filter(c=>!play.effects.some(e=>JSON.stringify(e.ref)===JSON.stringify(c.ref)));
          play.condition={all:merge([...play.condition.all,...unchanged])};
        }
      }
    }
  }
  const routes:AuthoredGameplayRoute[]=plan.storylines.map(route=>({ids:[gameplay.startEventId,...route.steps.map(s=>s.beatKey),`end_${route.endingId}`],endingId:route.endingId}));
  const verify=(candidate:ChapterGameplay)=>{
    for(const route of routes){
      const session=replayGameplayRoute(candidate,route.ids);
      if(gameplayEnding(candidate,session)!==route.endingId)throw new Error('게임플레이 신호 경로가 요청한 결말에 도달하지 못합니다.');
    }
  };
  if(payload.eventAuthoring?.execution!=='source-owned-v1')verify(gameplay);
  // Old exports retain their exact rules. New chapters opt in after generation;
  // the version makes imports, the inspector and playtest reproduce the same rules.
  if((existing?.branchPolicy??policy)===RESULT_BRANCH_POLICY){
    gameplay=linkResultBranches(gameplay,routes,verify).chapter;
    gameplay.branchPolicy=RESULT_BRANCH_POLICY;
    gameplay=ChapterGameplaySchema.parse(gameplay);
  }
  const edited=applyChapterEdits(gameplay,edits);
  if(existing&&JSON.stringify(existing)!==JSON.stringify(edited))throw new Error('게임플레이 신호 규칙과 서사 원본·사용자 수정이 일치하지 않습니다.');
  return edited;
}
