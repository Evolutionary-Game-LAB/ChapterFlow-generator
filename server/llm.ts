import { outcomeMeaningPrompt, parseOutcomeRationales, assertDistinctOutcomeRegions, type OutcomeRationale } from '../src/outcome-semantics.js';
export { generateStatefulPlanOutcomes as generatePlanOutcomes } from './stateful-generation.js';
import { randomUUID } from 'node:crypto';
import { approveAuthorContract, authorContractJsonSchema } from '../src/author-contract.js';
import { approveEndingOutcomes, type EndingOutcome } from '../src/ending-outcomes.js';
import { narrativeOutlineJsonSchemaForContract, parseNarrativeOutline, type NarrativeOutline } from '../src/narrative-outline.js';
import { compileNarrativeOutline } from '../src/outline-compiler.js';
import { compileSkeletonDetails } from '../src/skeleton-detail-compiler.js';
import { narrativeDetailsJsonSchemaFor, narrativePlanDetailsJsonSchemaFor, statefulOutcomeDetailsJsonSchemaFor, parseNarrativeDetails, parseNarrativePlanDetails, parseOutcomeBoundNarrativePlanDetailsResult, type NarrativeDetails, type OutcomeBoundNarrativePlanDetails } from '../src/narrative-details.js';
import { narrativeSkeletonJsonSchema, parseNarrativeSkeleton, type NarrativeSkeleton } from '../src/narrative-skeleton.js';
import { narrativePlanJsonSchema, parseNarrativePlan, type NarrativePlan } from '../src/narrative-plan.js';
import { storylineSeedPrompt, storylineSeedJsonSchema, createStorylineSeed, storylineSegments, storylineExpansionPrompt, storylineExpansionJsonSchemaFor, appendStoryline, finishStorylinePlan } from '../src/storyline-expansion.js';
import { verifyPlannedStorylines } from '../src/storyline-verification.js';
import { createStorylineMock } from '../src/storyline-mock.js';
import { compileNarrativePlan } from '../src/plan-skeleton-compiler.js';
import { verifySymbolicModel } from '../src/symbolic-verification.js';

import { parseSymbolicGraph, SymbolicGraphDraftSchema, symbolicGraphEnvelopeJsonSchema, symbolicGraphJsonSchema, type AtomValue, type SymbolicGraphDraft } from '../src/symbolic-graph.js';
import { z } from 'zod';
import { postJsonSafe } from './safe-http.js';
import type { GenerateRequest } from './request-schema.js';

type SafeTransport = typeof postJsonSafe;
export type GeneratedStoryGraph = { schemaVersion: string; graph: { startNodeId: string; nodes: unknown[]; edges: unknown[] }; [key: string]: unknown };

const mockContract = { entities: { characters: ['player', 'haeun'], items: ['magic_book'], locations: ['cafe'] }, stateSymbols: [{ id: 'has_magic_book', type: 'boolean', parameterCount: 1 }], relationshipSymbols: [{ id: 'affinity', type: 'number', parameterCount: 2, directed: true, range: [0, 1] }], endings: [{ id: 'together', label: '함께 걷는 밤' }, { id: 'parting', label: '각자의 길' }] };


const mockStoryGraph: GeneratedStoryGraph = {
  schemaVersion: '0.5', storyId: 'mock-ai-story', title: '비 오는 밤의 약속',
  meta: { author: 'AI NPC Prototype', createdAt: '2026-08-24', llmDefault: 'mock' },
  personas: [
    { id: 'chr_haeun', displayName: '하은', mbti: 'INFJ', personaSentences: ['비밀을 쉽게 말하지 않는다.'], speechStyle: '차분하고 조심스러운 말투', goals: '잃어버린 마법책을 찾고 싶다.', relationships: [{ target: 'chr_player', type: '낯선 조력자', affinity: 0, summary: '빗속에서 처음 만났다.' }] },
    { id: 'chr_player', displayName: '플레이어', mbti: 'INFP', personaSentences: ['낯선 부탁도 외면하지 못한다.'], speechStyle: '자연스러운 구어체', goals: '하은의 사정을 알고 싶다.', relationships: [] },
  ],
  locations: [{ id: 'loc_cafe', name: '골목 카페', backgroundImage: '', situation: '비가 내리는 밤, 카페의 불빛만 거리를 비춘다.', timeOfDay: '밤', props: ['우산', '마법책'] }],
  variables: [],
  narrativeContract: { requiredEndings: ['success'] },
  graph: {
    startNodeId: 'n_intro',
    nodes: [
      { id: 'n_intro', title: '뜻밖의 부탁', type: 'dialogue', locationId: 'loc_cafe', presentCharacters: ['chr_haeun', 'chr_player'], sceneGoal: '하은이 플레이어에게 도움을 청한다.', directorNotes: '', dialogueMode: 'live-generation', playerInputMode: 'free-text', scriptedLines: [], editor: { position: { x: 80, y: 120 }, color: '#8b9cf6' } },
      { id: 'n_choice', title: '어떤 도움을 줄까?', type: 'choice', locationId: 'loc_cafe', presentCharacters: ['chr_haeun', 'chr_player'], sceneGoal: '', directorNotes: '', dialogueMode: 'scripted', playerInputMode: 'reply-options', scriptedLines: [], choicePrompt: { content: '하은의 부탁에 어떻게 답할까?' }, editor: { position: { x: 380, y: 120 }, color: '#ffd166' } },
      { id: 'n_end', title: '함께 걷는 밤', type: 'end', locationId: 'loc_cafe', presentCharacters: ['chr_haeun', 'chr_player'], sceneGoal: '', directorNotes: '', dialogueMode: 'scripted', playerInputMode: 'reply-options', scriptedLines: [], endingSummary: '두 사람은 빗속으로 함께 걸어 나간다.', endingKind: 'success', outcomeTags: ['동행'], editor: { position: { x: 700, y: 120 }, color: '#7bdcb5' } },
    ],
    edges: [
      { id: 'e_intro', from: 'n_intro', to: 'n_choice' },
      { id: 'e_help', from: 'n_choice', to: 'n_end', choiceLabel: '마법책을 함께 찾는다.' },
      { id: 'e_listen', from: 'n_choice', to: 'n_end', choiceLabel: '먼저 사연을 들어 준다.' },
    ],
  },
};

const DialogueResultSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  readyForChoice: z.boolean(),
  replyOptions: z.array(z.string().trim().min(1).max(2_000)).max(6),
}).strict();

export type GenerateResult = z.infer<typeof DialogueResultSchema>;
export type GraphGenerationResponse = Readonly<{ draft: SymbolicGraphDraft; rawText: string; outputChannel: 'content' | 'thinking' | 'reasoning' | 'mock'; approvalRevision: string }>;
export type OutlineGenerationStage = 'provider' | 'selection' | 'json-parse' | 'outline-parse' | 'compile-grounding' | 'verifier' | 'skeleton-parse' | 'detail-parse' | 'plan-parse' | 'plan-provider' | 'plan-selection' | 'plan-verifier' | 'detail-provider' | 'detail-selection';
export type OutlineGenerationIssue = Readonly<{ stage: OutlineGenerationStage; code: string; path?: string }>;
export type OutlineGenerationDiagnostic = Readonly<{ correlationId: string; first: OutlineGenerationIssue | null; final: OutlineGenerationIssue | null; semanticGenerationAttempts: 1 | 2; repairUsed: boolean; transportCalls: number; schemaFallbackCalls: number; skeletonAttempts?: 1 | 2; planAttempts?: 1 | 2 | 3; planRepairUsed?: boolean }>;
export type NarrativeOutlineGenerationResponse = Readonly<{ outline: NarrativeOutline; rawText: string; outputChannel: 'content' | 'thinking' | 'reasoning' | 'mock'; approvalRevision: string; attempts: 1 | 2; telemetry?: OutlineGenerationDiagnostic }>;

export class OutlineGenerationError extends Error {
  constructor(readonly diagnostic: OutlineGenerationDiagnostic, readonly selectedJsonCandidate?: string, message = 'Narrative Outline generation failed', readonly acceptedPlanRawText?: string) {
    super(message);
  }
}

export function publicNarrativeOutlineError(error: OutlineGenerationError): Readonly<{ error: string; diagnostic: OutlineGenerationDiagnostic }> {
  return { error: 'Narrative Outline generation failed', diagnostic: error.diagnostic };
}

export function publicNarrativeSkeletonDetailsError(error: OutlineGenerationError): Readonly<{ error: string; diagnostic: OutlineGenerationDiagnostic }> {
  return { error: 'Narrative Skeleton/Details generation failed', diagnostic: error.diagnostic };
}

export function publicNarrativePlanDetailsError(error: OutlineGenerationError): Readonly<{ error: string; diagnostic: OutlineGenerationDiagnostic }> {
  return { error: 'Narrative Plan/Details generation failed', diagnostic: error.diagnostic };
}

export class ContractInsufficientError extends Error {
  readonly statusCode = 422;
}

export type EndingOutcomeProposalResponse = Readonly<{
  rationales?: OutcomeRationale[];
  initialState: readonly AtomValue[];
  outcomes: readonly EndingOutcome[];
  approvalRevision: string;
  rawText: string;
  outputChannel: 'content' | 'thinking' | 'reasoning' | 'mock';
}>;

export type EndingOutcomeProposalDiagnostic = Readonly<{
  stage: 'provider' | 'selection' | 'json-parse' | 'validation' | 'contract-insufficient';
  code: string;
  message?: string;
}>;

export class EndingOutcomeProposalError extends Error {
  constructor(message: string, readonly diagnostic: EndingOutcomeProposalDiagnostic) {
    super(message);
  }
}

export function publicEndingOutcomeProposalError(error: EndingOutcomeProposalError): Readonly<{ error: string; diagnostic: EndingOutcomeProposalDiagnostic }> {
  return { error: 'Ending Outcome proposal generation failed', diagnostic: error.diagnostic };
}

const endingOutcomeProposalJsonSchema = (contract: ReturnType<typeof approveAuthorContract>['contract']) => {
  const entities = [...contract.entities.characters, ...contract.entities.items, ...contract.entities.locations];
  const noMatch = { type: 'string', minLength: 1, maxLength: 0 } as const;
  const atomBranches = [...contract.stateSymbols, ...contract.relationshipSymbols].map((symbol) => ({
    type: 'object', additionalProperties: false, required: ['ref', 'value'],
    properties: {
      ref: { type: 'object', additionalProperties: false, required: ['symbol', 'args'], properties: { symbol: { const: symbol.id }, args: { type: 'array', items: entities.length ? { enum: entities } : noMatch, minItems: symbol.parameterCount, maxItems: symbol.parameterCount } } },
      value: symbol.type === 'number' ? (() => { const [minimum, maximum] = 'range' in symbol && symbol.range ? symbol.range : [0, 1]; return { type: 'number', minimum, maximum, multipleOf: 0.01 }; })() : { type: 'boolean' },
    },
  }));
  const atom = atomBranches.length ? { oneOf: atomBranches } : noMatch;
  const comparisonBranches = atomBranches.map((branch) => ({ ...branch, required: ['ref', 'op', 'value'], properties: { ...branch.properties, op: { const: 'eq' } } }));
  const comparison = comparisonBranches.length ? { oneOf: comparisonBranches } : noMatch;
  return {
    type: 'object', additionalProperties: false, required: ['initialState', 'outcomes', 'rationales'],
    properties: {
      rationales: { type: 'array', minItems: contract.endings.length, maxItems: contract.endings.length, items: { type: 'object', additionalProperties: false, required: ['endingId', 'explanation'], properties: { endingId: { enum: contract.endings.map((e) => e.id) }, explanation: { type: 'string', minLength: 1, maxLength: 1200 } } } },
      initialState: { type: 'array', items: atom, maxItems: 256 },
      outcomes: {
        type: 'array', minItems: contract.endings.length, maxItems: contract.endings.length,
        items: { type: 'object', additionalProperties: false, required: ['endingId', 'condition'], properties: {
          endingId: contract.endings.length ? { enum: contract.endings.map(({ id }) => id) } : noMatch,
          condition: { type: 'object', additionalProperties: false, required: ['all'], properties: { all: { type: 'array', minItems: 1, maxItems: 16, items: comparison } } },
        } },
      },
    },
  };
};

