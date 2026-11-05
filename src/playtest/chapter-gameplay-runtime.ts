import type {ChapterGameplay, GameplaySignal} from '../chapter-gameplay.js';
import type {Guard} from '../symbolic-graph.js';
import {evaluateGuard, symbolicAtomKey, type SymbolicState} from './symbolic-engine.js';

export type GameplayReceipt = {signalId: string; resultingValues: SymbolicState};
export type GameplaySession = {
  activeEventId: string | null;
  state: SymbolicState;
  receipts: GameplayReceipt[];
  completedEvents: string[];
  lockedSymbols?:string[];
};
export type GameplayNotification = {type: 'event-started' | 'event-ended' | 'gameplay-received'; id: string};
export type GameplayResult = {ok: true; session: GameplaySession; notifications: GameplayNotification[]} | {ok: false; reason: string};

export function createGameplaySession(chapter: ChapterGameplay): GameplaySession {
  return {activeEventId: null, state: Object.freeze(Object.fromEntries(chapter.initialState.map(a => [symbolicAtomKey(a.ref), typeof a.value === 'number' ? Math.round(a.value * 100) : a.value]))), receipts: [], completedEvents: []};
}
function conditionSatisfied(state: SymbolicState, condition: Guard): boolean {
  try {return evaluateGuard(state, condition);} catch {return false;}
}
export function gameplayEnding(chapter: ChapterGameplay, session: GameplaySession): string | undefined {
  const event = chapter.events.find(e => e.id === session.activeEventId);
  if (!event?.endingId) return undefined;
  const matches = chapter.endings.filter(e => conditionSatisfied(session.state, e.condition));
  return matches.length === 1 && matches[0].endingId === event.endingId ? event.endingId : undefined;
}
export function startEventBlocker(chapter: ChapterGameplay, session: GameplaySession, targetId: string): string | undefined {
  const target = chapter.events.find(e => e.id === targetId);
  if (!target) return '등록되지 않은 사건입니다.';
  if (!session.activeEventId) {
    if (target.id !== chapter.startEventId) return '챕터의 첫 사건부터 시작해 주세요.';
  } else {
    const active = chapter.events.find(e => e.id === session.activeEventId);
    const exit = active?.exits.find(e => e.to === targetId);
    if (!exit) return '현재 사건에서 연결되지 않은 사건입니다.';
    const receipt = session.receipts.find(r => r.signalId === exit.requiredSignal);
    if (!receipt) return '연결된 게임플레이 완료 신호를 기다리고 있습니다.';
    if (!conditionSatisfied(session.state, exit.condition)) return '현재 상태가 다음 사건의 진입 조건을 만족하지 않습니다.';
    if (Object.entries(receipt.resultingValues).some(([key, value]) => session.state[key] !== value)) return '게임플레이 이후 상태가 달라져 진입 조건을 다시 충족해야 합니다.';
  }
  if (!conditionSatisfied(session.state, target.entryCondition)) return '사건 진입 조건을 만족하지 않습니다.';
  if(target.entryAlternatives&&!target.entryAlternatives.some(g=>conditionSatisfied(session.state,g)))return '사건 진입 조건을 만족하지 않습니다.';
  if (target.endingId) {
    const matches = chapter.endings.filter(e => conditionSatisfied(session.state, e.condition));
    if (matches.length !== 1 || matches[0].endingId !== target.endingId) return '결말 조건이 미충족이거나 다른 결말과 충돌합니다.';
  }
  return undefined;
}

/** Starting a scene NEVER applies effects. The current scene ends atomically only
 * after the connected target and current completion requirements are satisfied.
 */
export function requestEventStart(chapter: ChapterGameplay, session: GameplaySession, trigger: string): GameplayResult {
  const target = chapter.events.find(e => e.startTrigger === trigger);
  if (!target) return {ok: false, reason: '등록되지 않은 사건 시작 트리거입니다.'};
  const reason = startEventBlocker(chapter, session, target.id);
  if (reason) return {ok: false, reason};
  const previous = session.activeEventId;
  return {ok: true, session: {...session, activeEventId: target.id, receipts: [], completedEvents: previous ? [...session.completedEvents, previous] : session.completedEvents}, notifications: [...(previous ? [{type: 'event-ended' as const, id: previous}] : []), {type: 'event-started', id: target.id}]};
}

