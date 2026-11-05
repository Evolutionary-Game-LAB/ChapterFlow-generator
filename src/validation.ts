import { StorySchema, type Story, type StoryEdge } from './schema.js';
import { applyEffect, createInitialVariables, evaluateCondition } from './playtest/engine.js';

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

export function validateEdgeExpressions(story: Story, edge: StoryEdge): string[] {
  const errors: string[] = [];
  const initialState = createInitialVariables(story);
  try {
    evaluateCondition(initialState, edge.condition);
  } catch (caught) {
    errors.push(`엣지 ${edge.id} 조건식 오류: ${caught instanceof Error ? caught.message : '알 수 없는 오류'}`);
  }
  try {
    applyEffect(initialState, edge.effect);
  } catch (caught) {
    errors.push(`엣지 ${edge.id} 효과식 오류: ${caught instanceof Error ? caught.message : '알 수 없는 오류'}`);
  }
  return errors;
}

export function validateStoryReferences(story: Story): string[] {
  const errors: string[] = [];
  const personaIds = new Set(story.personas.map((persona) => persona.id));
  const locationIds = new Set(story.locations.map((location) => location.id));
  const nodeIds = new Set(story.graph.nodes.map((node) => node.id));

  for (const id of duplicateIds(story.personas.map((persona) => persona.id))) errors.push(`중복 캐릭터 ID: ${id}`);
  for (const id of duplicateIds(story.locations.map((location) => location.id))) errors.push(`중복 장소 ID: ${id}`);
  for (const id of duplicateIds(story.graph.nodes.map((node) => node.id))) errors.push(`중복 노드 ID: ${id}`);
  for (const id of duplicateIds(story.graph.edges.map((edge) => edge.id))) errors.push(`중복 엣지 ID: ${id}`);
  for (const namespace of duplicateIds(story.variables.map((group) => group.namespace))) {
    errors.push(`중복 변수 namespace: ${namespace}`);
  }
  for (const group of story.variables) {
    for (const name of duplicateIds(group.variables.map((variable) => variable.name))) {
      errors.push(`${group.namespace}의 중복 변수 이름: ${name}`);
    }
  }

  if (!nodeIds.has(story.graph.startNodeId)) {
    errors.push(`시작 노드 ${story.graph.startNodeId}가 없습니다.`);
  }

  for (const node of story.graph.nodes) {
    if (!locationIds.has(node.locationId)) {
      errors.push(`노드 ${node.id}의 장소 ${node.locationId}가 없습니다.`);
    }
    for (const characterId of node.presentCharacters) {
      if (!personaIds.has(characterId)) {
        errors.push(`노드 ${node.id}의 캐릭터 ${characterId}가 없습니다.`);
      }
    }
    for (const line of node.scriptedLines) {
      if (!personaIds.has(line.speakerId)) {
        errors.push(`노드 ${node.id}의 대사 화자 ${line.speakerId}가 없습니다.`);
      }
      if (new Set(line.replyOptions).size !== line.replyOptions.length) {
        errors.push(`노드 ${node.id}에 중복 답변 후보가 있습니다.`);
      }
      if (node.playerInputMode === 'free-text' && line.replyOptions.length > 0) {
        errors.push(`노드 ${node.id}의 직접 입력 모드에는 답변 후보를 저장할 수 없습니다.`);
      }
      if (line.readyForChoice && line.replyOptions.length > 0) {
        errors.push(`노드 ${node.id}의 Choice 준비 대사에는 답변 후보를 저장할 수 없습니다.`);
      }
    }
    if (node.preGeneratedDialogue && (node.type !== 'dialogue' || node.dialogueMode !== 'pre-generation')) {
      errors.push(`노드 ${node.id}의 사전 생성 플로우는 Pre-generation Dialogue 노드에서만 사용할 수 있습니다.`);
    }
    if (node.type === 'end') {
      if (!node.endingSummary?.trim()) errors.push(`End 노드 ${node.id}의 결과 설명이 필요합니다.`);
      if (!node.endingKind) errors.push(`End 노드 ${node.id}의 엔딩 유형이 필요합니다.`);
      if (new Set(node.outcomeTags ?? []).size !== (node.outcomeTags ?? []).length) errors.push(`End 노드 ${node.id}에 중복 결과 태그가 있습니다.`);
      if (node.scriptedLines.length > 0) errors.push(`End 노드 ${node.id}는 scriptedLines를 사용할 수 없습니다.`);
      if (node.preGeneratedDialogue) errors.push(`End 노드 ${node.id}는 사전 생성 대화를 사용할 수 없습니다.`);
      if (node.choicePrompt) errors.push(`End 노드 ${node.id}는 선택 안내를 가질 수 없습니다.`);
      if (story.graph.edges.some((edge) => edge.from === node.id)) errors.push(`End 노드 ${node.id}는 outgoing Edge를 가질 수 없습니다.`);
      continue;
    }
    if (node.type === 'dialogue') {
      const outgoingEdges = story.graph.edges.filter((edge) => edge.from === node.id);
      if (outgoingEdges.length !== 1) errors.push(`Dialogue 노드 ${node.id}는 outgoing Edge를 정확히 하나 가져야 합니다.`);
      const outgoingTarget = story.graph.nodes.find((candidate) => candidate.id === outgoingEdges[0]?.to);
      if (outgoingTarget && outgoingTarget.type !== 'choice' && outgoingTarget.type !== 'end') {
        errors.push(`Dialogue 노드 ${node.id}는 Choice 또는 End 노드에만 연결할 수 있습니다.`);
      }
      const generated = node.preGeneratedDialogue;
      if (generated) {
        if (!personaIds.has(generated.speakerId) || !node.presentCharacters.includes(generated.speakerId)) {
          errors.push(`Dialogue 노드 ${node.id}의 생성 화자는 현재 등장인물이어야 합니다.`);
        }
        if (generated.flows.length !== generated.flowCount) errors.push(`Dialogue 노드 ${node.id}의 생성 플로우 수가 설정과 다릅니다.`);
        const flowIds = generated.flows.map((flow) => flow.id);
        if (new Set(flowIds).size !== flowIds.length) errors.push(`Dialogue 노드 ${node.id}에 중복 생성 플로우 ID가 있습니다.`);
        if (!flowIds.includes(generated.activeFlowId)) errors.push(`Dialogue 노드 ${node.id}의 활성 플로우가 없습니다.`);
        for (const flow of generated.flows) {
          if (flow.turns.length !== generated.turnCount) errors.push(`Dialogue 노드 ${node.id}의 ${flow.id} 턴 수가 설정과 다릅니다.`);
          for (const turn of flow.turns) {
            const replies = turn.replies.map((reply) => reply.content);
            if (new Set(replies).size !== replies.length) errors.push(`Dialogue 노드 ${node.id}의 ${flow.id}에 중복 유저 답변이 있습니다.`);
          }
        }
      } else {
        if (node.dialogueMode === 'pre-generation') {
          errors.push(`Pre-generation Dialogue 노드 ${node.id}에는 사전 생성 플로우가 필요합니다.`);
        }
        const readyIndexes = node.scriptedLines.flatMap((line, index) => line.readyForChoice ? [index] : []);
        if (readyIndexes.length > 1) errors.push(`Dialogue 노드 ${node.id}는 readyForChoice 대사를 하나만 가질 수 있습니다.`);
        if (readyIndexes.some((index) => index !== node.scriptedLines.length - 1)) {
          errors.push(`Dialogue 노드 ${node.id}의 readyForChoice 대사는 마지막 대사여야 합니다.`);
        }
        if (node.dialogueMode === 'scripted' && node.playerInputMode === 'reply-options') {
          for (const [index, line] of node.scriptedLines.entries()) {
            if (!line.readyForChoice && line.replyOptions.length < 2) errors.push(`Dialogue 노드 ${node.id}의 ${index + 1}번 대사에는 답변 후보 2개 이상이 필요합니다.`);
          }
        }
        if (node.dialogueMode === 'scripted' && node.scriptedLines.at(-1)?.readyForChoice !== true) {
          errors.push(`Scripted Dialogue 노드 ${node.id}의 마지막 대사는 readyForChoice=true여야 합니다.`);
        }
      }
      if ((node.dialogueMode === 'scripted' || node.dialogueMode === 'pre-generation') && node.playerInputMode !== 'reply-options') {
        errors.push(`${node.dialogueMode} Dialogue 노드 ${node.id}는 답변 후보 선택만 사용할 수 있습니다.`);
      }
    } else if (node.type === 'choice') {
      const outgoingEdges = story.graph.edges.filter((edge) => edge.from === node.id);
      if (outgoingEdges.length === 0) errors.push(`Choice 노드 ${node.id}에는 선택지가 하나 이상 필요합니다.`);
      const labels = outgoingEdges.map((edge) => edge.choiceLabel?.trim() ?? '');
      for (const [index, label] of labels.entries()) {
        if (!label) errors.push(`Choice 노드 ${node.id}의 ${index + 1}번 선택지 문구가 필요합니다.`);
      }
      const nonEmptyLabels = labels.filter(Boolean);
      if (new Set(nonEmptyLabels).size !== nonEmptyLabels.length) errors.push(`Choice 노드 ${node.id}에 중복 선택지가 있습니다.`);
      const prompt = node.choicePrompt;
      if (!prompt?.content.trim()) errors.push(`Choice 노드 ${node.id}의 선택 안내가 필요합니다.`);
      if (prompt?.speakerId && !node.presentCharacters.includes(prompt.speakerId)) {
        errors.push(`Choice 노드 ${node.id}의 안내 화자는 등장인물이어야 합니다.`);
      }
      if (node.scriptedLines.length > 0) errors.push(`Choice 노드 ${node.id}는 scriptedLines를 사용할 수 없습니다.`);
    }
    if (node.type !== 'choice' && node.choicePrompt) {
      errors.push(`${node.type} 노드 ${node.id}는 선택 안내를 가질 수 없습니다.`);
    }
  }

  for (const edge of story.graph.edges) {
    if (!nodeIds.has(edge.from)) errors.push(`엣지 ${edge.id}의 출발 노드 ${edge.from}이 없습니다.`);
    if (!nodeIds.has(edge.to)) errors.push(`엣지 ${edge.id}의 도착 노드 ${edge.to}이 없습니다.`);
    if (edge.from === edge.to) errors.push(`엣지 ${edge.id}는 노드를 자기 자신에게 연결할 수 없습니다.`);
    errors.push(...validateEdgeExpressions(story, edge));
  }

  for (const persona of story.personas) {
    const relationshipTargets = new Set<string>();
    for (const relationship of persona.relationships) {
      if (relationshipTargets.has(relationship.target)) {
        errors.push(`캐릭터 ${persona.id}의 중복 관계 대상: ${relationship.target}`);
      }
      relationshipTargets.add(relationship.target);
      if (relationship.target === persona.id) {
        errors.push(`캐릭터 ${persona.id}는 자기 자신을 관계 대상으로 지정할 수 없습니다.`);
      } else if (!personaIds.has(relationship.target)) {
        errors.push(`캐릭터 ${persona.id}의 관계 대상 ${relationship.target}이 없습니다.`);
      }
    }
  }

  return errors;
}

export function collectStoryErrors(story: Story): string[] {
  const schemaResult = StorySchema.safeParse(story);
  if (!schemaResult.success) {
    return schemaResult.error.issues.map((issue) => `Schema ${issue.path.join('.') || 'root'}: ${issue.message}`);
  }
  return validateStoryReferences(schemaResult.data);
}
