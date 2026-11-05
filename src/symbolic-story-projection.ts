import type { AuthorContractApproval } from './author-contract.js';
import type { EndingOutcomeApproval } from './ending-outcomes.js';
import { parseOutcomeBoundNarrativePlanDetails } from './narrative-details.js';
import { parseNarrativePlan, type NarrativePlan } from './narrative-plan.js';
import { parseNarrativeSkeleton, type NarrativeSkeleton } from './narrative-skeleton.js';
import { StorySchema, type Story } from './schema.js';
import { compileOutcomeBoundPlanDetails } from './skeleton-detail-compiler.js';
import { parseSymbolicStoryPayload, type SymbolicStoryPayload } from './symbolic-story-payload.js';
import { validateStoryReferences } from './validation.js';

export type SymbolicStoryProjectionInput = Readonly<{
  approval: AuthorContractApproval;
  outcomes: EndingOutcomeApproval;
  plan: NarrativePlan;
  skeleton: NarrativeSkeleton;
  details: unknown;
  eventAuthoring?:SymbolicStoryPayload['eventAuthoring'];
}>;

const displayName = (id: string) => id.replaceAll('_', ' ');
const characterId = (id: string) => `chr_${id}`;
const locationId = (id: string) => `loc_${id}`;
const nodeId = (key: string) => `n_${key}`;
const isPlanDetails = (raw: unknown): raw is { scenes: Record<string, unknown> } => Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && 'scenes' in raw && (raw as { scenes?: unknown }).scenes && typeof (raw as { scenes?: unknown }).scenes === 'object' && !Array.isArray((raw as { scenes: unknown }).scenes));

export function projectSymbolicStory(input: SymbolicStoryProjectionInput): Story {
  const plan = parseNarrativePlan(input.plan);
  const skeleton = parseNarrativeSkeleton(input.skeleton, input.approval.contract);
  const details = parseOutcomeBoundNarrativePlanDetails(input.details, input.approval, input.outcomes, skeleton);
  if (!isPlanDetails(input.details)) throw new Error('Outcome-bound Plan Details 오류 (root): scenes object is required');
  compileOutcomeBoundPlanDetails(input.approval, input.outcomes, skeleton, input.details);
  const detailByKey = new Map(details.scenes.map((scene) => [scene.key, scene]));
  const endingIndex = new Map(input.approval.contract.endings.map((ending, index) => [ending.id, index]));
  const edgeIndexes = new Map<string, number>();
  const symbolic: SymbolicStoryPayload = {
    approval: { brief: input.approval.brief, contract: input.approval.contract, playerId: input.approval.playerId, revision: input.approval.revision },
    outcomes: { revision: input.outcomes.revision, initialState: [...input.outcomes.initialState], outcomes: [...input.outcomes.outcomes] },
    plan,
    skeleton,
    details: input.details,
    ...(input.eventAuthoring?{eventAuthoring:input.eventAuthoring}:{}),
  };
  parseSymbolicStoryPayload(symbolic);

  const story = StorySchema.parse({
    schemaVersion: '0.6',
    storyId: `symbolic-${input.approval.revision}`,
    title: plan.title,
    meta: { author: 'symbolic-story-projection', createdAt: input.approval.revision, llmDefault: 'symbolic' },
    personas: input.approval.contract.entities.characters.map((id) => ({
      id: characterId(id), displayName: displayName(id), mbti: 'INFP' as const,
      personaSentences: ['A symbolic story character.'], speechStyle: 'Neutral.', goals: 'Participate in the story.', relationships: [],
    })),
    locations: input.approval.contract.entities.locations.map((id) => ({
      id: locationId(id), name: displayName(id), backgroundImage: '', situation: 'Symbolic story location.', timeOfDay: '', props: [],
    })),
    variables: [],
    symbolic,
    graph: {
      startNodeId: nodeId(skeleton.scenes[0]!.key),
      nodes: skeleton.scenes.map((scene, index) => {
        const detail = detailByKey.get(scene.key)!;
        const editor = { position: { x: 80 + (index % 3) * 310, y: 120 + Math.floor(index / 3) * 220 }, color: scene.endingId ? '#7bdcb5' : '#ffd166' };
        const base = { id: nodeId(scene.key), title: scene.title, locationId: locationId(detail.locationId), presentCharacters: detail.presentCharacters.map(characterId), sceneGoal: detail.summary, directorNotes: '', dialogueMode: 'scripted' as const, playerInputMode: 'reply-options' as const, scriptedLines: [], editor };
        if (!scene.endingId) return { ...base, type: 'choice' as const, choicePrompt: { content: detail.summary } };
        const position = endingIndex.get(scene.endingId)!;
        // ponytail: cosmetic kind cannot represent named symbolic endings; canonical payload is authoritative.
        const endingKind = position === 0 ? 'success' : position === input.approval.contract.endings.length - 1 ? 'failure' : 'neutral';
        return { ...base, type: 'end' as const, endingSummary: detail.summary, endingKind, outcomeTags: [scene.endingId] };
      }),
      edges: skeleton.links.map((link) => {
        const index = (edgeIndexes.get(link.from) ?? 0) + 1;
        edgeIndexes.set(link.from, index);
        return { id: `e_${link.from}_${index}`, from: nodeId(link.from), to: nodeId(link.to), choiceLabel: link.label };
      }),
    },
  });
  const errors = validateStoryReferences(story);
  if (errors.length) throw new Error(errors.join('\n'));
  return story;
}