export async function generateEndingOutcomeProposal(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<EndingOutcomeProposalResponse> {
  if (request.responseMode !== 'ending-outcome-proposal' || !request.brief || !request.approvedContract || !request.playerId || !request.approvalRevision) throw new Error('Ending Outcome proposal에는 승인 snapshot이 필요합니다.');
  const approval = approveAuthorContract(request.brief, request.approvedContract, request.playerId, request.approvalRevision);
  const schema = endingOutcomeProposalJsonSchema(approval.contract);
  const baseMessages = [
    { role: 'system' as const, content: 'Using only the approved Author Contract entities, symbols, and endings, return JSON {initialState,outcomes}. Include exactly one outcome for every approved ending. Every condition must be nonempty and equality-only. initialState must contain every atom used by conditions at least once. This is a proposal for author review; do not claim approval or apply it.' + ' ' + outcomeMeaningPrompt },
    { role: 'user' as const, content: `Brief:\n${approval.brief}\n\nApproved Author Contract:\n${JSON.stringify(approval.contract)}\n\nApproved playerId: ${approval.playerId}` },
  ];
  if (request.mode === 'mock') {
    const selector = approval.contract.stateSymbols.find((symbol) => symbol.type === 'boolean');
    if (approval.contract.endings.length !== 2 || !selector) throw new EndingOutcomeProposalError('Ending Outcome proposal mock requires exactly two endings and a boolean state symbol.', { stage: 'contract-insufficient', code: 'unsupported-contract' });
    const ref = { symbol: selector.id, args: [approval.playerId] };
    const proposed = {
      initialState: [{ ref, value: false }],
      outcomes: approval.contract.endings.map((ending, index) => ({ endingId: ending.id, condition: { all: [{ ref, op: 'eq' as const, value: index === 0 }] } })),
    };
    const checked = approveEndingOutcomes(approval, approval.revision, proposed.initialState, proposed.outcomes);
    return { initialState: checked.initialState, outcomes: checked.outcomes, approvalRevision: approval.revision, rawText: JSON.stringify(proposed), outputChannel: 'mock' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  const select = (message: { content?: string; thinking?: string; reasoning?: string }) => {
    const outputChannel = (['content', 'thinking', 'reasoning'] as const).find((channel) => message[channel]?.trim());
    if (!outputChannel) throw new EndingOutcomeProposalError('empty output', { stage: 'selection', code: 'empty-output' });
    return { rawText: message[outputChannel]!, outputChannel };
  };
  const validate = ({ rawText, outputChannel }: ReturnType<typeof select>): EndingOutcomeProposalResponse => {
    let raw: { initialState?: unknown[]; outcomes?: Array<{ endingId: string; condition?: unknown }>; rationales?: unknown };
    try { raw = JSON.parse(rawText); } catch { throw new EndingOutcomeProposalError('invalid JSON', { stage: 'json-parse', code: 'invalid-json' }); }
    try {
      const checked = approveEndingOutcomes(approval, approval.revision, raw.initialState ?? [], raw.outcomes ?? []);
      assertDistinctOutcomeRegions(checked.outcomes);
      const rationales = parseOutcomeRationales(raw.rationales, approval.contract);
      return { initialState: checked.initialState, outcomes: checked.outcomes, approvalRevision: approval.revision, rawText, outputChannel, ...(rationales.length ? { rationales } : {}) };
    } catch (error) {
      const message = error instanceof Error && /^Ending outcome (?:approval|condition|conditions|initial state|rationales) /.test(error.message) ? error.message : undefined;
      throw new EndingOutcomeProposalError(message ?? 'invalid proposal', { stage: 'validation', code: 'approval-rejected', ...(message ? { message } : {}) });
    }
  };
  const requestOnce = async (messages: typeof baseMessages) => {
    try {
      const endpoint = new URL(request.endpoint);
      if (endpoint.port === '11434') {
        const data = await transport(`${endpoint.protocol}//${endpoint.host}/api/chat`, { model: request.model, messages, think: false, stream: false, format: schema, options: { temperature: 0 } }, {}, controller.signal) as { message?: { content?: string; thinking?: string; reasoning?: string } };
        return select(data.message ?? {});
      }
      const requestOpenAi = async (response_format: Record<string, unknown>) => {
        const data = await transport(completionUrl(request.endpoint), {
          model: request.model, messages, temperature: 0, max_tokens: 8192, response_format,
        }, request.apiKey ? { Authorization: ['Bearer', request.apiKey].join(' ') } : {}, controller.signal) as { choices?: Array<{ message?: { content?: string; thinking?: string; reasoning?: string } }> };
        return select(data.choices?.[0]?.message ?? {});
      };
      try {
        return await requestOpenAi({ type: 'json_schema', json_schema: { name: 'ending_outcome_proposal', strict: true, schema } });
      } catch (error) {
        if (error instanceof EndingOutcomeProposalError || !(error instanceof Error) || !/(json_schema.*(?:unsupported|not supported)|(?:unsupported|not supported).*json_schema)/i.test(error.message)) throw error;
        return requestOpenAi({ type: 'json_object' });
      }
    } catch (error) {
      if (error instanceof EndingOutcomeProposalError) throw error;
      throw new EndingOutcomeProposalError('provider request failed', { stage: 'provider', code: 'request-failed' });
    }
  };
  try {
    const first = await requestOnce(baseMessages);
    let reviewStarted = false;
    try {
      const checked = validate(first);
      if (!checked.rationales?.length) return checked;
      reviewStarted = true;
      const reviewed = await requestOnce([
        { role: 'system', content: baseMessages[0]!.content + ' Independently audit this proposal against the brief, each ending label, and each symbol meaning. Correct semantic mistakes, not just JSON. Check the scope of every negation: not learning from one source does NOT imply knowing nothing when another source succeeds. Knowing a truth is source-independent; hearing a confession and reading a record are different facts. Forgiveness is not trust. Every conjunct explicitly requested by an ending needs its direct fact, while unrelated means must be omitted. The explanation and actual boolean conditions must agree. Return the full corrected proposal JSON (unchanged if already correct). Do not modify the approved contract.' },
        { role: 'user', content: baseMessages[1]!.content + '\nCandidate to audit:\n' + first.rawText },
      ]);
      return validate(reviewed);
    }
    catch (error) {
      if (!(error instanceof EndingOutcomeProposalError) || reviewStarted) throw error;
      const repairMessages = [
        { role: 'system' as const, content: `${baseMessages[0]!.content} Repair the previous JSON using the deterministic validation error. Return the complete corrected JSON only.` },
        { role: 'user' as const, content: `${baseMessages[1]!.content}\n\nPrevious raw output:\n${first.rawText}\n\nDeterministic validation error:\n${error.message}` },
      ];
      return validate(await requestOnce(repairMessages));
    }
  } finally {
    clearTimeout(timeout);
  }
}

const SymbolicEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), graph: z.unknown(), issues: z.array(z.string().trim().min(1).max(2_000)).max(20) }).strict(),
  z.object({ status: z.literal('contract-insufficient'), graph: z.null(), issues: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20) }).strict(),
]);

const buildSymbolicGraphMessages = (approval: ReturnType<typeof approveAuthorContract>, directGraph = false) => [
  { role: 'system' as const, content: directGraph
    ? '승인된 Author Contract만 사용하여 완전한 Symbolic Graph JSON을 생성하세요. root는 version="1"인 Graph여야 합니다. 승인된 entity, location, symbol, ending만 참조하세요. 모든 situation에는 승인된 player가 있어야 하고 모든 승인 ending에는 정확히 하나의 endingRule이 있어야 합니다. graph에는 version, title, startSituationId, initialState, situations, transitions, endingRules를 모두 포함하세요.'
    : '승인된 Author Contract만 사용하여 Symbolic Graph JSON을 생성하세요. 응답은 status, graph, issues만 가진 JSON 객체여야 합니다. 생성 가능하면 status="ok", graph에는 완전한 Symbolic Graph를 넣고 issues는 빈 배열로 하세요. Contract가 충분하지 않으면 status="contract-insufficient", graph은 null, issues에는 부족한 승인 정보만 넣으세요. graph은 version="1"을 사용하고, 승인된 entity, location, symbol, ending만 참조하세요. 모든 situation에는 승인된 player가 있어야 하고 모든 승인 ending에는 정확히 하나의 endingRule이 있어야 합니다. graph에는 version, title, startSituationId, initialState, situations, transitions, endingRules를 모두 포함하세요.' },
  { role: 'user' as const, content: `Brief:\n${approval.brief}\n\n승인된 Author Contract:\n${JSON.stringify(approval.contract)}\n\n승인 playerId: ${approval.playerId}` },
];

const narrativeOutlineExecutionSemantics = `Return only a complete Narrative Outline JSON; no prose. Execution semantics: the first scene is Start and must be nonterminal; \`all: []\` evaluates true; include every approved ending exactly once as a terminal scene; terminal classification evaluates every ending condition and exactly one must hold; the satisfied condition must belong to that terminal's endingId; use approved atom refs in conditions/effects and use effects/conditions to distinguish outcomes. Generic Boolean two-ending example:\n${JSON.stringify({
  title: 'Example',
  initialState: [{ ref: { symbol: 'resolved', args: ['hero'] }, value: false }],
  scenes: [
    { key: 'start', title: 'Start', summary: 'Choose.', locationId: 'room', presentCharacters: ['hero'], precondition: { all: [] }, actions: [
      { label: 'Resolve', to: 'win_end', precondition: { all: [] }, effects: [{ ref: { symbol: 'resolved', args: ['hero'] }, op: 'set', value: true }] },
      { label: 'Leave', to: 'leave_end', precondition: { all: [] }, effects: [] },
    ] },
    { key: 'win_end', title: 'Win', summary: 'Resolved.', locationId: 'room', presentCharacters: ['hero'], precondition: { all: [] }, terminal: { endingId: 'win', condition: { all: [{ ref: { symbol: 'resolved', args: ['hero'] }, op: 'eq', value: true }] } } },
    { key: 'leave_end', title: 'Leave', summary: 'Unresolved.', locationId: 'room', presentCharacters: ['hero'], precondition: { all: [] }, terminal: { endingId: 'leave', condition: { all: [{ ref: { symbol: 'resolved', args: ['hero'] }, op: 'eq', value: false }] } } },
  ],
})}`;

