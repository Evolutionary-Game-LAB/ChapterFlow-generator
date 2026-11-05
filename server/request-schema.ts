import { z } from 'zod';
import { AuthorContractSchema } from '../src/author-contract.js';

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(20_000),
}).strict();

export const GenerateRequestSchema = z.object({
  mode: z.enum(['mock', 'openai-compatible']),
  preparationMode: z.enum(['mock', 'openai-compatible']).optional(),
  endpoint: z.string().max(2_048),
  model: z.string().min(1).max(200),
  apiKey: z.string().max(4_096),
  temperature: z.number().finite().min(0).max(2),
  responseMode: z.enum(['plain', 'dialogue-readiness', 'scripted-flows', 'story-graph', 'story-contract', 'symbolic-graph', 'narrative-outline', 'narrative-skeleton-details', 'narrative-plan-details', 'narrative-plan-outcomes', 'ending-outcome-proposal']).optional(),
  playerInputMode: z.enum(['free-text', 'reply-options']).optional(),
  turnCount: z.number().int().min(1).max(10).optional(),
  flowCount: z.number().int().min(1).max(5).optional(),
  brief: z.string().trim().min(1).max(20_000).optional(),
  approvedContract: AuthorContractSchema.optional(),
  playerId: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80).optional(),
  approvalRevision: z.string().trim().min(1).max(200).optional(),
  approvedOutcomeInitialState: z.array(z.unknown()).max(256).optional(),
  approvedEndingOutcomes: z.array(z.object({ endingId: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80), condition: z.unknown().refine((condition) => condition !== undefined, 'condition is required') }).strict()).max(20).optional(),
  messages: z.array(MessageSchema).min(1).max(50),
}).strict().superRefine((request, context) => {
  if (request.responseMode === 'scripted-flows') {
    if (request.turnCount === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['turnCount'], message: 'turnCount가 필요합니다.' });
    if (request.flowCount === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['flowCount'], message: 'flowCount가 필요합니다.' });
  }
  if (request.responseMode === 'symbolic-graph' || request.responseMode === 'narrative-outline' || request.responseMode === 'narrative-skeleton-details' || request.responseMode === 'narrative-plan-details' || request.responseMode === 'narrative-plan-outcomes' || request.responseMode === 'ending-outcome-proposal') {
    for (const field of ['brief', 'approvedContract', 'playerId', 'approvalRevision'] as const) {
      if (request[field] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field}가 필요합니다.` });
    }
  }
  if (request.responseMode === 'narrative-plan-outcomes') {
    if (request.approvedOutcomeInitialState === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['approvedOutcomeInitialState'], message: 'approvedOutcomeInitialState가 필요합니다.' });
    if (request.approvedEndingOutcomes === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['approvedEndingOutcomes'], message: 'approvedEndingOutcomes가 필요합니다.' });
  }
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export function parseGenerateRequest(input: unknown): GenerateRequest {
  const result = GenerateRequestSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`LLM 요청 형식 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
  }
  return result.data;
}
