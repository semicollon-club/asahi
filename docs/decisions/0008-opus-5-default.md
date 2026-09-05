---
status: Accepted
supersedes: 0003-opus-4-8-default
lastReviewed: 2026-09-05
---

# 0008. `claude-opus-5` 기본 모델

## 맥락

[0003](./0003-opus-4-8-default.md)은 기본 실행 모델을 `claude-opus-4-8` 로 고정하고, "설정한
모델"과 "SDK 가 실제로 실행한 모델"을 분리해 둘이 어긋나면 로그로 드러나게 하는 구조를 세웠다.
그 뒤 Opus 계열의 다음 세대인 Claude Opus 5(`claude-opus-5`)가 나왔고, 2026-09-05 운영자가 기본
모델을 그것으로 올리기로 결정했다. 시점은 부원이 디스코드만으로 동아리 저장소를 clone → 브랜치
작업 → push → main 에 PR 까지 하는 흐름이 실환경에서 확인된 직후다 — 그 흐름의 턴은 셸·git·PR
도구를 여러 번 잇는 장기 에이전트 작업이라, 상위 모델의 이득이 가장 크게 드러나는 자리다.

## 결정

`agent/src/config.ts` 의 `loadConfig` 기본값과 `agent/src/core/agent.ts` 의 `DEFAULT_MODEL` 을
`"claude-opus-5"` 로 바꾼다. `ANTHROPIC_MODEL` 환경변수 재정의는 그대로다. 스킬 실측 스크립트
`agent/src/scripts/skillProbe.ts` 도 같은 값을 쓴다. 0003 의 나머지 — 설정값을 SDK `query()` 에
그대로 전달하고, `runtime_info` 가 그 설정값을 보고하며, `init` 메시지의 실제 `model` 이 설정값과
다르면 `console.warn` 을 남기는 구조 — 는 바꾸지 않는다. 이 ADR 이 0003 을 대체하는 것은 기본값
하나이고, 드리프트 감지 구조는 그대로 이어받는다.

## 근거

- **모델 ID 는 `claude-opus-5` 하나다.** 날짜 접미사가 없는 고정 ID 로, `claude-opus-4-8` 과 같은
  체계다. 0003 의 드리프트 감지는 이 문자열과 `init.model` 의 정확한 일치를 보므로, 별칭(`opus`)이
  아니라 이 전체 ID 를 쓴다.
- **요청 표면이 4.8 과 같다.** 컨텍스트 1M·최대 출력 128K·adaptive thinking·프롬프트 캐시 등 기능
  집합이 같고, 4.7/4.8 에서 이미 사라진 것(`budget_tokens`·샘플링 파라미터·prefill)이 그대로 없다.
  이 앱은 `@anthropic-ai/claude-agent-sdk` 의 `query()` 에 모델 문자열만 넘기고 thinking·effort 를
  직접 지정하지 않으므로, 코드에서 바꿀 것은 모델 ID 뿐이다.
- **비용 축은 이 결정으로 바뀌지 않는다.** API 단가는 Opus 4.8 과 같다(입력 $5·출력 $25 / 1M 토큰).
  다만 이 봇은 API 키가 아니라 구독 OAuth 토큰(`CLAUDE_CODE_OAUTH_TOKEN`)으로 SDK 를 돌리므로 실제
  제약은 구독의 사용량 한도다 — 그것이 모델별로 어떻게 계산되는지는 이 ADR 이 단정하지 않는다.
- **알아 둘 차이 둘.** (1) Opus 5 는 `thinking` 을 지정하지 않으면 켜진 채로 돈다(4.8 은 꺼진
  채였다). 이 앱은 그 자리를 SDK 하네스에 맡기고 있어 코드 변경은 없지만, 턴당 지연과 토큰이 달라질
  수 있다 — 조절이 필요해지면 SDK `query()` 의 `effort` 옵션이 그 자리이고, 그것은 별도 결정이다.
  (2) Opus 5 의 안전 분류기가 요청을 거절할 수 있다(오류가 아니라 정상 응답의 `stop_reason:
  "refusal"`). 셸·보안 관련 대화에서 응답이 비거나 거절로 보이면 이 원인을 먼저 의심한다. Messages
  API 의 `fallbacks` 파라미터는 Agent SDK 의 `query()` 옵션에 없고, SDK 의 `fallbackModel` 은
  과부하·불가용 대체용이라 성격이 다르다 — 어느 쪽도 이 결정에 넣지 않는다. 두 모델이 섞여 돌면
  `runtime_info` 의 보고와 실제가 어긋나는 상태를 정상으로 만들기 때문이다.
- **응답 길이·서술량이 늘어나는 경향**이 알려져 있다(사용자 대면 응답이 길어지고, 에이전트 턴에서
  다음 행동을 더 자주 서술한다). 페르소나(`agent/src/core/persona.ts` 의 답변 품질 블록)로 다룰
  일이며 이 ADR 의 범위 밖이다 — 실사용에서 거슬리면 그때 조정한다.

## 결과

- 바뀐 파일: `agent/src/config.ts`, `agent/src/core/agent.ts`, `agent/src/scripts/skillProbe.ts`,
  테스트 픽스처·기대값(`agent/tests/config.test.ts`·`agent.test.ts`·`coreMulti.test.ts`·
  `failureSeam.test.ts`·`tools.test.ts`), `.env.example` 의 기본값 주석, 이 문서와 0003 의 status.
- **Railway 의 `ANTHROPIC_MODEL` 변수가 설정돼 있으면 그 값이 이긴다.** 비어 있거나
  `claude-opus-5` 여야 이 기본값이 실제로 적용된다 — 배포 전 확인 항목이다.
- **검증은 0003 이 만든 장치로 한다.** 배포 뒤 소유자가 `runtime_info` 로 `claude-opus-5` 를
  보고받고, 봇 로그에 `설정 모델(...) ≠ 실제 실행 모델(...)` 경고가 없어야 한다. 경고가 있으면
  구독·SDK 가 이 ID 를 다른 모델로 풀었다는 뜻이므로 원인을 좇는다.
