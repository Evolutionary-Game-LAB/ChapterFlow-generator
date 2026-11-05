import { z } from 'zod';
import { SymbolicStoryPayloadSchema } from './symbolic-story-payload.js';
import { ChapterAuthoringSchema } from './chapter-authoring.js';
import {ChapterGameplaySchema} from './chapter-gameplay.js';
import {ChapterEditsSchema} from './chapter-edits.js';

const Id = z.string().min(1).max(120);
const Text = z.string().max(10_000);
const MbtiSchema = z.enum([
  'ISTJ', 'ISFJ', 'INFJ', 'INTJ', 'ISTP', 'ISFP', 'INFP', 'INTP',
  'ESTP', 'ESFP', 'ENFP', 'ENTP', 'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ',
]);

const RelationshipSchema = z.object({
  target: Id,
  type: z.string().max(120),
  affinity: z.number().finite().min(-100).max(100),
  summary: Text,
}).strict();

export const PersonaSchema = z.object({
  id: z.string().regex(/^chr_/).max(120),
  displayName: z.string().min(1).max(200),
  mbti: MbtiSchema,
  personaSentences: z.array(z.string().min(1).max(2_000)).max(100),
  speechStyle: Text,
  goals: Text,
  spriteId: z.string().max(500).optional(),
  relationships: z.array(RelationshipSchema).max(200),
}).strict();

export const LocationSchema = z.object({
  id: z.string().regex(/^loc_/).max(120),
  name: z.string().min(1).max(200),
  backgroundImage: z.string().max(500),
  situation: z.string().min(1).max(5_000),
  timeOfDay: z.string().max(120),
  props: z.array(z.string().max(500)).max(200),
}).strict();

const VariableSchema = z.discriminatedUnion('type', [
  z.object({ name: z.string().min(1).max(120), type: z.literal('boolean'), default: z.boolean() }).strict(),
  z.object({ name: z.string().min(1).max(120), type: z.literal('number'), default: z.number().finite() }).strict(),
  z.object({ name: z.string().min(1).max(120), type: z.literal('string'), default: z.string().max(10_000) }).strict(),
]);

export const VariableNamespaceSchema = z.object({
  namespace: z.string().min(1).max(120),
  variables: z.array(VariableSchema).max(500),
}).strict();

export const ScriptedLineSchema = z.object({
  speakerId: z.string().regex(/^chr_/).max(120),
  content: Text,
  readyForChoice: z.boolean(),
  replyOptions: z.array(z.string().min(1).max(2_000)).max(6),
}).strict();

const GeneratedDialogueText = z.string().trim().min(1).max(10_000);
const PreGeneratedReplySchema = z.object({
  content: z.string().trim().min(1).max(2_000),
  reaction: GeneratedDialogueText,
}).strict();
const PreGeneratedTurnSchema = z.object({
  content: GeneratedDialogueText,
  replies: z.array(PreGeneratedReplySchema).length(3),
}).strict();
export const PreGeneratedFlowSchema = z.object({
  id: z.string().regex(/^flow_/).max(120),
  turns: z.array(PreGeneratedTurnSchema).min(1).max(10),
  closingLine: GeneratedDialogueText,
}).strict();
const PreGeneratedDialogueSchema = z.object({
  speakerId: z.string().regex(/^chr_/).max(120),
  turnCount: z.number().int().min(1).max(10),
  flowCount: z.number().int().min(1).max(5),
  activeFlowId: z.string().regex(/^flow_/).max(120),
  flows: z.array(PreGeneratedFlowSchema).min(1).max(5),
}).strict();

const ChoicePromptSchema = z.object({
  content: Text,
  speakerId: z.string().regex(/^chr_/).max(120).optional(),
}).strict();

export const StoryNodeSchema = z.object({
  id: z.string().regex(/^n_/).max(120),
  title: z.string().min(1).max(500),
  type: z.enum(['dialogue', 'choice', 'end']),
  locationId: z.string().regex(/^loc_/).max(120),
  presentCharacters: z.array(z.string().regex(/^chr_/).max(120)).max(200),
  sceneGoal: Text,
  directorNotes: Text,
  dialogueMode: z.enum(['scripted', 'live-generation', 'pre-generation']),
  playerInputMode: z.enum(['free-text', 'reply-options']),
  scriptedLines: z.array(ScriptedLineSchema).max(1_000),
  preGeneratedDialogue: PreGeneratedDialogueSchema.optional(),
  choicePrompt: ChoicePromptSchema.optional(),
  endingSummary: Text.optional(),
  endingKind: z.enum(['success', 'neutral', 'failure']).optional(),
  outcomeTags: z.array(z.string().min(1).max(200)).max(20).optional(),
  editor: z.object({
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    color: z.string().max(50),
  }).strict(),
}).strict();

export const StoryEdgeSchema = z.object({
  id: z.string().regex(/^e_/).max(120),
  from: z.string().regex(/^n_/).max(120),
  to: z.string().regex(/^n_/).max(120),
  choiceLabel: z.string().max(1_000).optional(),
  condition: z.string().max(2_000).optional(),
  effect: z.string().max(2_000).optional(),
}).strict();

const NarrativeContractSchema = z.object({
  targetNodeCount: z.number().int().min(4).max(12).optional(),
  requiredEndings: z.array(z.enum(['success', 'neutral', 'failure'])).max(3).optional(),
  requiredOutcomeTags: z.array(z.string().min(1).max(200)).max(20).optional(),
  forbiddenStates: z.array(z.object({
    id: z.string().min(1).max(120),
    expression: z.string().min(1).max(2_000),
    description: Text,
  }).strict()).max(50).optional(),
  criticalChoices: z.array(z.object({
    nodeId: z.string().regex(/^n_/).max(120),
    mustDifferOn: z.array(z.enum(['reachableEndings', 'outcomeTags', 'reachableNodes', 'relationshipValue'])).min(1).max(3),
  }).strict()).max(100).optional(),
}).strict();

export const StorySchema = z.object({
  schemaVersion: z.literal('0.6'),
  storyId: z.string().min(1).max(120),
  title: z.string().min(1).max(500),
  meta: z.object({
    author: z.string().max(500),
    createdAt: z.string().max(100),
    llmDefault: z.string().max(500),
  }).strict(),
  personas: z.array(PersonaSchema).max(500),
  locations: z.array(LocationSchema).min(1).max(500),
  variables: z.array(VariableNamespaceSchema).max(200),
  narrativeContract: NarrativeContractSchema.optional(),
  symbolic: SymbolicStoryPayloadSchema.optional(),
  chapter: ChapterAuthoringSchema.optional(),
  gameplay: ChapterGameplaySchema.optional(),
  chapterEdits: ChapterEditsSchema.optional(),
  graph: z.object({
    layout: z.enum(['vertical-v1', 'manual']).optional(),
    startNodeId: z.string().regex(/^n_/).max(120),
    nodes: z.array(StoryNodeSchema).min(1).max(1_000),
    edges: z.array(StoryEdgeSchema).max(5_000),
  }).strict(),
}).strict();

export type Story = z.infer<typeof StorySchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type VariableNamespace = z.infer<typeof VariableNamespaceSchema>;
export type StoryNode = z.infer<typeof StoryNodeSchema>;
export type StoryEdge = z.infer<typeof StoryEdgeSchema>;
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
