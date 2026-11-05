import type { StatefulStorylinePlan } from './stateful-storyline-plan.js';
import type { StorylinePlan } from './storyline-plan.js';
import { classifyTerminal, createSymbolicState, tryTransition, type SymbolicModel } from './playtest/symbolic-engine.js';

/** Check authored routes as well as the union graph: guards must not silently hide a planned branch. */
export function verifyPlannedStorylines(model: SymbolicModel, plan: StorylinePlan | StatefulStorylinePlan) {
  for (const [index, line] of plan.storylines.entries()) {
    let configuration = { situationId: model.draft.startSituationId, state: createSymbolicState(model.approval.contract, model.draft) };
    const transitionIds: string[] = [];
    for (const target of [...line.steps.map((step) => 's_' + step.beatKey), 's_end_' + line.endingId]) {
      const transition = model.draft.transitions.find((edge) => edge.from === configuration.situationId && edge.to === target);
      const result = transition && tryTransition(model, configuration, transition.id);
      if (!result || !result.ok) return {
        code: 'blocked-storyline', message: 'Planned storyline ' + (index + 1) + ' cannot reach ' + target,
        witness: { storylineIndex: index, transitionIds, configuration, target, reason: result && !result.ok ? result.reason : 'missing transition' },
      };
      transitionIds.push(transition!.id);
      configuration = result.configuration;
    }
    const terminal = classifyTerminal(model, configuration);
    if (terminal.status !== 'ending' || terminal.endingId !== line.endingId) return {
      code: 'storyline-ending-mismatch', message: 'Planned storyline ' + (index + 1) + ' does not satisfy its approved ending',
      witness: { storylineIndex: index, transitionIds, configuration, terminal },
    };
  }
  return null;
}
