import { z } from 'zod';
import type { AuthorContract } from './author-contract.js';
import { StorylinePlanSchema, type StorylinePlan } from './storyline-plan.js';

const Text = z.string().min(1).max(200);
const Beat = z.object({ title: Text }).strict();
export const StorylineSeedSchema = z.object({ title: Text, beats: z.array(Beat).min(3).max(8) }).strict();
const beatJson = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 } } };
export const storylineSeedJsonSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'beats'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    beats: { type: 'array', minItems: 3, maxItems: 8, items: beatJson },
  },
};
export const storylineSeedPrompt = 'Write the first complete storyline as an ordered sequence of 3 to 8 intermediate events, excluding the ending itself. Return only {title,beats:[{title}]}. Use concrete player actions for titles, in the language of the brief. Build a causal progression toward the specified first approved ending; later alternatives will reuse some of these events. The first beat must be a neutral arrival or setup before acquiring outcome-relevant knowledge or resources. Do not introduce unapproved characters, items, or locations. The last beat must be a shared situation where different approaches can reconverge, before committing to an ending.';

export function createStorylineSeed(raw: unknown, contract: AuthorContract): StorylinePlan {
  const seed = StorylineSeedSchema.parse(raw);
  const beats = seed.beats.map((beat, index) => ({ key: 'beat_base_' + (index + 1), title: beat.title }));
  return { format: 'storylines-v1', title: seed.title, beats, storylines: [{ endingId: contract.endings[0]!.id, steps: beats.map((beat) => ({ beatKey: beat.key })) }] };
}

export function storylineSegments(plan: StorylinePlan) {
  const base = plan.storylines[0]!.steps;
  return base.flatMap((from, i) => base.slice(i + 2).map((to) => ({
    id: from.beatKey + '__' + to.beatKey, fromKey: from.beatKey, rejoinKey: to.beatKey,
  })));
}

export function storylineExpansionJsonSchemaFor(plan: StorylinePlan) {
  return {
    type: 'object', additionalProperties: false, required: ['segment', 'beats'], properties: {
      segment: { enum: storylineSegments(plan).map((segment) => segment.id) },
      beats: { type: 'array', minItems: 1, maxItems: 4, items: beatJson },
    },
  };
}

export const storylineExpansionPrompt = 'Add a GENEVA-inspired alternative to the existing storyline. Select one supplied segment (divergence and reconvergence anchors) and write 1 to 4 NEW intermediate events for a different approach. Return only {segment,beats:[{title}]}. The compiler preserves the existing prefix through the divergence anchor, inserts your new events, and rejoins at the selected anchor, preserving the remaining suffix. Your beats array is a PATCH INSERTION, NOT the complete new storyline. Never output the divergence anchor, reconvergence anchor, existing prefix, existing suffix, or any existing title. For example, if A -> B -> C is existing and the segment is A__C, output only NEW event D; never output A,D,C. Do not repeat the events that your new route replaces, or merely rename a previous approach. Keep the shared reconvergence compatible with both routes. Use distinct, concrete player-action titles in the language of the brief. Plan this route toward the specified approved ending, using only approved entities and state concepts. Do not output IDs, links, state assignments, or ending conditions.';

export function appendStoryline(plan: StorylinePlan, raw: unknown, endingId: string): StorylinePlan {
  const segments = storylineSegments(plan);
  const parsed = z.object({
    segment: z.enum(segments.map((segment) => segment.id) as [string, ...string[]]),
    beats: z.array(Beat).min(1).max(4),
  }).strict().parse(raw);
  const knownTitles = new Set(plan.beats.map((beat) => beat.title.trim().toLocaleLowerCase()));
  for (const beat of parsed.beats) {
    const title = beat.title.trim().toLocaleLowerCase();
    if (knownTitles.has(title)) throw new Error('Alternative events must not duplicate existing event titles');
    knownTitles.add(title);
  }
  const segment = segments.find((candidate) => candidate.id === parsed.segment)!;
  const base = plan.storylines[0]!.steps;
  const from = base.findIndex((step) => step.beatKey === segment.fromKey);
  const rejoin = base.findIndex((step) => step.beatKey === segment.rejoinKey);
  const additions = parsed.beats.map((beat, index) => ({ key: 'beat_alt_' + plan.storylines.length + '_' + (index + 1), title: beat.title }));
  return {
    ...plan, beats: [...plan.beats, ...additions],
    storylines: [...plan.storylines, { endingId, steps: [...base.slice(0, from + 1), ...additions.map((beat) => ({ beatKey: beat.key })), ...base.slice(rejoin)] }],
  };
}

export function finishStorylinePlan(plan: StorylinePlan): StorylinePlan {
  return StorylinePlanSchema.parse(plan);
}
