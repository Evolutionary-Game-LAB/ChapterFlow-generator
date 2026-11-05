import { ScriptedLineSchema, StorySchema, type Story } from '../schema';
import { parseSymbolicStoryPayload } from '../symbolic-story-payload';
import { validateStoryReferences } from '../validation';
import {validateChapterBinding} from '../chapter-authoring';
import {buildChapterGameplay} from '../chapter-gameplay-binding';
const MAX_STORY_IMPORT_CHARS = 1_000_000;

function migrateV1(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== '0.1') return raw;
  const story = raw as Record<string, any>;
  const nodes = story.graph?.nodes;
  if (!Array.isArray(nodes)) return { ...story, schemaVersion: '0.2' };
  return {
    ...story,
    schemaVersion: '0.2',
    graph: {
      ...story.graph,
      nodes: nodes.map((node: any) => {
        if (!node || typeof node !== 'object') return node;
        const scriptedLines = Array.isArray(node.scriptedLines)
          ? node.scriptedLines.map((line: any, index: number, lines: any[]) => {
            if (!line || typeof line !== 'object') return line;
            const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(line, key);
            if (!hasOwn('text') || hasOwn('content')) return line;
            const { text, ...rest } = line;
            const restHasOwn = (key: string) => Object.prototype.hasOwnProperty.call(rest, key);
            return {
              ...rest,
              content: text,
              readyForChoice: restHasOwn('readyForChoice')
                ? rest.readyForChoice
                : node.type === 'dialogue' && index === lines.length - 1,
              replyOptions: restHasOwn('replyOptions') ? rest.replyOptions : [],
            };
          })
          : node.scriptedLines;
        return {
          ...node,
          type: node.type === 'condition' ? 'choice' : node.type,
          playerInputMode: node.playerInputMode ?? (node.dialogueMode === 'scripted' ? 'reply-options' : 'free-text'),
          scriptedLines,
        };
      }),
    },
  };
}

function migrateV2(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== '0.2') return raw;
  const story = raw as Record<string, any>;
  const nodes = story.graph?.nodes;
  if (!Array.isArray(nodes)) return { ...story, schemaVersion: '0.3' };
  return {
    ...story,
    schemaVersion: '0.3',
    graph: {
      ...story.graph,
      nodes: nodes.map((node: any) => {
        if (!node || typeof node !== 'object' || node.type !== 'choice') return node;
        const lines = node.scriptedLines;
        if (!Array.isArray(lines) || lines.length > 1) {
          return { ...node, choicePrompt: { content: '어떤 행동을 할까?' } };
        }
        if (lines.length === 0) {
          return { ...node, choicePrompt: { content: '어떤 행동을 할까?' }, scriptedLines: [] };
        }
        const question = ScriptedLineSchema.safeParse(lines[0]);
        if (!question.success) {
          return { ...node, choicePrompt: { content: '어떤 행동을 할까?' } };
        }
        return {
          ...node,
          choicePrompt: { content: question.data.content, speakerId: question.data.speakerId },
          scriptedLines: [],
        };
      }),
    },
  };
}

function migrateV3(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== '0.3') return raw;
  const story = raw as Record<string, any>;
  const nodes = story.graph?.nodes;
  if (!Array.isArray(nodes)) return { ...story, schemaVersion: '0.4' };
  return {
    ...story,
    schemaVersion: '0.4',
    graph: {
      ...story.graph,
      nodes: nodes.map((node: any) => {
        if (!node || typeof node !== 'object') return node;
        return {
          ...node,
          dialogueMode: node.dialogueMode === 'generated'
            ? 'live-generation'
            : node.dialogueMode === 'scripted' && node.preGeneratedDialogue
              ? 'pre-generation'
              : node.dialogueMode,
        };
      }),
    },
  };
}

function migrateV4(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== '0.4') return raw;
  const story = raw as Record<string, any>;
  const nodes = story.graph?.nodes;
  if (!Array.isArray(nodes)) return { ...story, schemaVersion: '0.5' };
  return {
    ...story,
    schemaVersion: '0.5',
    graph: {
      ...story.graph,
      nodes: nodes.map((node: any) => {
        if (node?.type !== 'end') return node;
        const finalLine = Array.isArray(node.scriptedLines) ? ScriptedLineSchema.safeParse(node.scriptedLines.at(-1)) : undefined;
        return {
          ...node,
          endingSummary: node.endingSummary ?? (finalLine?.success ? finalLine.data.content : node.sceneGoal ?? ''),
          endingKind: node.endingKind ?? 'neutral',
          outcomeTags: node.outcomeTags ?? [],
          scriptedLines: finalLine?.success ? [] : node.scriptedLines,
          preGeneratedDialogue: undefined,
          choicePrompt: undefined,
        };
      }),
    },
  };
}

export function migrateV5(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== '0.5') return raw;
  return { ...(raw as Record<string, unknown>), schemaVersion: '0.6' };
}

function validateSymbolicPayload(story: Story): Story {
  if (story.symbolic) parseSymbolicStoryPayload(story.symbolic);
  if(story.chapter)validateChapterBinding(story.chapter,story.symbolic);
  if(story.chapter || story.gameplay || story.chapterEdits) {
    if(!story.symbolic)throw new Error('게임플레이 규칙의 서사 원본이 없습니다.');
    story.gameplay=buildChapterGameplay(story.symbolic,story.gameplay,story.chapterEdits);
  }
  return story;
}

export function parseStory(text: string): Story {
  if (text.length > MAX_STORY_IMPORT_CHARS) throw new Error('Import 파일 크기는 100만 자 이하여야 합니다.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('JSON 문법이 올바르지 않습니다.');
  }

  raw = migrateV5(migrateV4(migrateV3(migrateV2(migrateV1(raw)))));
  const parsed = StorySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first.path.join('.') || 'root';
    throw new Error(`Story Schema 오류 (${path}): ${first.message}`);
  }

  const referenceErrors = validateStoryReferences(parsed.data);
  if (referenceErrors.length > 0) {
    throw new Error(referenceErrors.join('\n'));
  }

  return validateSymbolicPayload(parsed.data);
}

export function serializeStory(story: Story): string {
  const parsed = StorySchema.parse(story);
  validateSymbolicPayload(parsed);
  const referenceErrors = validateStoryReferences(parsed);
  if (referenceErrors.length > 0) throw new Error(referenceErrors.join('\n'));
  const text=JSON.stringify(parsed, null, 2);
  if(text.length>MAX_STORY_IMPORT_CHARS)throw new Error('Export 파일 크기는 100만 자 이하여야 합니다.');
  return text;
}