const narrativeOutlineSystemPrompt = (repair: boolean) => `${repair
  ? 'Repair the failed Narrative Outline using only the approved Author Contract. output ONLY a full Narrative Outline JSON, not prose.'
  : '승인된 Author Contract만 사용하여 Narrative Outline JSON을 생성하세요. root에는 title, initialState, scenes만 포함하세요. scenes의 각 항목은 actions 또는 terminal 중 하나를 가져야 합니다. 승인된 entity, location, symbol, ending만 참조하세요. 모든 scene에는 승인된 player가 있어야 합니다.'} ${narrativeOutlineExecutionSemantics}`;

const planDetailExecutionSemantics = `Return only a complete keyed Narrative Plan Details JSON map; no prose. Keep the supplied deterministic Narrative Skeleton unchanged. Initialize every atom later referenced by a guard, effect, or terminal condition in initialState; the first deterministic scene must be nonterminal; \`all: []\` evaluates true; globally, exactly one ending condition must be true at every terminal and be matched to that terminal's endingId; use effects and conditions to distinguish endings. Generic Boolean two-ending map example:\n${JSON.stringify({
  initialState: [{ ref: { symbol: 'resolved', args: ['hero'] }, value: false }],
  scenes: {
    start: { summary: 'Choose.', locationId: 'room', presentCharacters: ['hero'], precondition: { all: [] }, actions: [{ to: 'beat_1', precondition: { all: [] }, effects: [] }] },
    beat_1: { summary: 'Decide.', locationId: 'room', presentCharacters: ['hero'], precondition: { all: [] }, actions: [{ to: 'end_win', precondition: { all: [] }, effects: [{ ref: { symbol: 'resolved', args: ['hero'] }, op: 'set', value: true }] }, { to: 'end_leave', precondition: { all: [] }, effects: [] }] },
    end_win: { summary: 'Resolved.', locationId: 'room', presentCharacters: ['hero'], precondition: { all: [] }, terminal: { condition: { all: [{ ref: { symbol: 'resolved', args: ['hero'] }, op: 'eq', value: true }] } } },
    end_leave: { summary: 'Unresolved.', locationId: 'room', presentCharacters: ['hero'], precondition: { all: [] }, terminal: { condition: { all: [{ ref: { symbol: 'resolved', args: ['hero'] }, op: 'eq', value: false }] } } },
  },
})}`;

const narrativePlanDetailSystemPrompt = (repair: boolean) => `${repair
  ? 'Repair only the Narrative Plan Details JSON map.'
  : 'Generate only a Narrative Plan Details JSON keyed by every supplied deterministic Narrative Skeleton scene key. Each map entry has no key field; use exactly each skeleton outgoing link as an action target, and use only the approved Author Contract.'} ${planDetailExecutionSemantics}`;

const outcomeBoundPlanDetailSystemPrompt = (repair: boolean) => `${repair ? 'Repair only the stateful-v1 Narrative Plan Details JSON map.' : 'Generate only stateful-v1 Narrative Plan Details JSON.'} Root contains format: "stateful-v1" and scenes keyed by EVERY supplied skeleton scene key. Every scene has summary, locationId, presentCharacters (including the approved player), and precondition: {all: [...]}. Nonterminal scenes also have actions, exactly one per outgoing skeleton link, each with to, precondition, effects. Terminal scenes have NO actions or terminal field. Do not supply initialState or ending conditions; approved outcome conditions are already locked and must not be redefined.
Use only atoms listed in the locked initial state. Guards use {ref:{symbol,args},op,value}; effects use {ref:{symbol,args},op:"set"|"add",value}. all: [] is true. Numeric values use 0..1, up to two decimal places; add deltas use -1..1. Transition effects apply BEFORE the destination scene precondition. Preserve state across reconvergence; gate later actions when paths arrive with different knowledge, resources, or relationships. Every planned storyline must remain executable from the locked initial state. Establish outcome-relevant state through plausible intermediate actions, not arbitrary last-edge assignments. At a terminal exactly one approved ending condition must hold and match that terminal. The compiler does not set outcome values for you. Keep all supplied scenes and links; do not hide a problematic route using impossible guards. Return only JSON, no prose.`;

const repairDiagnosticJson = (diagnostic: Record<string, unknown>): string => {
  const serialized = JSON.stringify(diagnostic);
  return serialized.length <= 4_000 ? serialized : JSON.stringify({ stage: diagnostic.stage, code: diagnostic.code, truncated: true });
};

const GeneratedReplySchema = z.object({
  content: z.string().trim().min(1).max(2_000),
  reaction: z.string().trim().min(1).max(20_000),
}).strict();
const GeneratedTurnSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  replies: z.array(GeneratedReplySchema).length(3),
}).strict();
const ScriptedFlowsResultSchema = z.object({
  flows: z.array(z.object({
    turns: z.array(GeneratedTurnSchema).min(1).max(10),
    closingLine: z.string().trim().min(1).max(20_000),
  }).strict()).min(1).max(5),
}).strict();

export type ScriptedFlowsResult = z.infer<typeof ScriptedFlowsResultSchema>;

class ScriptedFlowOutputError extends Error {}

function parseScriptedFlowResult(
  data: { choices?: Array<{ message?: { content?: string } }> },
  turnCount: number,
  flowCount: number,
): ScriptedFlowsResult {
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new ScriptedFlowOutputError('LLM 응답에 사전 생성 결과가 없습니다.');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ScriptedFlowOutputError('LLM이 올바른 JSON 사전 생성 응답을 반환하지 않았습니다.');
  }
  const parsed = ScriptedFlowsResultSchema.safeParse(raw);
  if (!parsed.success) throw new ScriptedFlowOutputError(`LLM 사전 생성 응답 형식 오류: ${parsed.error.issues[0].message}`);
  if (parsed.data.flows.length !== flowCount) throw new ScriptedFlowOutputError('LLM 사전 생성 플로우 수가 요청과 다릅니다.');
  for (const flow of parsed.data.flows) {
    if (flow.turns.length !== turnCount) throw new ScriptedFlowOutputError('LLM 사전 생성 턴 수가 요청과 다릅니다.');
    for (const turn of flow.turns) {
      const replies = turn.replies.map((reply) => reply.content);
      if (new Set(replies).size !== replies.length) throw new ScriptedFlowOutputError('LLM 사전 생성 유저 답변이 중복되었습니다.');
    }
  }
  return parsed.data;
}

function completionUrl(endpoint: string): string {
  const parsed = new URL(endpoint);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('LLM endpoint는 http 또는 https URL이어야 합니다.');
  }
  const cleanPath = parsed.pathname.replace(/\/$/, '');
  if (!cleanPath.endsWith('/chat/completions')) {
    parsed.pathname = `${cleanPath}/chat/completions`;
  }
  return parsed.toString();
}

function parseJsonObject(content: string): GeneratedStoryGraph {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM이 올바른 JSON 스토리 그래프를 반환하지 않았습니다.');
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as GeneratedStoryGraph;
  } catch {
    throw new Error('LLM이 올바른 JSON 스토리 그래프를 반환하지 않았습니다.');
  }
}

function validateDialogueResult(result: GenerateResult, inputMode: GenerateRequest['playerInputMode']): GenerateResult {
  const unique = new Set(result.replyOptions);
  if (unique.size !== result.replyOptions.length) throw new Error('LLM 답변 후보가 중복되었습니다.');
  if (result.readyForChoice && result.replyOptions.length > 0) {
    throw new Error('Choice 준비 완료 응답에는 대화 답변 후보를 포함할 수 없습니다.');
  }
  if (inputMode === 'reply-options' && !result.readyForChoice && result.replyOptions.length < 2) {
    throw new Error('답변 후보 모드에서는 2개 이상의 후보가 필요합니다.');
  }
  if (inputMode !== 'reply-options' && result.replyOptions.length > 0) {
    throw new Error('직접 입력 모드에는 대화 답변 후보를 포함할 수 없습니다.');
  }
  return result;
}

