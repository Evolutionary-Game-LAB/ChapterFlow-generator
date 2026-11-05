import type { AtomRef } from './symbolic-graph.js';
import { classifyTerminal, createSymbolicState, getEnabledTransitions, symbolicAtomKey, tryTransition, type SymbolicConfiguration, type SymbolicModel, type SymbolicState, type SymbolicValue } from './playtest/symbolic-engine.js';

export type VerificationLimits = Readonly<{ maxConfigurations?: number; maxTransitions?: number; maxElapsedMs?: number }>;
export type Witness = Readonly<{ transitionIds: readonly string[]; configuration: SymbolicConfiguration }>;
export type SymbolicVerificationFinding = Readonly<{ code: 'dead-end' | 'terminal-error' | 'unreachable-ending' | 'trapped-cycle'; message: string; endingId?: string; witness?: Witness }>;
export type SymbolicVerificationReport = Readonly<{ status: 'pass' | 'fail' | 'inconclusive'; findings: readonly SymbolicVerificationFinding[]; reachedEndings: ReadonlySet<string>; exploredConfigurations: number; exploredTransitions: number; configurations: readonly SymbolicConfiguration[] }>;
export type ChoiceObligation = Readonly<{ id: string; situationId: string; transitionIds: readonly string[]; observeEndings: boolean; observeAtoms: readonly AtomRef[] }>;
export type ChoiceOptionOutcome = Readonly<{ transitionId: string; outcomes: ReadonlySet<string> }>;
export type ChoiceOutcome = Readonly<{ obligation: ChoiceObligation; configuration: SymbolicConfiguration; options: readonly ChoiceOptionOutcome[] }>;
export type ChoiceVerificationFinding = Readonly<{ code: 'untestable-choice' | 'nominal-choice'; message: string; obligation: ChoiceObligation; witness?: Witness }>;
export type ChoiceVerificationReport = Readonly<{ status: 'pass' | 'fail' | 'inconclusive'; findings: readonly ChoiceVerificationFinding[]; outcomes: readonly ChoiceOutcome[] }>;

type Node = { configuration: SymbolicConfiguration; key: string; parent?: string; transitionId?: string };
type Exploration = { report: SymbolicVerificationReport; nodes: Map<string, Node>; edges: Map<string, Set<string>>; terminals: Set<string> };

const defaults = { maxConfigurations: 50_000, maxTransitions: 250_000, maxElapsedMs: 5_000 };
const stateKey = (state: SymbolicState) => JSON.stringify(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)));
const configurationKey = (configuration: SymbolicConfiguration) => `${configuration.situationId}:${stateKey(configuration.state)}`;
const limitFor = (limits?: VerificationLimits) => ({ ...defaults, ...limits });
const initial = (model: SymbolicModel): SymbolicConfiguration => ({ situationId: model.draft.startSituationId, state: createSymbolicState(model.approval.contract, model.draft) });

function witness(nodes: Map<string, Node>, key: string): Witness {
  const ids: string[] = [];
  let node = nodes.get(key)!;
  while (node.parent) { ids.push(node.transitionId!); node = nodes.get(node.parent)!; }
  return { transitionIds: ids.reverse(), configuration: nodes.get(key)!.configuration };
}

function explore(model: SymbolicModel, limits?: VerificationLimits): Exploration {
  const budget = limitFor(limits);
  const started = Date.now();
  const root = initial(model);
  const rootKey = configurationKey(root);
  const nodes = new Map<string, Node>([[rootKey, { configuration: root, key: rootKey }]]);
  const edges = new Map<string, Set<string>>();
  const terminals = new Set<string>();
  const reachedEndings = new Set<string>();
  const findings: SymbolicVerificationFinding[] = [];
  const queue = [rootKey];
  let cursor = 0;
  let transitions = 0;
  let incomplete = false;
  const timedOut = () => Date.now() - started >= budget.maxElapsedMs;

  while (cursor < queue.length) {
    if (timedOut() || nodes.size > budget.maxConfigurations || transitions >= budget.maxTransitions) { incomplete = true; break; }
    const key = queue[cursor++]!;
    const configuration = nodes.get(key)!.configuration;
    const terminal = classifyTerminal(model, configuration);
    if (terminal.status === 'error') { findings.push({ code: 'terminal-error', message: terminal.reason, witness: witness(nodes, key) }); continue; }
    if (terminal.status === 'ending') { terminals.add(key); reachedEndings.add(terminal.endingId); continue; }
    const enabled = getEnabledTransitions(model, configuration);
    if (!enabled.length) { findings.push({ code: 'dead-end', message: 'nonterminal configuration has no enabled transition', witness: witness(nodes, key) }); continue; }
    for (const transition of enabled) {
      if (timedOut() || transitions >= budget.maxTransitions) { incomplete = true; break; }
      transitions++;
      const result = tryTransition(model, configuration, transition.id);
      if (!result.ok) continue;
      const nextKey = configurationKey(result.configuration);
      let successors = edges.get(key);
      if (!successors) edges.set(key, successors = new Set());
      successors.add(nextKey);
      if (!nodes.has(nextKey)) {
        if (nodes.size >= budget.maxConfigurations) { incomplete = true; break; }
        nodes.set(nextKey, { configuration: result.configuration, key: nextKey, parent: key, transitionId: transition.id });
        queue.push(nextKey);
      }
    }
    if (incomplete) break;
  }

  if (!incomplete) {
    for (const ending of model.approval.contract.endings) if (!reachedEndings.has(ending.id)) findings.push({ code: 'unreachable-ending', endingId: ending.id, message: `approved ending '${ending.id}' is unreachable` });
    const reverse = new Map<string, Set<string>>();
    for (const [from, tos] of edges) for (const to of tos) { let predecessors = reverse.get(to); if (!predecessors) reverse.set(to, predecessors = new Set()); predecessors.add(from); }
    const canReachTerminal = new Set(terminals);
    const backwards = [...terminals];
    for (let i = 0; i < backwards.length; i++) for (const predecessor of reverse.get(backwards[i]!) ?? []) if (!canReachTerminal.has(predecessor)) { canReachTerminal.add(predecessor); backwards.push(predecessor); }
    const hasCycle = (start: string): boolean => {
      const seen = new Set<string>();
      const queue = [...(edges.get(start) ?? [])];
      while (queue.length) {
        const current = queue.shift()!;
        if (current === start) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const successor of edges.get(current) ?? []) queue.push(successor);
      }
      return false;
    };
    const trapped = [...nodes.keys()].find((key) => !canReachTerminal.has(key) && hasCycle(key));
    if (trapped) findings.push({ code: 'trapped-cycle', message: 'cyclic configuration region cannot reach a terminal', witness: witness(nodes, trapped) });
  }
  const report: SymbolicVerificationReport = { status: incomplete ? 'inconclusive' : findings.length ? 'fail' : 'pass', findings, reachedEndings, exploredConfigurations: nodes.size, exploredTransitions: transitions, configurations: [...nodes.values()].map((node) => node.configuration) };
  return { report, nodes, edges, terminals };
}

