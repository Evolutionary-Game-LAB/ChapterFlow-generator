import type { AuthorContract, AuthorContractApproval } from '../author-contract.js';
import type { AtomRef, Effect, Guard, SymbolicGraphDraft, TransitionDraft } from '../symbolic-graph.js';

export type SymbolicValue = boolean | number;
export type SymbolicState = Readonly<Record<string, SymbolicValue>>;
export type SymbolicConfiguration = Readonly<{ situationId: string; state: SymbolicState }>;
export type SymbolicModel = Readonly<{ approval: AuthorContractApproval; draft: SymbolicGraphDraft }>;
export type TransitionResult =
  | Readonly<{ ok: true; configuration: SymbolicConfiguration; delta: Readonly<{ transitionId: string; changes: ReadonlyArray<{ key: string; before: SymbolicValue; after: SymbolicValue }> }> }>
  | Readonly<{ ok: false; reason: string }>;
export type TerminalResult = Readonly<{ status: 'nonterminal' }> | Readonly<{ status: 'ending'; endingId: string }> | Readonly<{ status: 'error'; reason: string }>;

export const symbolicAtomKey = (ref: AtomRef): string => JSON.stringify([ref.symbol, ...ref.args]);
const ticks = (value: number): number => Math.round(value * 100);
const freezeState = (state: Record<string, SymbolicValue>): SymbolicState => Object.freeze(state);

export function createSymbolicState(_contract: AuthorContract, draft: SymbolicGraphDraft): SymbolicState {
  return freezeState(Object.fromEntries(draft.initialState.map(({ ref, value }) => [symbolicAtomKey(ref), typeof value === 'number' ? ticks(value) : value])));
}

function requireAtom(state: SymbolicState, ref: AtomRef): SymbolicValue {
  const key = symbolicAtomKey(ref);
  if (!Object.hasOwn(state, key)) throw new Error(`missing atom: ${key}`);
  return state[key]!;
}

export function evaluateGuard(state: SymbolicState, guard: Guard): boolean {
  return guard.all.every(({ ref, op, value }) => {
    const actual = requireAtom(state, ref);
    if (typeof actual !== typeof value) throw new Error(`guard type mismatch: ${symbolicAtomKey(ref)}`);
    if (typeof actual === 'boolean') return op === 'eq' ? actual === value : op === 'ne' ? actual !== value : false;
    const expected = ticks(value as number);
    switch (op) {
      case 'eq': return actual === expected;
      case 'ne': return actual !== expected;
      case 'lt': return actual < expected;
      case 'lte': return actual <= expected;
      case 'gt': return actual > expected;
      case 'gte': return actual >= expected;
    }
  });
}

function applyEffect(next: Record<string, SymbolicValue>, effect: Effect): { key: string; before: SymbolicValue; after: SymbolicValue } {
  const key = symbolicAtomKey(effect.ref);
  if (!Object.hasOwn(next, key)) throw new Error(`missing atom: ${key}`);
  const before = next[key]!;
  let after: SymbolicValue;
  if (effect.op === 'set') {
    after = typeof effect.value === 'number' ? ticks(effect.value) : effect.value;
    if (typeof before !== typeof after) throw new Error(`effect type mismatch: ${key}`);
  } else {
    if (typeof before !== 'number' || typeof effect.value !== 'number') throw new Error(`invalid numeric effect: ${key}`);
    after = Math.max(0, Math.min(100, before + ticks(effect.value)));
  }
  next[key] = after;
  return { key, before, after };
}

export function tryTransition(model: SymbolicModel, configuration: SymbolicConfiguration, transitionId: string): TransitionResult {
  const source = model.draft.situations.find((situation) => situation.id === configuration.situationId);
  const transition = model.draft.transitions.find((candidate) => candidate.id === transitionId);
  if (!source) return { ok: false, reason: 'unknown current situation' };
  if (!transition || transition.from !== source.id) return { ok: false, reason: 'transition does not leave current situation' };
  if (!evaluateGuard(configuration.state, source.precondition)) return { ok: false, reason: 'current situation precondition is not satisfied' };
  if (!evaluateGuard(configuration.state, transition.precondition)) return { ok: false, reason: 'transition precondition is not satisfied' };
  const target = model.draft.situations.find((situation) => situation.id === transition.to);
  if (!target) return { ok: false, reason: 'unknown target situation' };
  const next = { ...configuration.state };
  let changes: Array<{ key: string; before: SymbolicValue; after: SymbolicValue }>;
  try {
    changes = transition.effects.map((effect) => applyEffect(next, effect));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'invalid effect' };
  }
  const nextState = freezeState(next);
  if (!evaluateGuard(nextState, target.precondition)) return { ok: false, reason: 'target situation precondition is not satisfied' };
  return { ok: true, configuration: { situationId: target.id, state: nextState }, delta: { transitionId, changes } };
}

export function getEnabledTransitions(model: SymbolicModel, configuration: SymbolicConfiguration): TransitionDraft[] {
  return model.draft.transitions.filter((transition) => tryTransition(model, configuration, transition.id).ok);
}

export function classifyTerminal(model: SymbolicModel, configuration: SymbolicConfiguration): TerminalResult {
  const situation = model.draft.situations.find((candidate) => candidate.id === configuration.situationId);
  if (!situation) return { status: 'error', reason: 'unknown current situation' };
  if (!situation.endingId) return { status: 'nonterminal' };
  const matches = model.draft.endingRules.filter((rule) => evaluateGuard(configuration.state, rule.condition));
  if (matches.length !== 1) return { status: 'error', reason: 'terminal must match exactly one ending rule' };
  if (matches[0]!.endingId !== situation.endingId) return { status: 'error', reason: 'terminal ending does not match the satisfied rule' };
  return { status: 'ending', endingId: situation.endingId };
}
