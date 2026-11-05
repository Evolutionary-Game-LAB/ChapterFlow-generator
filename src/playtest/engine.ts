import type { Story, StoryEdge } from '../schema.js';

export type Primitive = boolean | number | string;
export type VariableState = Record<string, Record<string, Primitive>>;

type Operator = '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | '!';
type Token =
  | { type: 'value'; value: Primitive }
  | { type: 'reference'; value: string }
  | { type: 'operator'; value: Operator }
  | { type: 'paren'; value: '(' | ')' };

export function createInitialVariables(story: Story): VariableState {
  return Object.fromEntries(
    story.variables.map((group) => [
      group.namespace,
      Object.fromEntries(group.variables.map((variable) => [variable.name, variable.default])),
    ]),
  );
}

function resolveVariable(state: VariableState, reference: string): Primitive {
  const parts = reference.split('.');
  if (parts.length !== 2) throw new Error(`지원하지 않는 변수 참조입니다: ${reference}`);
  const [namespace, name] = parts;
  if (!Object.hasOwn(state, namespace) || !Object.hasOwn(state[namespace], name)) {
    throw new Error(`존재하지 않는 변수입니다: ${reference}`);
  }
  return state[namespace][name];
}

function parseLiteral(value: string): Primitive {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { throw new Error(`지원하지 않는 값입니다: ${value}`); }
  }
  const singleQuoted = trimmed.match(/^'(.*)'$/s);
  if (singleQuoted) return singleQuoted[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  throw new Error(`지원하지 않는 값입니다: ${value}`);
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) { index += whitespace[0].length; continue; }

    const operator = rest.match(/^(&&|\|\||==|!=|<=|>=|<|>|!)/);
    if (operator) { tokens.push({ type: 'operator', value: operator[0] as Operator }); index += operator[0].length; continue; }
    if (rest[0] === '(' || rest[0] === ')') { tokens.push({ type: 'paren', value: rest[0] }); index += 1; continue; }

    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0];
      let cursor = 1;
      let escaped = false;
      while (cursor < rest.length) {
        const character = rest[cursor];
        if (!escaped && character === quote) break;
        escaped = !escaped && character === '\\';
        if (character !== '\\') escaped = false;
        cursor += 1;
      }
      if (cursor >= rest.length) throw new Error(`지원하지 않는 조건식입니다: ${expression}`);
      const raw = rest.slice(0, cursor + 1);
      tokens.push({ type: 'value', value: parseLiteral(raw) });
      index += raw.length;
      continue;
    }

    const number = rest.match(/^-?\d+(?:\.\d+)?/);
    if (number) { tokens.push({ type: 'value', value: Number(number[0]) }); index += number[0].length; continue; }
    const keyword = rest.match(/^(true|false)\b/);
    if (keyword) { tokens.push({ type: 'value', value: keyword[0] === 'true' }); index += keyword[0].length; continue; }
    const reference = rest.match(/^[A-Za-z_]\w*\.[A-Za-z_]\w*/);
    if (reference) { tokens.push({ type: 'reference', value: reference[0] }); index += reference[0].length; continue; }
    throw new Error(`지원하지 않는 조건식입니다: ${expression}`);
  }
  return tokens;
}

class ConditionParser {
  private index = 0;
  constructor(private readonly tokens: Token[], private readonly state: VariableState) {}

  parse(): boolean {
    const result = this.parseOr(true);
    if (this.index !== this.tokens.length) throw new Error('지원하지 않는 조건식입니다: 남은 토큰이 있습니다.');
    return result;
  }

  private parseOr(evaluate: boolean): boolean {
    let value = this.parseAnd(evaluate);
    while (this.matchOperator('||')) {
      const right = this.parseAnd(evaluate && !value);
      if (evaluate) value ||= right;
    }
    return value;
  }

  private parseAnd(evaluate: boolean): boolean {
    let value = this.parseUnary(evaluate);
    while (this.matchOperator('&&')) {
      const right = this.parseUnary(evaluate && value);
      if (evaluate) value &&= right;
    }
    return value;
  }

