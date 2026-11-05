import type { AuthorContractApproval } from './author-contract.js';
import { parseNarrativeOutline, type NarrativeOutline } from './narrative-outline.js';
import { parseSymbolicGraph } from './symbolic-graph.js';

const situationId = (key: string) => `s_${key}`;

export function compileNarrativeOutline(approval: AuthorContractApproval, raw: unknown) {
  const outline = parseNarrativeOutline(raw);
  return parseSymbolicGraph(approval, {
    version: '1',
    title: outline.title,
    startSituationId: situationId(outline.scenes[0]!.key),
    initialState: outline.initialState,
    situations: outline.scenes.map((scene) => ({
      id: situationId(scene.key), title: scene.title, summary: scene.summary, locationId: scene.locationId,
      time: scene.key, presentCharacters: scene.presentCharacters, precondition: scene.precondition,
      endingId: 'terminal' in scene ? scene.terminal.endingId : null,
    })),
    transitions: outline.scenes.flatMap((scene) => 'actions' in scene ? scene.actions.map((action, index) => ({
      id: `t_${scene.key}_${index + 1}`, from: situationId(scene.key), to: situationId(action.to), label: action.label,
      precondition: action.precondition, effects: action.effects,
    })) : []),
    endingRules: outline.scenes.flatMap((scene) => 'terminal' in scene ? [{ endingId: scene.terminal.endingId, condition: scene.terminal.condition }] : []),
  });
}

export type CompiledNarrativeOutline = ReturnType<typeof compileNarrativeOutline>;
export type { NarrativeOutline };
