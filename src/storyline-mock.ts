import type { AuthorContractApproval } from './author-contract.js';
import { compileEndingOutcomeEffects, getEndingOutcome, type EndingOutcomeApproval } from './ending-outcomes.js';
import type { OutcomeBoundNarrativePlanDetails } from './narrative-details.js';
import { compileNarrativePlan } from './plan-skeleton-compiler.js';
import { StorylinePlanSchema } from './storyline-plan.js';

/** Deterministic offline fixture, not an LLM generation quality baseline. */
export function createStorylineMock(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval) {
  const routes = Array.from({ length: Math.max(2, approval.contract.endings.length) }, (_, index) => ({
    key: 'beat_route_' + (index + 1), ending: approval.contract.endings[index % approval.contract.endings.length]!,
  }));
  const plan = StorylinePlanSchema.parse({
    format: 'storylines-v1', title: approval.brief.slice(0, 200),
    beats: [
      { key: 'beat_opening', title: '행동 방침을 선택한다' },
      ...routes.map((route, index) => ({ key: route.key, title: route.ending.label + '을 향한 준비 ' + (index + 1) })),
      { key: 'beat_rejoin', title: '선택의 결과를 가지고 다시 만난다' },
    ],
    storylines: routes.map((route) => ({
      endingId: route.ending.id,
      steps: [
        { beatKey: 'beat_opening' },
        { beatKey: route.key },
        { beatKey: 'beat_rejoin' },
      ],
    })),
  });
  const skeleton = compileNarrativePlan(approval, plan);
  const details: OutcomeBoundNarrativePlanDetails = { format: 'stateful-v1', scenes: Object.fromEntries(skeleton.scenes.map((scene) => {
    const base = { summary: scene.title + ' (오프라인 테스트 장면)', locationId: approval.contract.entities.locations[0]!, presentCharacters: [approval.playerId], precondition: { all: [] } };
    return [scene.key, scene.endingId ? base : {
      ...base,
      actions: skeleton.links.filter((link) => link.from === scene.key).map((link) => {
        const route = routes.find((candidate) => candidate.key === link.to);
        const ending = skeleton.scenes.find((candidate) => candidate.key === link.to)?.endingId;
        return {
          to: link.to,
          precondition: ending ? getEndingOutcome(outcomes, ending).condition : { all: [] },
          effects: route ? compileEndingOutcomeEffects(getEndingOutcome(outcomes, route.ending.id)) : [],
        };
      }),
    }];
  })) };
  return { plan, skeleton, details };
}