  private parseUnary(evaluate: boolean): boolean {
    if (this.matchOperator('!')) return evaluate ? !this.parseUnary(true) : this.parseUnary(false);
    if (this.matchParen('(')) {
      const value = this.parseOr(evaluate);
      if (!this.matchParen(')')) throw new Error('지원하지 않는 조건식입니다: 닫는 괄호가 없습니다.');
      return value;
    }
    return this.parseComparison(evaluate);
  }

  private parseComparison(evaluate: boolean): boolean {
    const left = this.parseOperand(evaluate);
    const token = this.tokens[this.index];
    if (!token || token.type !== 'operator' || !['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
      if (!evaluate) return false;
      if (typeof left !== 'boolean') throw new Error('비교 연산자가 없는 값은 boolean이어야 합니다.');
      return left;
    }
    this.index += 1;
    const right = this.parseOperand(evaluate);
    if (!evaluate) return false;
    const evaluatedLeft = left as Primitive;
    const evaluatedRight = right as Primitive;
    if (typeof evaluatedLeft !== typeof evaluatedRight) throw new Error('조건식 변수와 값의 타입이 일치하지 않습니다.');
    if (['<', '<=', '>', '>='].includes(token.value) && typeof evaluatedLeft === 'boolean') {
      throw new Error('boolean 값에는 순서 비교 연산자를 사용할 수 없습니다.');
    }
    switch (token.value) {
      case '==': return evaluatedLeft === evaluatedRight;
      case '!=': return evaluatedLeft !== evaluatedRight;
      case '<': return evaluatedLeft < evaluatedRight;
      case '<=': return evaluatedLeft <= evaluatedRight;
      case '>': return evaluatedLeft > evaluatedRight;
      case '>=': return evaluatedLeft >= evaluatedRight;
      default: throw new Error(`지원하지 않는 비교 연산자입니다: ${token.value}`);
    }
  }

  private parseOperand(evaluate: boolean): Primitive | undefined {
    const token = this.tokens[this.index++];
    if (!token) throw new Error('지원하지 않는 조건식입니다: 값이 없습니다.');
    if (token.type === 'value') return token.value;
    if (token.type === 'reference') return evaluate ? resolveVariable(this.state, token.value) : undefined;
    throw new Error('지원하지 않는 조건식입니다: 값이 필요합니다.');
  }

  private matchOperator(value: '&&' | '||' | '!'): boolean {
    const token = this.tokens[this.index];
    if (token?.type === 'operator' && token.value === value) { this.index += 1; return true; }
    return false;
  }

  private matchParen(value: '(' | ')'): boolean {
    const token = this.tokens[this.index];
    if (token?.type === 'paren' && token.value === value) { this.index += 1; return true; }
    return false;
  }
}

export function evaluateCondition(state: VariableState, expression?: string): boolean {
  if (!expression?.trim()) return true;
  return new ConditionParser(tokenize(expression), state).parse();
}

export function applyEffect(state: VariableState, expression?: string): VariableState {
  if (!expression?.trim()) return structuredClone(state);
  const match = expression.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*(.+)$/s);
  if (!match) throw new Error(`지원하지 않는 효과식입니다: ${expression}`);
  const [, namespace, name, rawValue] = match;
  if (!Object.hasOwn(state, namespace) || !Object.hasOwn(state[namespace], name)) {
    throw new Error(`존재하지 않는 변수입니다: ${namespace}.${name}`);
  }
  const next = structuredClone(state);
  const value = parseLiteral(rawValue);
  if (typeof value !== typeof next[namespace][name]) {
    throw new Error(`변수 타입이 일치하지 않습니다: ${namespace}.${name}`);
  }
  next[namespace][name] = value;
  return next;
}

export function getAvailableEdges(story: Story, nodeId: string, state: VariableState): StoryEdge[] {
  return story.graph.edges.filter(
    (edge) => edge.from === nodeId && evaluateCondition(state, edge.condition),
  );
}