export async function generateScriptedFlows(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<ScriptedFlowsResult> {
  const { turnCount, flowCount } = request;
  if (request.responseMode !== 'scripted-flows' || turnCount === undefined || flowCount === undefined) {
    throw new Error('사전 생성에는 turnCount와 flowCount가 필요합니다.');
  }
  if (request.mode === 'mock') {
    return {
      flows: Array.from({ length: flowCount }, (_, flowIndex) => ({
        turns: Array.from({ length: turnCount }, (_, turnIndex) => ({
          content: `플로우 ${flowIndex + 1}의 ${turnIndex + 1}턴 공통 대사입니다.`,
          replies: [
            { content: '솔직하게 마음을 말한다.', reaction: '솔직하게 말해줘서 고마워요.' },
            { content: '조심스럽게 대답한다.', reaction: '천천히 말해도 괜찮아요.' },
            { content: '분위기를 바꾸어 말한다.', reaction: '그렇게 생각할 수도 있겠네요.' },
          ],
        })),
        closingLine: `플로우 ${flowIndex + 1}의 대화를 마치고 다음 상황으로 이어집니다.`,
      })),
    };
  }

  if (!request.model.trim()) throw new Error('모델 이름을 입력해 주세요.');
  const url = completionUrl(request.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const requestOnce = async (temperature: number) => {
      const data = await transport(
        url,
        {
          model: request.model,
          messages: request.messages,
          temperature,
          response_format: { type: 'json_object' },
        },
        request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {},
        controller.signal,
      ) as { choices?: Array<{ message?: { content?: string } }> };
      return parseScriptedFlowResult(data, turnCount, flowCount);
    };

    try {
      return await requestOnce(request.temperature);
    } catch (error) {
      if (!(error instanceof ScriptedFlowOutputError) || request.temperature === 0) throw error;
      return requestOnce(0);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateNarrativeOutline(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<NarrativeOutlineGenerationResponse> {
  if (request.responseMode !== 'narrative-outline' || !request.brief || !request.approvedContract || !request.playerId || !request.approvalRevision) throw new Error('Narrative Outline 생성에는 승인 snapshot이 필요합니다.');
  const approval = approveAuthorContract(request.brief, request.approvedContract, request.playerId, request.approvalRevision);
  const outlineJsonSchema = narrativeOutlineJsonSchemaForContract(approval.contract);
  const correlationId = randomUUID();
  let transportCalls = 0;
  let schemaFallbackCalls = 0;
  const diagnostic = (first: OutlineGenerationIssue | null, final: OutlineGenerationIssue | null, attempts: 1 | 2): OutlineGenerationDiagnostic => ({ correlationId, first, final, semanticGenerationAttempts: attempts, repairUsed: attempts === 2, transportCalls, schemaFallbackCalls });
  const issue = (stage: OutlineGenerationStage, code: string, path?: string): OutlineGenerationIssue => ({ stage, code, ...(path ? { path } : {}) });
  const safeIssue = (stage: OutlineGenerationStage, error: unknown): OutlineGenerationIssue => issue(stage, error instanceof Error && error.message.includes('unknown target scene') ? 'unknown-target' : stage);
  const validate = (rawText: string): { outline?: NarrativeOutline; failure?: OutlineGenerationIssue; repairMessage?: string; repairDiagnostic?: string } => {
    let raw: unknown;
    try { raw = JSON.parse(rawText); } catch { return { failure: issue('json-parse', 'invalid-json'), repairMessage: 'LLM이 올바른 Narrative Outline JSON 응답을 반환하지 않았습니다.' }; }
    try {
      const outline = parseNarrativeOutline(raw);
      try {
        const report = verifySymbolicModel(compileNarrativeOutline(approval, outline));
        if (report.status !== 'pass') {
          const finding = report.findings[0];
          const witness = finding?.witness;
          return {
            failure: issue('verifier', finding?.code ?? 'verification-failed'),
            repairMessage: `Narrative Outline 검증 오류 (${finding?.code ?? report.status}): ${finding?.message ?? report.status}`,
            ...(witness ? { repairDiagnostic: repairDiagnosticJson({
              stage: 'verifier', code: finding!.code,
              witness: {
                transitionIds: witness.transitionIds.slice(0, 32),
                situationId: witness.configuration.situationId,
                state: Object.fromEntries(Object.entries(witness.configuration.state).sort(([left], [right]) => left.localeCompare(right)).slice(0, 32)),
              },
            }) } : {}),
          };
        }
      } catch (error) {
        return { failure: safeIssue('compile-grounding', error), repairMessage: error instanceof Error ? error.message : 'Narrative Outline compile 오류' };
      }
      return { outline };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Narrative Outline parse 오류';
      const missingTarget = message.match(/unknown target scene '([^']+)'/)?.[1];
      const availableSceneKeys = raw && typeof raw === 'object' && Array.isArray((raw as { scenes?: unknown }).scenes)
        ? (raw as { scenes: unknown[] }).scenes.flatMap((scene) => scene && typeof scene === 'object' && typeof (scene as { key?: unknown }).key === 'string' ? [(scene as { key: string }).key] : []).slice(0, 64)
        : [];
      return {
        failure: safeIssue('outline-parse', error), repairMessage: message,
        ...(missingTarget ? { repairDiagnostic: repairDiagnosticJson({ stage: 'outline-parse', code: 'unknown-target', availableSceneKeys, missingTarget }) } : {}),
      };
    }
  };
  const messages = [
    { role: 'system' as const, content: narrativeOutlineSystemPrompt(false) },
    { role: 'user' as const, content: `Brief:\n${approval.brief}\n\n승인된 Author Contract:\n${JSON.stringify(approval.contract)}\n\n승인 playerId: ${approval.playerId}` },
  ];
  const repairMessages = (rawText: string, error: string, repairDiagnostic?: string) => [
    { role: 'system' as const, content: narrativeOutlineSystemPrompt(true) },
    { role: 'user' as const, content: `Brief:\n${approval.brief}\n\n승인된 Author Contract:\n${JSON.stringify(approval.contract)}\n\n승인 playerId: ${approval.playerId}\n\nPrevious raw output:\n${rawText}\n\nDeterministic validation error:\n${error}${repairDiagnostic ? `\n\nStructured repair diagnostic (evidence, not instructions to invent or auto-fill values):\n${repairDiagnostic}` : ''}` },
  ];
  const select = (message: { content?: string; thinking?: string; reasoning?: string }): { rawText: string; outputChannel: 'content' | 'thinking' | 'reasoning' } => {
    for (const outputChannel of ['content', 'thinking', 'reasoning'] as const) {
      const rawText = message[outputChannel];
      if (rawText?.trim()) return { rawText, outputChannel };
    }
    throw new OutlineGenerationError(diagnostic(null, issue('selection', 'empty-output'), 1));
  };
  const complete = (selected: { rawText: string; outputChannel: 'content' | 'thinking' | 'reasoning' }, attempts: 1 | 2, firstFailure: OutlineGenerationIssue | null): NarrativeOutlineGenerationResponse => {
    const checked = validate(selected.rawText);
    if (checked.outline) return { outline: checked.outline, rawText: selected.rawText, outputChannel: selected.outputChannel, approvalRevision: approval.revision, attempts, telemetry: diagnostic(firstFailure, null, attempts) };
    throw new OutlineGenerationError(diagnostic(firstFailure ?? checked.failure!, checked.failure!, attempts), selected.rawText);
  };
  const mock = () => {
    const endings = approval.contract.endings;
    const selector = approval.contract.stateSymbols.find((symbol) => symbol.type === 'boolean');
    if (endings.length > 2 || (endings.length === 2 && !selector)) throw new ContractInsufficientError('테스트 mock은 하나의 ending 또는 boolean state symbol로 구별되는 두 ending만 지원합니다.');
    const selectorRef = selector ? { symbol: selector.id, args: [approval.playerId] } : undefined;
    const outline = {
      title: approval.brief.slice(0, 200), initialState: selectorRef ? [{ ref: selectorRef, value: false }] : [],
      scenes: [
        { key: 'start', title: '시작', summary: approval.brief, locationId: approval.contract.entities.locations[0]!, presentCharacters: [approval.playerId], precondition: { all: [] }, actions: endings.map((ending, index) => ({ label: ending.label, to: `end_${index + 1}`, precondition: { all: [] }, effects: selectorRef && index === 0 ? [{ ref: selectorRef, op: 'set', value: true }] : [] })) },
        ...endings.map((ending, index) => ({ key: `end_${index + 1}`, title: ending.label, summary: ending.label, locationId: approval.contract.entities.locations[0]!, presentCharacters: [approval.playerId], precondition: { all: [] }, terminal: { endingId: ending.id, condition: { all: selectorRef ? [{ ref: selectorRef, op: 'eq', value: index === 0 }] : [] } } })),
      ],
    };
    const selected = { rawText: JSON.stringify(outline), outputChannel: 'mock' as const };
    const checked = validate(selected.rawText);
    if (!checked.outline) throw new OutlineGenerationError(diagnostic(checked.failure!, checked.failure!, 1), selected.rawText);
    return { outline: checked.outline, ...selected, approvalRevision: approval.revision, attempts: 1 as const, telemetry: diagnostic(null, null, 1) };
  };
  if (request.mode === 'mock') return mock();
  if (!request.model.trim()) throw new Error('모델 이름을 입력해 주세요.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const run = async (requestAttempt: (nextMessages: typeof messages | ReturnType<typeof repairMessages>) => Promise<{ rawText: string; outputChannel: 'content' | 'thinking' | 'reasoning' }>) => {
    let first;
    try { first = await requestAttempt(messages); }
    catch (error) {
      if (error instanceof OutlineGenerationError) throw error;
      throw new OutlineGenerationError(diagnostic(null, issue('provider', 'request-failed'), 1), undefined, error instanceof Error ? error.message : 'LLM provider request failed');
    }
    const initial = validate(first.rawText);
    if (initial.outline) return { outline: initial.outline, rawText: first.rawText, outputChannel: first.outputChannel, approvalRevision: approval.revision, attempts: 1 as const, telemetry: diagnostic(null, null, 1) };
    try {
      const second = await requestAttempt(repairMessages(first.rawText, initial.repairMessage!, initial.repairDiagnostic));
      return complete(second, 2, initial.failure!);
    } catch (error) {
      if (error instanceof OutlineGenerationError) {
        throw new OutlineGenerationError(diagnostic(initial.failure!, error.diagnostic.final ?? issue('selection', 'empty-output'), 2), error.selectedJsonCandidate ?? first.rawText);
      }
      throw new OutlineGenerationError(diagnostic(initial.failure!, issue('provider', 'request-failed'), 2), first.rawText, error instanceof Error ? error.message : 'LLM provider request failed');
    }
  };
  try {
    const endpoint = new URL(request.endpoint);
    if (endpoint.port === '11434') {
      return await run(async (nextMessages) => {
        transportCalls += 1;
        const data = await transport(`${endpoint.protocol}//${endpoint.host}/api/chat`, { model: request.model, messages: nextMessages, think: false, stream: false, format: outlineJsonSchema, options: { temperature: 0 } }, {}, controller.signal) as { message?: { content?: string; thinking?: string; reasoning?: string } };
        return select(data.message ?? {});
      });
    }
    return await run(async (nextMessages) => {
      const requestOnce = async (response_format: Record<string, unknown>) => {
        transportCalls += 1;
        const headers: Record<string, string> = request.apiKey ? { Authorization: ['Bearer', request.apiKey].join(' ') } : {};
        const data = await transport(completionUrl(request.endpoint), { model: request.model, messages: nextMessages, temperature: 0, max_tokens: 8192, response_format }, headers, controller.signal) as { choices?: Array<{ message?: { content?: string; thinking?: string; reasoning?: string } }> };
        return select(data.choices?.[0]?.message ?? {});
      };
      const schema = { type: 'json_schema', json_schema: { name: 'narrative_outline', strict: true, schema: outlineJsonSchema } };
      try { return await requestOnce(schema); }
      catch (error) {
        if (error instanceof OutlineGenerationError || !(error instanceof Error) || !/(json_schema.*(?:unsupported|not supported)|(?:unsupported|not supported).*json_schema)/i.test(error.message)) throw error;
        schemaFallbackCalls += 1;
        return requestOnce({ type: 'json_object' });
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

export type NarrativePlanDetailsGenerationResponse = Readonly<{
  plan: NarrativePlan;
  skeleton: NarrativeSkeleton;
  details: NarrativeDetails;
  rawPlanText: string;
  rawDetailsText: string;
  outputChannels: { plan: 'content' | 'thinking' | 'reasoning' | 'mock'; details: 'content' | 'thinking' | 'reasoning' | 'mock' };
  approvalRevision: string;
  planAttempts: 1;
  detailAttempts: 1 | 2;
  telemetry?: OutlineGenerationDiagnostic;
}>;

export type NarrativePlanOutcomesGenerationResponse = Omit<NarrativePlanDetailsGenerationResponse, 'details' | 'planAttempts'> & Readonly<{ details: OutcomeBoundNarrativePlanDetails; planAttempts: 1 | 2 }>;

export async function generatePlanDetails(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<NarrativePlanDetailsGenerationResponse> {
  if (request.responseMode !== 'narrative-plan-details' || !request.brief || !request.approvedContract || !request.playerId || !request.approvalRevision) throw new Error('Narrative Plan/Details 생성에는 승인 snapshot이 필요합니다.');
  const approval = approveAuthorContract(request.brief, request.approvedContract, request.playerId, request.approvalRevision);
  const correlationId = randomUUID();
  let transportCalls = 0;
  let schemaFallbackCalls = 0;
  const issue = (stage: OutlineGenerationStage, code: string): OutlineGenerationIssue => ({ stage, code });
  const diagnostic = (first: OutlineGenerationIssue | null, final: OutlineGenerationIssue | null, detailAttempts: 1 | 2): OutlineGenerationDiagnostic => ({ correlationId, first, final, semanticGenerationAttempts: detailAttempts, repairUsed: detailAttempts === 2, transportCalls, schemaFallbackCalls });
  const failure = (first: OutlineGenerationIssue | null, final: OutlineGenerationIssue, detailAttempts: 1 | 2, raw?: string, acceptedPlanRawText?: string) => new OutlineGenerationError(diagnostic(first, final, detailAttempts), raw, undefined, acceptedPlanRawText);
  const select = (message: { content?: string; thinking?: string; reasoning?: string }) => {
    for (const outputChannel of ['content', 'thinking', 'reasoning'] as const) if (message[outputChannel]?.trim()) return { rawText: message[outputChannel]!, outputChannel };
    const error = new Error('empty-output'); error.name = 'SelectionError'; throw error;
  };
  const requestStage = async (messages: Array<{ role: 'system' | 'user'; content: string }>, schema: Record<string, unknown>, name: string) => {
    const endpoint = new URL(request.endpoint);
    if (endpoint.port === '11434') {
      transportCalls += 1;
      const data = await transport(`${endpoint.protocol}//${endpoint.host}/api/chat`, { model: request.model, messages, think: false, stream: false, format: schema, options: { temperature: 0 } }, {}, undefined) as { message?: { content?: string; thinking?: string; reasoning?: string } };
      return select(data.message ?? {});
    }
    const once = async (response_format: Record<string, unknown>) => {
      transportCalls += 1;
      const data = await transport(completionUrl(request.endpoint), { model: request.model, messages, temperature: 0, max_tokens: 8192, response_format }, request.apiKey ? { Authorization: ['Bearer', request.apiKey].join(' ') } : {}, undefined) as { choices?: Array<{ message?: { content?: string; thinking?: string; reasoning?: string } }> };
      return select(data.choices?.[0]?.message ?? {});
    };
    try { return await once({ type: 'json_schema', json_schema: { name, strict: true, schema } }); }
    catch (error) {
      if (!(error instanceof Error) || !/(json_schema.*(?:unsupported|not supported)|(?:unsupported|not supported).*json_schema)/i.test(error.message)) throw error;
      schemaFallbackCalls += 1;
      return once({ type: 'json_object' });
    }
  };
  const planMessages = [
    { role: 'system' as const, content: 'Generate only Narrative Plan JSON. The root has only title and beats; beats contain only title. Do not generate keys, links, endings, state, or any topology.' },
    { role: 'user' as const, content: `Brief:\n${approval.brief}\n\nApproved Author Contract:\n${JSON.stringify(approval.contract)}\n\nApproved playerId: ${approval.playerId}` },
  ];
  const detailMessages = (skeleton: NarrativeSkeleton) => [
    { role: 'system' as const, content: narrativePlanDetailSystemPrompt(false) },
    { role: 'user' as const, content: `Brief:\n${approval.brief}\n\nApproved Author Contract:\n${JSON.stringify(approval.contract)}\n\nNarrative Plan is compiled server-side into this Skeleton:\n${JSON.stringify(skeleton)}` },
  ];
  const validateDetails = (rawText: string, skeleton: NarrativeSkeleton): { details?: NarrativeDetails; failure?: OutlineGenerationIssue; message?: string; repairDiagnostic?: string } => {
    let raw: unknown;
    try { raw = JSON.parse(rawText); } catch { return { failure: issue('detail-parse', 'invalid-json'), message: 'Narrative Plan Details must be valid JSON.' }; }
    try {
      const details = parseNarrativePlanDetails(raw, approval, skeleton);
      const report = verifySymbolicModel(compileSkeletonDetails(approval, skeleton, details));
      if (report.status !== 'pass') return { failure: issue('verifier', report.findings[0]?.code ?? 'verification-failed'), message: report.findings[0]?.message ?? 'Narrative Plan Details verification failed.' };
      return { details };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Narrative Plan Details parse failed.';
      const missingTarget = message.match(/action target '([^']+)'/)?.[1];
      return { failure: issue('detail-parse', missingTarget ? 'unknown-target' : 'detail-parse'), message, ...(missingTarget ? { repairDiagnostic: repairDiagnosticJson({ stage: 'detail-parse', code: 'unknown-target', missingTarget, availableSceneKeys: skeleton.scenes.map((scene) => scene.key) }) } : {}) };
    }
  };
  const mock = (): NarrativePlanDetailsGenerationResponse => {
    const plan = parseNarrativePlan({ title: approval.brief.slice(0, 200), beats: [] });
    const skeleton = compileNarrativePlan(approval, plan);
    const selector = approval.contract.stateSymbols.find((symbol) => symbol.type === 'boolean');
    if (approval.contract.endings.length > 2 || (approval.contract.endings.length === 2 && !selector)) throw new ContractInsufficientError('테스트 mock은 하나의 ending 또는 boolean state symbol로 구별되는 두 ending만 지원합니다.');
    const ref = selector ? { symbol: selector.id, args: [approval.playerId] } : undefined;
    const details = { initialState: ref ? [{ ref, value: false }] : [], scenes: Object.fromEntries(skeleton.scenes.map((scene) => [scene.key, scene.endingId
      ? { summary: scene.title, locationId: approval.contract.entities.locations[0]!, presentCharacters: [approval.playerId], precondition: { all: [] }, terminal: { condition: { all: ref ? [{ ref, op: 'eq' as const, value: scene.endingId === approval.contract.endings[0]!.id }] : [] } } }
      : { summary: scene.title, locationId: approval.contract.entities.locations[0]!, presentCharacters: [approval.playerId], precondition: { all: [] }, actions: skeleton.links.filter((link) => link.from === scene.key).map((link, index) => ({ to: link.to, precondition: { all: [] }, effects: ref && index === 0 ? [{ ref, op: 'set' as const, value: true }] : [] })) }])) };
    const checked = validateDetails(JSON.stringify(details), skeleton);
    if (!checked.details) throw failure(checked.failure!, checked.failure!, 1);
    return { plan, skeleton, details: checked.details, rawPlanText: JSON.stringify(plan), rawDetailsText: JSON.stringify(details), outputChannels: { plan: 'mock', details: 'mock' }, approvalRevision: approval.revision, planAttempts: 1, detailAttempts: 1, telemetry: diagnostic(null, null, 1) };
  };
  if (request.mode === 'mock') return mock();
  if (!request.model.trim()) throw new Error('모델 이름을 입력해 주세요.');
  let selectedPlan: ReturnType<typeof select>;
  try { selectedPlan = await requestStage(planMessages, narrativePlanJsonSchema, 'narrative_plan'); }
  catch (error) { throw failure(null, issue(error instanceof Error && error.name === 'SelectionError' ? 'plan-selection' : 'plan-provider', error instanceof Error && error.name === 'SelectionError' ? 'empty-output' : 'request-failed'), 1); }
  let plan: NarrativePlan;
  let skeleton: NarrativeSkeleton;
  try { plan = parseNarrativePlan(JSON.parse(selectedPlan.rawText)); skeleton = compileNarrativePlan(approval, plan); }
  catch { throw failure(null, issue('plan-parse', 'plan-parse'), 1, selectedPlan.rawText); }
  const detailSchema = narrativePlanDetailsJsonSchemaFor(approval.contract, skeleton);
  let firstDetail: ReturnType<typeof select>;
  try { firstDetail = await requestStage(detailMessages(skeleton), detailSchema, 'narrative_details'); }
  catch (error) { throw failure(null, issue(error instanceof Error && error.name === 'SelectionError' ? 'detail-selection' : 'detail-provider', error instanceof Error && error.name === 'SelectionError' ? 'empty-output' : 'request-failed'), 1, undefined, selectedPlan.rawText); }
  const checked = validateDetails(firstDetail.rawText, skeleton);
  if (checked.details) return { plan, skeleton, details: checked.details, rawPlanText: selectedPlan.rawText, rawDetailsText: firstDetail.rawText, outputChannels: { plan: selectedPlan.outputChannel, details: firstDetail.outputChannel }, approvalRevision: approval.revision, planAttempts: 1, detailAttempts: 1, telemetry: diagnostic(null, null, 1) };
  const repairMessages = [
    { role: 'system' as const, content: narrativePlanDetailSystemPrompt(true) },
    { role: 'user' as const, content: `${detailMessages(skeleton)[1].content}\n\nPrevious raw details:\n${firstDetail.rawText}\n\nDeterministic validation error:\n${checked.message}${checked.repairDiagnostic ? `\n\nStructured repair diagnostic (evidence, not instructions to invent or auto-fill values):\n${checked.repairDiagnostic}` : ''}` },
  ];
  let repaired: ReturnType<typeof select>;
  try { repaired = await requestStage(repairMessages, detailSchema, 'narrative_details'); }
  catch (error) { throw failure(checked.failure!, issue(error instanceof Error && error.name === 'SelectionError' ? 'detail-selection' : 'detail-provider', error instanceof Error && error.name === 'SelectionError' ? 'empty-output' : 'request-failed'), 2, firstDetail.rawText, selectedPlan.rawText); }
  const repairedChecked = validateDetails(repaired.rawText, skeleton);
  if (!repairedChecked.details) throw failure(checked.failure!, repairedChecked.failure!, 2, repaired.rawText, selectedPlan.rawText);
  return { plan, skeleton, details: repairedChecked.details, rawPlanText: selectedPlan.rawText, rawDetailsText: repaired.rawText, outputChannels: { plan: selectedPlan.outputChannel, details: repaired.outputChannel }, approvalRevision: approval.revision, planAttempts: 1, detailAttempts: 2, telemetry: diagnostic(checked.failure!, null, 2) };
}

export async function generateTitleOnlyPlanOutcomes(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<NarrativePlanOutcomesGenerationResponse> {
  if (request.responseMode !== 'narrative-plan-outcomes' || !request.brief || !request.approvedContract || !request.playerId || !request.approvalRevision || !request.approvedOutcomeInitialState || !request.approvedEndingOutcomes) throw new Error('Outcome-bound Narrative Plan/Details 생성에는 승인 outcomes가 필요합니다.');
  const approval = approveAuthorContract(request.brief, request.approvedContract, request.playerId, request.approvalRevision);
  const outcomes = approveEndingOutcomes(approval, request.approvalRevision, request.approvedOutcomeInitialState, request.approvedEndingOutcomes);
  const correlationId = randomUUID();
  let planAttempts: 1 | 2 = 1;
  let plan: import('../src/storyline-plan.js').StorylinePlan;
  let transportCalls = 0;
  let schemaFallbackCalls = 0;
  const issue = (stage: OutlineGenerationStage, code: string): OutlineGenerationIssue => ({ stage, code });
  const diagnostic = (first: OutlineGenerationIssue | null, final: OutlineGenerationIssue | null, detailAttempts: 1 | 2): OutlineGenerationDiagnostic => ({ correlationId, first, final, semanticGenerationAttempts: detailAttempts, repairUsed: detailAttempts === 2, transportCalls, schemaFallbackCalls, planAttempts, planRepairUsed: planAttempts === 2 });
  const failure = (first: OutlineGenerationIssue | null, final: OutlineGenerationIssue, detailAttempts: 1 | 2, raw?: string, acceptedPlanRawText?: string) => new OutlineGenerationError(diagnostic(first, final, detailAttempts), raw, undefined, acceptedPlanRawText);
  const select = (message: { content?: string; thinking?: string; reasoning?: string }) => {
    for (const outputChannel of ['content', 'thinking', 'reasoning'] as const) if (message[outputChannel]?.trim()) return { rawText: message[outputChannel]!, outputChannel };
    const error = new Error('empty-output'); error.name = 'SelectionError'; throw error;
  };
  const requestStage = async (messages: Array<{ role: 'system' | 'user'; content: string }>, schema: Record<string, unknown>, name: string) => {
    const temperature = name.startsWith('storyline_') ? request.temperature : 0;
    const endpoint = new URL(request.endpoint);
    if (endpoint.port === '11434') {
      transportCalls += 1;
      const data = await transport(`${endpoint.protocol}//${endpoint.host}/api/chat`, { model: request.model, messages, think: false, stream: false, format: schema, options: { temperature, num_ctx: 16384 } }, {}, undefined) as { message?: { content?: string; thinking?: string; reasoning?: string } };
      return select(data.message ?? {});
    }
    const once = async (response_format: Record<string, unknown>) => {
      transportCalls += 1;
      const data = await transport(completionUrl(request.endpoint), { model: request.model, messages: response_format.type === 'json_object' ? [...messages, { role: 'system', content: 'Required output JSON Schema: ' + JSON.stringify(schema) }] : messages, temperature, max_tokens: 16384, response_format }, request.apiKey ? { Authorization: ['Bearer', request.apiKey].join(' ') } : {}, undefined) as { choices?: Array<{ message?: { content?: string; thinking?: string; reasoning?: string } }> };
      return select(data.choices?.[0]?.message ?? {});
    };
    try { return await once({ type: 'json_schema', json_schema: { name, strict: true, schema } }); }
    catch (error) {
      if (!(error instanceof Error) || !/(json_schema.*(?:unsupported|not supported)|(?:unsupported|not supported).*json_schema)/i.test(error.message)) throw error;
      schemaFallbackCalls += 1;
      return once({ type: 'json_object' });
    }
  };
  const detailMessages = (skeleton: NarrativeSkeleton) => [
    { role: 'system' as const, content: outcomeBoundPlanDetailSystemPrompt(false) },
    { role: 'user' as const, content: `Brief:\n${approval.brief}\n\nApproved Author Contract:\n${JSON.stringify(approval.contract)}\n\nNarrative Plan is compiled server-side into this Skeleton:\n${JSON.stringify(skeleton)}\n\nPlanned storylines (all must remain executable):\n${JSON.stringify(plan.storylines)}\n\nApproved initial state (locked):\n${JSON.stringify(outcomes.initialState)}\n\nApproved ending outcomes (locked):\n${JSON.stringify(outcomes.outcomes)}` },
  ];
  const validateDetails = (rawText: string, skeleton: NarrativeSkeleton): { details?: OutcomeBoundNarrativePlanDetails; failure?: OutlineGenerationIssue; message?: string; repairDiagnostic?: string } => {
    let raw: unknown;
    try { raw = JSON.parse(rawText); } catch { return { failure: issue('detail-parse', 'invalid-json'), message: 'Narrative Plan Details must be valid JSON.' }; }
    try {
      if (!raw || typeof raw !== 'object' || !('format' in raw) || raw.format !== 'stateful-v1') throw new Error('New storyline generation requires stateful-v1 details');
      const { details, compiled } = parseOutcomeBoundNarrativePlanDetailsResult(raw, approval, outcomes, skeleton);
      const model = compileSkeletonDetails(approval, skeleton, compiled);
      const routeFinding = verifyPlannedStorylines(model, plan);
      if (routeFinding) return { failure: issue('verifier', routeFinding.code), message: routeFinding.message, repairDiagnostic: repairDiagnosticJson(routeFinding) };
      const report = verifySymbolicModel(model);
      if (report.status !== 'pass') return { failure: issue('verifier', report.findings[0]?.code ?? 'verification-failed'), message: report.findings[0]?.message ?? 'Narrative Plan Details verification failed.', repairDiagnostic: repairDiagnosticJson({ status: report.status, finding: report.findings[0] }) };
      return { details };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Narrative Plan Details parse failed.';
      const missingTarget = message.match(/action target '([^']+)'/)?.[1];
      return { failure: issue('detail-parse', missingTarget ? 'unknown-target' : 'detail-parse'), message, ...(missingTarget ? { repairDiagnostic: repairDiagnosticJson({ stage: 'detail-parse', code: 'unknown-target', missingTarget, availableSceneKeys: skeleton.scenes.map((scene) => scene.key) }) } : {}) };
    }
  };
  const mock = (): NarrativePlanOutcomesGenerationResponse => {
    const generated = createStorylineMock(approval, outcomes);
    plan = generated.plan;
    const { skeleton, details } = generated;
    const checked = validateDetails(JSON.stringify(details), skeleton);
    if (!checked.details) throw failure(checked.failure!, checked.failure!, 1);
    return { plan, skeleton, details: checked.details, rawPlanText: JSON.stringify(plan), rawDetailsText: JSON.stringify(details), outputChannels: { plan: 'mock', details: 'mock' }, approvalRevision: approval.revision, planAttempts, detailAttempts: 1, telemetry: diagnostic(null, null, 1) };
  };
  if (request.mode === 'mock') return mock();
  if (!request.model.trim()) throw new Error('모델 이름을 입력해 주세요.');
  const context = 'Brief:\n' + approval.brief + '\nApproved contract:\n' + JSON.stringify(approval.contract) + '\nLocked initial state:\n' + JSON.stringify(outcomes.initialState) + '\nApproved ending outcomes:\n' + JSON.stringify(outcomes.outcomes);
  const artifacts: Array<{ stage: string; rawText: string; outputChannel: string }> = [];
  let firstPlanFailure: OutlineGenerationIssue | null = null;
  const requestPlanPart = async <T>(messages: Array<{ role: 'system' | 'user'; content: string }>, schema: Record<string, unknown>, stage: string, validate: (raw: unknown) => T): Promise<{ value: T; outputChannel: 'content' | 'thinking' | 'reasoning' }> => {
    let previous: { rawText: string; message: string } | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) planAttempts = 2;
      let selected: ReturnType<typeof select>;
      try {
        selected = await requestStage(previous ? [...messages, { role: 'user', content: 'Repair ONLY this failed part. The existing storyline is already accepted and must stay unchanged.\nPrevious invalid output:\n' + previous.rawText + '\nValidation error:\n' + previous.message + '\nReturn only the corrected JSON for this part. Do not include any existing events in beats.' }] : messages, schema, stage);
        artifacts.push({ stage, ...selected });
      } catch (error) {
        throw failure(firstPlanFailure, issue(error instanceof Error && error.name === 'SelectionError' ? 'plan-selection' : 'plan-provider', error instanceof Error && error.name === 'SelectionError' ? 'empty-output' : 'request-failed'), 1);
      }
      try { return { value: validate(JSON.parse(selected.rawText)), outputChannel: selected.outputChannel }; }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid plan part';
        const failed = issue('plan-parse', message.includes('duplicate existing event titles') ? 'duplicate-event' : error instanceof SyntaxError ? 'invalid-json' : 'plan-parse');
        firstPlanFailure ??= failed;
        if (attempt === 2) throw failure(firstPlanFailure, failed, 1, selected.rawText);
        previous = { rawText: selected.rawText, message };
      }
    }
    throw new Error('Unreachable plan retry');
  };
  const seed = await requestPlanPart([
    { role: 'system', content: storylineSeedPrompt },
    { role: 'user', content: context + '\nFirst ending: ' + approval.contract.endings[0]!.id },
  ], storylineSeedJsonSchema, 'storyline_seed', (raw) => createStorylineSeed(raw, approval.contract));
  let candidate = seed.value;
  for (let index = 1; index < Math.max(2, approval.contract.endings.length); index++) {
    const endingId = approval.contract.endings[index % approval.contract.endings.length]!.id;
    const expansion = await requestPlanPart([
      { role: 'system', content: storylineExpansionPrompt },
      { role: 'user', content: context + '\nExisting storylines (read-only context; NEVER copy these events into your output):\n' + JSON.stringify(candidate) + '\nAllowed segments:\n' + JSON.stringify(storylineSegments(candidate)) + '\nNew route ending: ' + endingId + '\nReturn ONLY new events between the selected anchors. The compiler inserts prefix, anchors, suffix and ending for you.' },
    ], storylineExpansionJsonSchemaFor(candidate), 'storyline_expansion', (raw) => {
      const next = appendStoryline(candidate, raw, endingId);
      if (index === Math.max(2, approval.contract.endings.length) - 1) compileNarrativePlan(approval, finishStorylinePlan(next));
      return next;
    });
    candidate = expansion.value;
  }
  plan = finishStorylinePlan(candidate);
  const skeleton = compileNarrativePlan(approval, plan);
  const selectedPlan = { rawText: JSON.stringify(artifacts), outputChannel: seed.outputChannel };
  const detailSchema = statefulOutcomeDetailsJsonSchemaFor(approval.contract, skeleton);
  let firstDetail: ReturnType<typeof select>;
  try { firstDetail = await requestStage(detailMessages(skeleton), detailSchema, 'narrative_details'); }
  catch (error) { throw failure(null, issue(error instanceof Error && error.name === 'SelectionError' ? 'detail-selection' : 'detail-provider', error instanceof Error && error.name === 'SelectionError' ? 'empty-output' : 'request-failed'), 1, undefined, selectedPlan.rawText); }
  const checked = validateDetails(firstDetail.rawText, skeleton);
  if (checked.details) return { plan, skeleton, details: checked.details, rawPlanText: selectedPlan.rawText, rawDetailsText: firstDetail.rawText, outputChannels: { plan: selectedPlan.outputChannel, details: firstDetail.outputChannel }, approvalRevision: approval.revision, planAttempts, detailAttempts: 1, telemetry: diagnostic(firstPlanFailure, null, 1) };
  const repairMessages = [
    { role: 'system' as const, content: outcomeBoundPlanDetailSystemPrompt(true) },
    { role: 'user' as const, content: `${detailMessages(skeleton)[1].content}\n\nPrevious raw details:\n${firstDetail.rawText}\n\nDeterministic validation error:\n${checked.message}${checked.repairDiagnostic ? `\n\nStructured repair diagnostic (evidence, not instructions to invent or auto-fill values):\n${checked.repairDiagnostic}` : ''}` },
  ];
  let repaired: ReturnType<typeof select>;
  try { repaired = await requestStage(repairMessages, detailSchema, 'narrative_details'); }
  catch (error) { throw failure(checked.failure!, issue(error instanceof Error && error.name === 'SelectionError' ? 'detail-selection' : 'detail-provider', error instanceof Error && error.name === 'SelectionError' ? 'empty-output' : 'request-failed'), 2, firstDetail.rawText, selectedPlan.rawText); }
  const repairedChecked = validateDetails(repaired.rawText, skeleton);
  if (!repairedChecked.details) throw failure(checked.failure!, repairedChecked.failure!, 2, repaired.rawText, selectedPlan.rawText);
  return { plan, skeleton, details: repairedChecked.details, rawPlanText: selectedPlan.rawText, rawDetailsText: repaired.rawText, outputChannels: { plan: selectedPlan.outputChannel, details: repaired.outputChannel }, approvalRevision: approval.revision, planAttempts, detailAttempts: 2, telemetry: diagnostic(checked.failure!, null, 2) };
}

export type NarrativeSkeletonDetailsGenerationResponse = Readonly<{
  skeleton: NarrativeSkeleton;
  details: NarrativeDetails;
  rawSkeletonText: string;
  rawDetailsText: string;
  outputChannels: { skeleton: 'content' | 'thinking' | 'reasoning' | 'mock'; details: 'content' | 'thinking' | 'reasoning' | 'mock' };
  approvalRevision: string;
  skeletonAttempts: 1 | 2;
  detailAttempts: 1 | 2;
  telemetry?: OutlineGenerationDiagnostic;
}>;

export async function generateSkeletonDetails(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<NarrativeSkeletonDetailsGenerationResponse> {
  if (request.responseMode !== 'narrative-skeleton-details' || !request.brief || !request.approvedContract || !request.playerId || !request.approvalRevision) throw new Error('Narrative Skeleton/Details 생성에는 승인 snapshot이 필요합니다.');
  const approval = approveAuthorContract(request.brief, request.approvedContract, request.playerId, request.approvalRevision);
  const correlationId = randomUUID();
  let transportCalls = 0;
  let schemaFallbackCalls = 0;
  const issue = (stage: OutlineGenerationStage, code: string): OutlineGenerationIssue => ({ stage, code });
  const diagnostic = (first: OutlineGenerationIssue | null, final: OutlineGenerationIssue | null, skeletonAttempts: 1 | 2, detailAttempts: 1 | 2): OutlineGenerationDiagnostic => ({ correlationId, first, final, semanticGenerationAttempts: detailAttempts, repairUsed: skeletonAttempts === 2 || detailAttempts === 2, transportCalls, schemaFallbackCalls, skeletonAttempts });
  const failure = (first: OutlineGenerationIssue | null, final: OutlineGenerationIssue, skeletonAttempts: 1 | 2, detailAttempts: 1 | 2, raw?: string) => new OutlineGenerationError(diagnostic(first, final, skeletonAttempts, detailAttempts), raw);
  const select = (message: { content?: string; thinking?: string; reasoning?: string }) => {
    for (const outputChannel of ['content', 'thinking', 'reasoning'] as const) if (message[outputChannel]?.trim()) return { rawText: message[outputChannel]!, outputChannel };
    const error = new Error('empty-output');
    error.name = 'SelectionError';
    throw error;
  };
  const baseMessages = (stage: 'skeleton' | 'details', skeleton?: NarrativeSkeleton) => [
    { role: 'system' as const, content: stage === 'skeleton'
      ? 'Generate only a Narrative Skeleton JSON with title, scenes, and links. Use only approved ending IDs; the first scene is nonterminal; each approved ending appears exactly once as a terminal scene; nonterminal scenes have outgoing links and terminal scenes do not.'
      : 'Generate only a Narrative Details JSON bound exactly to the supplied Narrative Skeleton. Include every skeleton scene once, use exactly each skeleton outgoing link as an action target, and use only the approved Author Contract.' },
    { role: 'user' as const, content: `Brief:\n${approval.brief}\n\nApproved Author Contract:\n${JSON.stringify(approval.contract)}\n\nApproved playerId: ${approval.playerId}${skeleton ? `\n\nNarrative Skeleton:\n${JSON.stringify(skeleton)}` : ''}`, ...(skeleton ? { skeleton } : {}) },
  ];
  const requestStage = async (messages: ReturnType<typeof baseMessages>, schema: Record<string, unknown>, name: string) => {
    const endpoint = new URL(request.endpoint);
    if (endpoint.port === '11434') {
      transportCalls += 1;
      const data = await transport(`${endpoint.protocol}//${endpoint.host}/api/chat`, { model: request.model, messages, think: false, stream: false, format: schema, options: { temperature: 0 } }, {}, undefined) as { message?: { content?: string; thinking?: string; reasoning?: string } };
      return select(data.message ?? {});
    }
    const once = async (response_format: Record<string, unknown>) => {
      transportCalls += 1;
      const data = await transport(completionUrl(request.endpoint), { model: request.model, messages, temperature: 0, max_tokens: 8192, response_format }, request.apiKey ? { Authorization: ['Bearer', request.apiKey].join(' ') } : {}, undefined) as { choices?: Array<{ message?: { content?: string; thinking?: string; reasoning?: string } }> };
      return select(data.choices?.[0]?.message ?? {});
    };
    try { return await once({ type: 'json_schema', json_schema: { name, strict: true, schema } }); }
    catch (error) {
      if (error instanceof Error && /(json_schema.*(?:unsupported|not supported)|(?:unsupported|not supported).*json_schema)/i.test(error.message)) {
        schemaFallbackCalls += 1;
        return once({ type: 'json_object' });
      }
      throw error;
    }
  };
  const classifyRequestError = (error: unknown, first: OutlineGenerationIssue | null, skeletonAttempts: 1 | 2, detailAttempts: 1 | 2, raw?: string): never => {
    const final = issue(error instanceof Error && error.name === 'SelectionError' ? 'selection' : 'provider', error instanceof Error && error.name === 'SelectionError' ? 'empty-output' : 'request-failed');
    throw failure(first, final, skeletonAttempts, detailAttempts, raw);
  };
  const validateSkeleton = (rawText: string): { skeleton?: NarrativeSkeleton; failure?: OutlineGenerationIssue; message?: string } => {
    let raw: unknown;
    try { raw = JSON.parse(rawText); } catch { return { failure: issue('skeleton-parse', 'invalid-json'), message: 'Narrative Skeleton must be valid JSON.' }; }
    try { return { skeleton: parseNarrativeSkeleton(raw, approval.contract) }; }
    catch (error) { return { failure: issue('skeleton-parse', 'skeleton-parse'), message: error instanceof Error ? error.message : 'Narrative Skeleton parse failed.' }; }
  };
  const validateDetails = (rawText: string, skeleton: NarrativeSkeleton): { details?: NarrativeDetails; failure?: OutlineGenerationIssue; message?: string; repairDiagnostic?: string } => {
    let raw: unknown;
    try { raw = JSON.parse(rawText); } catch { return { failure: issue('detail-parse', 'invalid-json'), message: 'Narrative Details must be valid JSON.' }; }
    try {
      const details = parseNarrativeDetails(raw, approval, skeleton);
      const report = verifySymbolicModel(compileSkeletonDetails(approval, skeleton, details));
      if (report.status !== 'pass') return { failure: issue('verifier', report.findings[0]?.code ?? 'verification-failed'), message: report.findings[0]?.message ?? 'Narrative Details verification failed.' };
      return { details };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Narrative Details parse failed.';
      const missingTarget = message.match(/action target '([^']+)'/)?.[1];
      return { failure: issue('detail-parse', missingTarget ? 'unknown-target' : 'detail-parse'), message, ...(missingTarget ? { repairDiagnostic: repairDiagnosticJson({ stage: 'detail-parse', code: 'unknown-target', missingTarget, availableSceneKeys: skeleton.scenes.map((scene) => scene.key) }) } : {}) };
    }
  };
  const mock = (): NarrativeSkeletonDetailsGenerationResponse => {
    const endings = approval.contract.endings;
    const selector = approval.contract.stateSymbols.find((symbol) => symbol.type === 'boolean');
    if (endings.length > 2 || (endings.length === 2 && !selector)) throw new ContractInsufficientError('테스트 mock은 하나의 ending 또는 boolean state symbol로 구별되는 두 ending만 지원합니다.');
    const skeleton = { title: approval.brief.slice(0, 200), scenes: [{ key: 'start', title: '시작' }, ...endings.map((ending, index) => ({ key: `end_${index + 1}`, title: ending.label, endingId: ending.id }))], links: endings.map((ending, index) => ({ from: 'start', to: `end_${index + 1}`, label: ending.label })) };
    const selectorRef = selector ? { symbol: selector.id, args: [approval.playerId] } : undefined;
    const details = { initialState: selectorRef ? [{ ref: selectorRef, value: false }] : [], scenes: [
      { key: 'start', summary: approval.brief, locationId: approval.contract.entities.locations[0]!, presentCharacters: [approval.playerId], precondition: { all: [] }, actions: endings.map((_, index) => ({ to: `end_${index + 1}`, precondition: { all: [] }, effects: selectorRef && index === 0 ? [{ ref: selectorRef, op: 'set' as const, value: true }] : [] })) },
      ...endings.map((_, index) => ({ key: `end_${index + 1}`, summary: approval.brief, locationId: approval.contract.entities.locations[0]!, presentCharacters: [approval.playerId], precondition: { all: [] }, terminal: { condition: { all: selectorRef ? [{ ref: selectorRef, op: 'eq' as const, value: index === 0 }] : [] } } })),
    ] };
    const parsedSkeleton = parseNarrativeSkeleton(skeleton, approval.contract);
    const checked = validateDetails(JSON.stringify(details), parsedSkeleton);
    if (!checked.details) throw failure(checked.failure!, checked.failure!, 1, 1);
    return { skeleton: parsedSkeleton, details: checked.details, rawSkeletonText: JSON.stringify(skeleton), rawDetailsText: JSON.stringify(details), outputChannels: { skeleton: 'mock', details: 'mock' }, approvalRevision: approval.revision, skeletonAttempts: 1, detailAttempts: 1, telemetry: diagnostic(null, null, 1, 1) };
  };
  if (request.mode === 'mock') return mock();
  if (!request.model.trim()) throw new Error('모델 이름을 입력해 주세요.');
  let selectedSkeleton: ReturnType<typeof select>;
  try { selectedSkeleton = await requestStage(baseMessages('skeleton'), narrativeSkeletonJsonSchema, 'narrative_skeleton'); }
  catch (error) { return classifyRequestError(error, null, 1, 1); }
  const initialSkeleton = validateSkeleton(selectedSkeleton.rawText);
  let skeleton: NarrativeSkeleton;
  let skeletonAttempts: 1 | 2 = 1;
  if (initialSkeleton.skeleton) skeleton = initialSkeleton.skeleton;
  else {
    const repairMessages = [
      { role: 'system' as const, content: 'Repair only the Narrative Skeleton JSON using the approved Author Contract. Return only a full Narrative Skeleton JSON. The diagnostic is evidence; do not invent Contract endings/scenes.' },
      { role: 'user' as const, content: `Brief:\n${approval.brief}\n\nApproved Author Contract:\n${JSON.stringify(approval.contract)}\n\nApproved playerId: ${approval.playerId}\n\nPrevious raw Skeleton:\n${selectedSkeleton.rawText}\n\nDeterministic parser error:\n${initialSkeleton.message}` },
    ];
    let repairedSkeleton: ReturnType<typeof select>;
    try { repairedSkeleton = await requestStage(repairMessages, narrativeSkeletonJsonSchema, 'narrative_skeleton'); }
    catch (error) { return classifyRequestError(error, initialSkeleton.failure!, 2, 1, selectedSkeleton.rawText); }
    const repaired = validateSkeleton(repairedSkeleton.rawText);
    if (!repaired.skeleton) throw failure(initialSkeleton.failure!, repaired.failure!, 2, 1, repairedSkeleton.rawText);
    selectedSkeleton = repairedSkeleton;
    skeleton = repaired.skeleton;
    skeletonAttempts = 2;
  }
  const detailSchema = narrativeDetailsJsonSchemaFor(approval.contract, skeleton);
  let firstDetail: ReturnType<typeof select>;
  try { firstDetail = await requestStage(baseMessages('details', skeleton), detailSchema, 'narrative_details'); }
  catch (error) { return classifyRequestError(error, null, skeletonAttempts, 1); }
  const checked = validateDetails(firstDetail.rawText, skeleton);
  if (checked.details) return { skeleton, details: checked.details, rawSkeletonText: selectedSkeleton.rawText, rawDetailsText: firstDetail.rawText, outputChannels: { skeleton: selectedSkeleton.outputChannel, details: firstDetail.outputChannel }, approvalRevision: approval.revision, skeletonAttempts, detailAttempts: 1, telemetry: diagnostic(null, null, skeletonAttempts, 1) };
  const repairMessages = [
    { role: 'system' as const, content: 'Repair only the Narrative Details JSON. Keep the supplied Narrative Skeleton unchanged. Return only complete Narrative Details JSON.' },
    { ...baseMessages('details', skeleton)[1], content: `${baseMessages('details', skeleton)[1].content}\n\nPrevious raw details:\n${firstDetail.rawText}\n\nDeterministic validation error:\n${checked.message}${checked.repairDiagnostic ? `\n\nStructured repair diagnostic (evidence, not instructions to invent or auto-fill values):\n${checked.repairDiagnostic}` : ''}`, previousDetails: JSON.parse(firstDetail.rawText) },
  ];
  let repaired: ReturnType<typeof select>;
  try { repaired = await requestStage(repairMessages, detailSchema, 'narrative_details'); }
  catch (error) { return classifyRequestError(error, checked.failure!, skeletonAttempts, 2, firstDetail.rawText); }
  const repairedChecked = validateDetails(repaired.rawText, skeleton);
  if (!repairedChecked.details) throw failure(checked.failure!, repairedChecked.failure!, skeletonAttempts, 2, repaired.rawText);
  return { skeleton, details: repairedChecked.details, rawSkeletonText: selectedSkeleton.rawText, rawDetailsText: repaired.rawText, outputChannels: { skeleton: selectedSkeleton.outputChannel, details: repaired.outputChannel }, approvalRevision: approval.revision, skeletonAttempts, detailAttempts: 2, telemetry: diagnostic(checked.failure!, null, skeletonAttempts, 2) };
}

export async function generateSymbolicGraph(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<GraphGenerationResponse> {
  if (request.responseMode !== 'symbolic-graph' || !request.brief || !request.approvedContract || !request.playerId || !request.approvalRevision) throw new Error('Symbolic Graph 생성에는 승인 snapshot이 필요합니다.');
  const approval = approveAuthorContract(request.brief, request.approvedContract, request.playerId, request.approvalRevision);
  const mock = (): GraphGenerationResponse => {
    const endings = approval.contract.endings;
    const selector = approval.contract.stateSymbols.find((symbol) => symbol.type === 'boolean');
    if (endings.length > 2 || (endings.length === 2 && !selector)) {
      throw new ContractInsufficientError('테스트 mock은 하나의 ending 또는 boolean state symbol로 구별되는 두 ending만 지원합니다.');
    }
    const selectorRef = selector ? { symbol: selector.id, args: [approval.playerId] } : undefined;
    const situations = [{ id: 'start', title: '시작', summary: approval.brief, locationId: approval.contract.entities.locations[0]!, time: '미정', presentCharacters: [approval.playerId], precondition: { all: [] }, endingId: null }, ...endings.map((ending, index) => ({ id: `end_${index + 1}`, title: ending.label, summary: ending.label, locationId: approval.contract.entities.locations[0]!, time: '미정', presentCharacters: [approval.playerId], precondition: { all: [] }, endingId: ending.id }))];
    const graph = {
      version: '1' as const, title: approval.brief.slice(0, 200), startSituationId: 'start',
      initialState: selectorRef ? [{ ref: selectorRef, value: false }] : [], situations,
      transitions: endings.map((_, index) => ({ id: `to_end_${index + 1}`, from: 'start', to: `end_${index + 1}`, label: `결말 ${index + 1}`, precondition: { all: [] }, effects: selectorRef && index === 0 ? [{ ref: selectorRef, op: 'set' as const, value: true }] : [] })),
      endingRules: endings.map((ending, index) => ({ endingId: ending.id, condition: { all: selectorRef ? [{ ref: selectorRef, op: 'eq' as const, value: index === 0 }] : [] } })),
    };
    return { draft: parseSymbolicGraph(approval, graph).draft, rawText: JSON.stringify({ status: 'ok', graph, issues: [] }), outputChannel: 'mock', approvalRevision: approval.revision };
  };
  if (request.mode === 'mock') return mock();
  if (!request.model.trim()) throw new Error('모델 이름을 입력해 주세요.');

  const parse = (rawText: string, outputChannel: GraphGenerationResponse['outputChannel']): GraphGenerationResponse => {
    let raw: unknown;
    try { raw = JSON.parse(rawText); } catch { throw new Error('LLM이 올바른 Symbolic Graph JSON 응답을 반환하지 않았습니다.'); }
    const directGraph = SymbolicGraphDraftSchema.safeParse(raw);
    if (directGraph.success) return { draft: parseSymbolicGraph(approval, directGraph.data).draft, rawText, outputChannel, approvalRevision: approval.revision };
    const envelope = SymbolicEnvelopeSchema.safeParse(raw);
    if (!envelope.success) throw new Error(`LLM Symbolic Graph 응답 형식 오류: ${envelope.error.issues[0]!.message}`);
    if (envelope.data.status === 'contract-insufficient') throw new ContractInsufficientError(envelope.data.issues.join('\n'));
    return { draft: parseSymbolicGraph(approval, envelope.data.graph).draft, rawText, outputChannel, approvalRevision: approval.revision };
  };
  const select = (message: { content?: string; thinking?: string; reasoning?: string }): { rawText: string; outputChannel: 'content' | 'thinking' | 'reasoning' } => {
    for (const outputChannel of ['content', 'thinking', 'reasoning'] as const) {
      const rawText = message[outputChannel];
      if (rawText?.trim()) return { rawText, outputChannel };
    }
    throw new Error('LLM 응답에 Symbolic Graph가 없습니다.');
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const endpoint = new URL(request.endpoint);
    if (endpoint.port === '11434') {
      const data = await transport(`${endpoint.protocol}//${endpoint.host}/api/chat`, { model: request.model, messages: buildSymbolicGraphMessages(approval, true), think: false, stream: false, format: symbolicGraphJsonSchema, options: { temperature: 0 } }, {}, controller.signal) as { message?: { content?: string; thinking?: string; reasoning?: string } };
      const selected = select(data.message ?? {});
      return parse(selected.rawText, selected.outputChannel);
    }
    const url = completionUrl(request.endpoint);
    const requestOnce = async (response_format: Record<string, unknown>) => {
      const data = await transport(url, { model: request.model, messages: buildSymbolicGraphMessages(approval), temperature: 0, max_tokens: 8192, response_format }, request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}, controller.signal) as { choices?: Array<{ message?: { content?: string; thinking?: string; reasoning?: string } }> };
      const selected = select(data.choices?.[0]?.message ?? {});
      return parse(selected.rawText, selected.outputChannel);
    };
    try {
      return await requestOnce({ type: 'json_schema', json_schema: { name: 'symbolic_graph', strict: true, schema: symbolicGraphEnvelopeJsonSchema } });
    } catch (error) {
      if (!(error instanceof Error) || !/(json_schema.*(?:unsupported|not supported)|(?:unsupported|not supported).*json_schema)/i.test(error.message)) throw error;
      return requestOnce({ type: 'json_object' });
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateStoryContract(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<Record<string, unknown>> {
  if (request.mode === 'mock') return mockContract;
  const endpoint = new URL(request.endpoint);
  if (endpoint.port === '11434') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const data = await transport(`${endpoint.protocol}//${endpoint.host}/api/chat`, { model: request.model, messages: request.messages, think: false, stream: false, format: authorContractJsonSchema, options: { temperature: 0 } }, {}, controller.signal) as { message?: { content?: string; thinking?: string; reasoning?: string } };
      const output = data.message?.content?.trim() || data.message?.thinking?.trim() || data.message?.reasoning?.trim();
      return parseJsonObject(output ?? '');
    } finally { clearTimeout(timeout); }
  }
  return generateStoryGraph(request, transport);
}

export async function generateStoryGraph(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<GeneratedStoryGraph> {
  if (request.responseMode !== 'story-graph' && request.responseMode !== 'story-contract') throw new Error('스토리 그래프 또는 contract 생성 모드가 필요합니다.');
  if (request.mode === 'mock') return structuredClone(mockStoryGraph);
  if (!request.model.trim()) throw new Error('모델 이름을 입력해 주세요.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const data = await transport(
      completionUrl(request.endpoint),
      { model: request.model, messages: request.messages, temperature: 0, max_tokens: 4096, response_format: { type: 'json_object' } },
      request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {},
      controller.signal,
    ) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM 응답에 스토리 그래프가 없습니다.');
    return parseJsonObject(content);
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateReply(request: GenerateRequest, transport: SafeTransport = postJsonSafe): Promise<GenerateResult> {
  const structured = request.responseMode === 'dialogue-readiness';
  const inputMode = request.playerInputMode ?? 'free-text';
  if (request.mode === 'mock') {
    const readyForChoice = structured && request.messages.some((message) => message.role === 'assistant');
    return {
      content: readyForChoice
        ? '지호: 이제 조금 편해진 것 같아요. 그럼 솔직하게 말해도 괜찮아요.'
        : '지호: 와 줘서 고마워요. 사실 나도 조금 긴장했는데, 천천히 이야기해요.',
      readyForChoice,
      replyOptions: structured && inputMode === 'reply-options' && !readyForChoice
        ? ['저도 조금 긴장했어요.', '이 카페 분위기가 좋네요.', '천천히 서로 알아가요.']
        : [],
    };
  }

  if (!request.model.trim()) throw new Error('모델 이름을 입력해 주세요.');
  const url = completionUrl(request.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
    };
    if (structured) body.response_format = { type: 'json_object' };
    const data = await transport(
      url,
      body,
      request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {},
      controller.signal,
    ) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM 응답에 대사 content가 없습니다.');
    if (!structured) return { content, readyForChoice: false, replyOptions: [] };

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error('LLM이 올바른 JSON 대화 응답을 반환하지 않았습니다.');
    }
    const parsed = DialogueResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`LLM 대화 응답 형식 오류: ${parsed.error.issues[0].message}`);
    return validateDialogueResult(parsed.data, inputMode);
  } finally {
    clearTimeout(timeout);
  }
}
