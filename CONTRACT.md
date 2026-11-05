# ChapterFlow 웹–엔진 실행 계약 (2026-11-03)

## 데이터

전체 Story는 `schemaVersion: "0.6"`, 실행 객체는 `gameplay.format: "chapter-gameplay-v1"`입니다. Unity는 전체 JSON 또는 gameplay 객체를 읽습니다. 웹 Import는 전체 Story를 요구하며 gameplay-only 예제를 웹에 Import하면 안 됩니다.

| 필드 | 의미 |
|---|---|
| `startEventId` | 최초 시작할 사건 ID |
| `initialState[].ref/value` | symbol과 args 조합으로 식별되는 최초 값 |
| `addedSymbols` | 수동 추가 심볼의 이름, 형식, 초기값, 변경 방식 |
| `events[].entryCondition.all` | 공통 AND 진입 조건 |
| `entryAlternatives` | AND 그룹 사이 OR. 공통 조건도 만족해야 함 |
| `signals[].condition` | 해당 행동의 현재 상태 사전 조건 |
| `signals[].effects` | set 또는 add. 기존 허용된 변화만 실행 |
| `signals[].oncePerVisit` | 이번 방문의 재실행 금지 |
| `exits[].to/condition` | 연결된 다음 사건과 경로별 조건 |
| `exits[].requiredSignal` | 생성 검증용 기존 신호 ID. 특정 신호 영수증을 실제 진입의 필수로 요구하지 않음 |
| `events[].endingId`, `endings[].condition` | 결말 진입 시 정확히 하나의 결말이 성립해야 함 |

심볼 key는 `JSON.stringify([symbol, ...args])`와 동일한 문자열입니다. C#에서는 `ChapterDefinition.SymbolKey`로 만듭니다. 값은 boolean 또는 0..1 숫자이며 내부 정수 0..100으로 계산합니다. 숫자는 소수 둘째 자리 정밀도, add는 0..1 범위로 제한됩니다. `addedSymbols.changeMode: irreversible`은 최초 실제 변경 뒤 재변경을 금지합니다.

JSON Schema는 구조 검사만 제공합니다. 존재하지 않는 ref, 타입 모순, guard 연산자 조합, 두 자리 숫자 정밀도, 경로/결말 도달성은 별도 TypeScript/C# 검증 대상입니다. 스키마 통과를 이야기 개연성 보장으로 설명하지 않습니다.

## 상태 전이

1. Load는 초기값을 만든다. 사건 시작이나 효과를 자동 적용하지 않는다.
2. 시작 트리거는 직전 사건과 연결되어 있고 현재 진입 조건을 만족할 때만 성공한다.
3. 게임 행동은 현재 사건의 허용 신호/심볼만 변경한다. 다음 사건을 자동 시작하지 않는다.
4. 사건 종료는 게임이 요청하며 다음 사건 조건으로 막지 않는다.
5. 종료 후 상태 조건을 만족하는 연결 사건 중 게임이 요청한 사건을 시작한다.

웹의 다음 사건 버튼은 4+5를 미리 검사하여 둘 다 가능한 경우에 함께 반영하는 UI 편의입니다. Unity는 별도 API로 제공합니다.

## 이번 정합 보완

0.1.0 플러그인은 묶음 신호만 제공하여 최근 웹의 심볼별 버튼과 조작 단위가 달랐습니다. 0.1.1 공개 준비본에 단일 심볼 실행과 부분 실행 저장을 추가했습니다. 원본 웹의 생성 규칙/JSON은 수정하지 않았고 기존 Unity 게임 프로젝트도 덮어쓰지 않았습니다. 공개 준비 패키지를 원래 게임에 설치하는 것은 별도 단계입니다.

## 검증 경계

저장된 챕터 2종, 기존 설계 경로의 전체 신호/심볼별 재생, 합성 실패/숫자/되돌림 불가/OR 조건 테스트를 비교했습니다. 테스트 집합 밖의 모든 상태 조합이나 자유 입력 서사 개연성을 증명하는 것은 아닙니다. 엔진의 진행 저장 형식은 웹 편집 저장과 별개입니다.