export function verifySymbolicModel(model: SymbolicModel, limits?: VerificationLimits): SymbolicVerificationReport {
  return explore(model, limits).report;
}

const outcomeTuple = (endingId: string, state: SymbolicState, observeEndings: boolean, atoms: readonly AtomRef[]) => `${observeEndings ? endingId : ''}|${atoms.map((atom) => `${symbolicAtomKey(atom)}=${JSON.stringify(state[symbolicAtomKey(atom)] as SymbolicValue)}`).join('|')}`;
const equalSets = (left: ReadonlySet<string>, right: ReadonlySet<string>) => left.size === right.size && [...left].every((item) => right.has(item));

export function verifyChoiceObligations(model: SymbolicModel, obligations: readonly ChoiceObligation[], limits?: VerificationLimits): ChoiceVerificationReport {
  const full = explore(model, limits);
  if (full.report.status === 'inconclusive') return { status: 'inconclusive', findings: [], outcomes: [] };
  if (full.report.status === 'fail') return { status: 'fail', findings: [], outcomes: [] };
  const findings: ChoiceVerificationFinding[] = [];
  const outcomes: ChoiceOutcome[] = [];
  for (const obligation of obligations) {
    let comparable = false;
    for (const [key, node] of full.nodes) {
      if (node.configuration.situationId !== obligation.situationId) continue;
      const selected = getEnabledTransitions(model, node.configuration).filter((transition) => obligation.transitionIds.includes(transition.id));
      if (selected.length < 2) continue;
      comparable = true;
      const optionOutcomes: ChoiceOptionOutcome[] = [];
      for (const option of selected) {
        const step = tryTransition(model, node.configuration, option.id);
        if (!step.ok) continue;
        const branch = exploreFrom(model, step.configuration, limits);
        if (branch.incomplete) return { status: 'inconclusive', findings, outcomes };
        optionOutcomes.push({ transitionId: option.id, outcomes: branch.outcomes(obligation) });
      }
      outcomes.push({ obligation, configuration: node.configuration, options: optionOutcomes });
      const hasEqualPair = optionOutcomes.some((option, index) => optionOutcomes.slice(index + 1).some((other) => equalSets(option.outcomes, other.outcomes)));
      if (hasEqualPair) findings.push({ code: 'nominal-choice', message: `choice '${obligation.situationId}' has identical selected outcomes`, obligation, witness: witness(full.nodes, key) });
    }
    if (!comparable) findings.push({ code: 'untestable-choice', message: `choice '${obligation.situationId}' has fewer than two enabled selected options`, obligation });
  }
  return { status: findings.length ? 'fail' : 'pass', findings, outcomes };
}

function exploreFrom(model: SymbolicModel, root: SymbolicConfiguration, limits?: VerificationLimits): { incomplete: boolean; outcomes: (obligation: ChoiceObligation) => ReadonlySet<string> } {
  const budget = limitFor(limits); const started = Date.now(); const nodes = new Map<string, SymbolicConfiguration>(); const queue: SymbolicConfiguration[] = [root]; nodes.set(configurationKey(root), root); const terminals: Array<{ endingId: string; state: SymbolicState }> = []; let transitions = 0; let incomplete = false;
  for (let cursor = 0; cursor < queue.length && !incomplete; cursor++) {
    if (Date.now() - started >= budget.maxElapsedMs || nodes.size > budget.maxConfigurations || transitions >= budget.maxTransitions) { incomplete = true; break; }
    const configuration = queue[cursor]!; const terminal = classifyTerminal(model, configuration);
    if (terminal.status === 'ending') { terminals.push({ endingId: terminal.endingId, state: configuration.state }); continue; }
    if (terminal.status === 'error') continue;
    for (const transition of getEnabledTransitions(model, configuration)) {
      if (transitions++ >= budget.maxTransitions) { incomplete = true; break; }
      const result = tryTransition(model, configuration, transition.id); if (!result.ok) continue;
      const key = configurationKey(result.configuration); if (!nodes.has(key)) { if (nodes.size >= budget.maxConfigurations) { incomplete = true; break; } nodes.set(key, result.configuration); queue.push(result.configuration); }
    }
  }
  return { incomplete, outcomes: (obligation) => new Set(terminals.map((terminal) => outcomeTuple(terminal.endingId, terminal.state, obligation.observeEndings, obligation.observeAtoms))) };
}
