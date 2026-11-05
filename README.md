# ChapterFlow Generator

서사 개요와 원하는 결말을 입력받아 게임에서 실행할 분기 챕터 JSON을 만드는 TypeScript 생성기입니다. 웹 UI는 포함하지 않습니다. 각 사건의 허용된 심볼 변화, 진입 조건, 연결, 결말 조건을 함께 출력합니다.

## 실행

Node.js 22와 npm을 설치한 뒤 저장소를 내려받아 실행합니다.

```sh
git clone https://github.com/Evolutionary-Game-LAB/ChapterFlow-generator.git
cd ChapterFlow-generator
npm ci
npm run typecheck
npm test
npm run generate -- examples/request.json --validate-only
```

`examples/request.json`의 개요·결말·복잡도·모델을 수정합니다. `low / medium / high`는 선호 수준이며 정확한 노드 수를 보장하지 않습니다. 모델 ID는 사용하는 API 계정에서 지원되는 ID여야 합니다.

실제 생성은 유료 API 호출입니다. API 키는 JSON/소스/명령 인수에 적지 않고 `LLM_API_KEY` 환경 변수로만 전달합니다. 셸 기록에 키를 남기지 않도록 OS 또는 호스팅의 비밀값 입력 방식을 사용하세요.

```sh
npm run generate -- examples/request.json story.json
```

CLI는 기존 출력 파일을 덮어쓰지 않습니다. 실패·취소 시 완성 파일을 쓰지 않으며, 웹의 중간 경로 복원 UI는 포함하지 않습니다. 요청 시간 상한은 현재 45분입니다. 이 값은 일반적인 생성 시간이나 성공 보장이 아닙니다. 실제 API 비용은 선택 모델과 생성/복구 호출 수에 따라 달라집니다.

## 현재 파이프라인

1. 개요·결말에서 전체 이야기와 중요한 원인/결과를 작성합니다.
2. 필요한 심볼, 초기 상태와 결말 판정을 설계합니다.
3. 전체 이야기와 심볼을 바탕으로 사건·허용 플레이·진입 조건을 구성합니다.
4. 실행 구조 및 서사 일관성을 검사하고 필요한 부분을 보완합니다. 복잡도에 맞는 추가 분기는 기존 유효 경로를 보존하며 시도합니다.

진입점: `server/chapter-generation.ts`. API 새 생성 기본 경로는 `server/joint-story-generation.ts`입니다. 이전 `legacy`와 `story-first` 구현은 비교·재현과 내부 의존성을 위해 소스에 남아 있습니다. 이를 모두 새로운 기본 파이프라인이라고 소개하지 마세요. 기본값 외 경로는 연구용 환경 변수 `CHAPTER_PIPELINE`으로만 선택합니다.

## 출력과 엔진 연결

출력은 웹의 `schemaVersion: "0.6"` 전체 Story JSON입니다. 엔진의 실행 기준은 최상위 `gameplay` (`chapter-gameplay-v1`)입니다. `symbolic`과 `chapter`는 작성 원본이며, 플러그인이 서사를 재생성할 필요가 없습니다.

- `schemas/chapter-gameplay-v1.schema.json`: 구조적 JSON Schema
- `CONTRACT.md`: 상태/사건/신호의 의미와 웹·Unity 차이
- `public/examples/chapterflow-station.json`: 기존 웹 생성 예제. 새 생성 성능 검증 결과가 아닙니다.
- Unity 플러그인: [ChapterFlow-unity](https://github.com/Evolutionary-Game-LAB/ChapterFlow-unity). 생성한 JSON을 가져와 게임의 행동과 사건 진행에 연결합니다.
- 문제 보고: [Generator Issues](https://github.com/Evolutionary-Game-LAB/ChapterFlow-generator/issues)

## 검증 범위와 한계

기존 저장 챕터의 실행 회귀 테스트와 타입 검사를 제공하며, 의미가 자연스러운지·모든 사용자 입력에서 생성에 성공하는지는 보장하지 않습니다. 최초 전체 생성과 모든 모델 조합을 이 공개 준비 과정에서 새로 시험하지 않았습니다. 엔진과의 2026-11-03 비교 범위는 `VALIDATION.md`를 참조하세요.

이 패키지는 로컬 실행 라이브러리/CLI입니다. 임의 API endpoint를 받는 개발 서버를 그대로 인터넷에 공개하는 용도가 아닙니다. 공개 웹 호스팅용 제한된 서버는 별도로 준비되어 있습니다.

## 라이선스

이 프로젝트는 [Apache License 2.0](LICENSE)에 따라 배포됩니다. 외부 의존성은 각 패키지의 라이선스를 따릅니다. [THIRD-PARTY.md](THIRD-PARTY.md)를 참조하세요.