export function gameplaySignalBlocker(chapter: ChapterGameplay, session: GameplaySession, signalId: string): string | undefined {
  const active = chapter.events.find(e => e.id === session.activeEventId);
  const signal = active?.signals.find(s => s.id === signalId);
  if (!active) return '먼저 사건 시작 트리거를 보내 주세요.';
  if (!signal) return '현재 사건에서 허용되지 않은 게임플레이 신호입니다.';
  if (signal.oncePerVisit&&session.receipts.some(r => r.signalId === signalId)) return '이미 처리한 신호입니다.';
  if (!conditionSatisfied(session.state, signal.condition)) return '게임플레이 실행 조건을 만족하지 않습니다.';
  return undefined;
}
function applySignal(state: SymbolicState, signal: GameplaySignal): {state: SymbolicState; resultingValues: SymbolicState} {
  const next = {...state}, resultingValues: Record<string, boolean | number> = {};
  for (const effect of signal.effects) {
    const key = symbolicAtomKey(effect.ref), before = next[key];
    if (before === undefined || typeof before !== typeof effect.value) throw new Error('심볼 또는 상태 값의 형식이 올바르지 않습니다.');
    if (effect.op === 'add' && typeof before !== 'number') throw new Error('숫자 심볼에만 증감을 적용할 수 있습니다.');
    const value = typeof effect.value === 'number' ? Math.round(effect.value * 100) : effect.value;
    const after = effect.op === 'set' ? value : Math.max(0, Math.min(100, (before as number) + (value as number)));
    next[key] = after; resultingValues[key] = after;
  }
  return {state: Object.freeze(next), resultingValues: Object.freeze(resultingValues)};
}
/** Game integrations send the declared signal ID, never arbitrary state assignments. */
export function receiveGameplaySignal(chapter: ChapterGameplay, session: GameplaySession, signalId: string): GameplayResult {
  const reason = gameplaySignalBlocker(chapter, session, signalId);
  if (reason) return {ok: false, reason};
  const signal = chapter.events.find(e => e.id === session.activeEventId)!.signals.find(s => s.id === signalId)!;
  try {
    const applied = applySignal(session.state, signal);
    const locked=new Set(session.lockedSymbols??[]);
    for(const symbol of chapter.addedSymbols??[]){
      const key=symbolicAtomKey(symbol.ref);
      if(symbol.changeMode!=='irreversible'||session.state[key]===applied.state[key])continue;
      if(locked.has(key))return {ok:false,reason:'되돌림 불가 심볼은 한 번 변경한 뒤 다시 변경할 수 없습니다.'};
      locked.add(key);
    }
    const next = {...session, state: applied.state,...(locked.size?{lockedSymbols:[...locked]}:{}), receipts: [...session.receipts.filter(r=>r.signalId!==signalId), {signalId, resultingValues: applied.resultingValues}]};
    const exit = chapter.events.find(e => e.id === session.activeEventId)!.exits.find(e => e.requiredSignal === signalId);
    // Reject a signal atomically if its declared result cannot be entered. This
    // also prevents combining otherwise valid actions into an ambiguous ending.
    if (exit) {
      const blocked = startEventBlocker(chapter, next, exit.to);
      if (blocked) return {ok: false, reason: blocked};
    }
    return {ok: true, session: next, notifications: [{type: 'gameplay-received', id: signalId}]};
  } catch (error) {return {ok: false, reason: error instanceof Error ? error.message : '상태 변경에 실패했습니다.'};}
}

/** Replay a saved planned route using exactly the same two public commands. */
export function replayGameplayRoute(chapter: ChapterGameplay, keys: string[]): GameplaySession {
  let session = createGameplaySession(chapter);
  for (const key of keys) {
    if (session.activeEventId) {
      const exit = chapter.events.find(e => e.id === session.activeEventId)?.exits.find(e => e.to === key);
      if (!exit) throw new Error(`게임플레이 경로 연결 없음: ${session.activeEventId} → ${key}`);
      const action = receiveGameplaySignal(chapter, session, exit.requiredSignal);
      if (!action.ok) throw new Error(action.reason);
      session = action.session;
    }
    const event = chapter.events.find(e => e.id === key);
    const result = requestEventStart(chapter, session, event?.startTrigger ?? '');
    if (!result.ok) throw new Error(result.reason);
    session = result.session;
  }
  return session;
}
