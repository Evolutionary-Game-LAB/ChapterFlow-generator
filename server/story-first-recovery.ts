import {generateStoryFirst} from './story-first-generation.js';
import {chapterBudgetMs} from './chapter-generation-legacy.js';

/** Retry a rejected authoring design, never a transport/auth/programming error.
 * Every attempt uses the same complete validation pipeline and original input. */
export function isRecoverableStoryDesignFailure(error:unknown){
  if(!(error instanceof Error)||error.name==='AbortError'||error.name==='TimeoutError'||error instanceof TypeError||error instanceof RangeError)return false;
  return /이야기와 게임 규칙 불일치|진입 조건 복구|허용 플레이 조합 후 진행 불가|사건 시작 상태와 실제 행동 결과|행동 의미 불명확|blocked-storyline|결말 조건 설계 검증 실패|전체 이야기.*검증 실패|이야기 변환을 완료하지 못했습니다/.test(error.message);
}

export async function generateStoryFirstWithRecovery(...args:Parameters<typeof generateStoryFirst>){
  const [raw,transport,progress=()=>{},record=()=>{},externalSignal,onCheckpoint=()=>{}]=args;
  const startedAt=Date.now(),budget=chapterBudgetMs('create');
  const deadline=AbortSignal.timeout(budget),signal=externalSignal?AbortSignal.any([externalSignal,deadline]):deadline;
  let hasAcceptedCheckpoint=false;
  for(let attempt=0;attempt<2;attempt++){
    signal.throwIfAborted();
    try{
      return await generateStoryFirst(raw,transport,progress,record,signal,checkpoint=>{
        if(checkpoint.completedEndings===checkpoint.totalEndings)hasAcceptedCheckpoint=true;
        onCheckpoint(checkpoint);
      },startedAt);
    }catch(error){
      signal.throwIfAborted();
      // Do not discard a complete accepted graph, restart after cancellation,
      // or spend the last minutes on a new design that cannot finish in time.
      if(attempt||hasAcceptedCheckpoint||budget-(Date.now()-startedAt)<20*60_000||!isRecoverableStoryDesignFailure(error))throw error;
      record({type:'story-first-whole-design-retry',attempt:2,reason:String(error).slice(0,3500),policy:'Original brief, endings and complexity unchanged. Fresh manuscript/vocabulary/graph; all validators remain mandatory. At most one restart within the original request deadline.'});
      progress({stage:'seed',message:'이야기와 규칙의 충돌을 복구하기 위해 전체 설계를 한 번 다시 생성 중'});
    }
  }
  throw Error('이야기 설계 복구를 완료하지 못했습니다.');
}
