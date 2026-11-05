import type { AuthorContractApproval } from './author-contract.js';
import type { EndingOutcomeApproval } from './ending-outcomes.js';
import { parseNarrativeDetails, parseOutcomeBoundNarrativePlanDetails } from './narrative-details.js';
import { parseNarrativeSkeleton } from './narrative-skeleton.js';
import { parseSymbolicGraph } from './symbolic-graph.js';

const situationId = (key: string) => `s_${key}`;

export function compileSkeletonDetails(approval: AuthorContractApproval, skeletonRaw: unknown, detailsRaw: unknown) {
  const skeleton = parseNarrativeSkeleton(skeletonRaw, approval.contract);
  const details = parseNarrativeDetails(detailsRaw, approval, skeleton);
  const detailByKey = new Map(details.scenes.map((scene) => [scene.key, scene]));
  const linkIndexes = new Map<string, number>();
  return parseSymbolicGraph(approval, {
    version: '1',
    title: skeleton.title,
    startSituationId: situationId(skeleton.scenes[0]!.key),
    initialState: details.initialState,
    situations: skeleton.scenes.map((scene) => {
      const detail = detailByKey.get(scene.key)!;
      return { id: situationId(scene.key), title: scene.title, summary: detail.summary, locationId: detail.locationId, time: scene.key, presentCharacters: detail.presentCharacters, ...(detail.perspective ? {perspective: detail.perspective} : {}), precondition: detail.precondition, endingId: scene.endingId ?? null };
    }),
    transitions: skeleton.links.map((link) => {
      const detail = detailByKey.get(link.from)!;
      const action = 'actions' in detail ? detail.actions.find((item) => item.to === link.to)! : undefined;
      const linkIndex = (linkIndexes.get(link.from) ?? 0) + 1;
      linkIndexes.set(link.from, linkIndex);
      return { id: `t_${link.from}_${linkIndex}`, from: situationId(link.from), to: situationId(link.to), label: link.label, precondition: action!.precondition, effects: action!.effects };
    }),
    endingRules: skeleton.scenes.flatMap((scene) => {
      const detail = detailByKey.get(scene.key)!;
      return scene.endingId && 'terminal' in detail ? [{ endingId: scene.endingId, condition: detail.terminal.condition }] : [];
    }),
  });
}

export function compileOutcomeBoundPlanDetails(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, skeletonRaw: unknown, detailsRaw: unknown) {
  const skeleton = parseNarrativeSkeleton(skeletonRaw, approval.contract);
  return compileSkeletonDetails(approval, skeleton, parseOutcomeBoundNarrativePlanDetails(detailsRaw, approval, outcomes, skeleton));
}

export type CompiledSkeletonDetails = ReturnType<typeof compileSkeletonDetails>;
