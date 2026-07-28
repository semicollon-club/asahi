---
title: 부원 오픈을 위한 관측 기반 — 작업 기록·진행 표시·폴더 조회
date: 2026-07-28
status: Approved
audience: 소유자(정본)
supersedes: —
supersededBy: —
---

# 부원 오픈을 위한 관측 기반

## 1. 배경 · 목표

2026-07-28에 동아리 미니PC가 공유 워커로 상시 가동에 들어갔다. 공개 서버 채널에서 파일·셸
작업이 실제로 돌고, 손님 폴더 격리도 실측으로 확인됐다(`deploy/smoke-test.md`). **구실은
갖춰졌다.**

부원을 들이기 전에 두 가지가 비어 있다.

**첫째, 부원이 무엇을 하다 막혔는지 아무 데도 남지 않는다.** `actions`·`logs` 테이블은 DDL 만
있고 0건이다(2026-07-28 확인). 진행 표시는 이벤트 버스를 거쳐 디스코드 메시지로 갔다가 사라지는
휘발성 값이라 저장되지 않는다. 이 상태로 열면 부원이 조용히 안 쓰게 됐을 때 원인을 추측으로만
알게 된다.

**둘째, 부원이 실패 이유를 알 수 없다.** 진행 표시가 `fs_read 완료` 한 줄이라 성패가 드러나지
않는다 — 실패해도 "완료"로 찍힌다. 부원이 "왜 안 됐는지" 알 수 있는 경로가 사실상 없다.

목표는 **열고 배우기 위한 최소 관측 기반**이다. 지금 로드맵을 짜는 일 자체가 추측으로 우선순위를
정하는 일인데, 이 문서의 범위를 끝내면 다음부터는 그럴 필요가 없다.

**설계 원칙 하나** — 부원에게 보여줄 이벤트와 소유자가 나중에 분석할 기록은 **같은 것**이다.
따로 만들면 두 벌이 되고 반드시 어긋난다. 이 저장소는 "안내와 실제가 어긋남"을 결함 유형으로
다룬다(`agent/src/core/persona.ts` 의 FIX4 주석).

이 작업은 기존 로드맵의 **2C(관측)** 및 **자기인지 조각B(작업 관찰)** 와 같은 기반을 쓴다
([../../status/ROADMAP.md](../../status/ROADMAP.md)). 새 축이 아니라 합류다.

## 2. 범위

**안**

1. 진행 이벤트에 성패·소요시간·결과 요약·입력을 싣는다
2. 그 이벤트를 `actions` 테이블에 기록한다
3. 진행 표시를 성패와 사유가 보이게 고친다
4. 폴더 구조 조회 전용 도구 `fs_tree` 를 추가한다
5. `/help` 에 손님용 항목을 추가한다

**밖** — 데이터가 쌓인 뒤 실제 질의를 보고 정한다. 지금 정하면 또 추측이다.

- 보존 정책, 집계 대시보드, `actions` 자기 조회 도구(조각B의 나머지)
- 스레드↔프로젝트 폴더 바인딩(다중 워커 2단계), 워커 다중화(현재 `shared` 1대 제한)
- `sh_exec` 출력 상한(30000자) 조정

## 3. 이벤트 모델

현재 `ProgressUpdate`(`agent/src/core/agent.ts`)는 표시 전용이다.

```ts
| { kind: "tool"; name: string; input?: string }
| { kind: "tool_result"; name?: string }     // 성패도, 시간도, 결과도 없다
| { kind: "answering" }
```

`progressFromMessage` 는 `tool_result` 블록에서 `tool_use_id` 만 읽고 나머지를 버린다. SDK 블록에
함께 오는 `is_error`·`content` 가 정확히 `actions.status`·`actions.result_summary` 에 필요한
값이다.

**변경 — `tool_result` 를 확장한다.**

```ts
| { kind: "tool_result"; name?: string; input?: string; ok: boolean;
    summary?: string; durationMs?: number }
```

| 필드 | 출처 | 쓰이는 곳 |
|---|---|---|
| `ok` | 블록의 `is_error` 반전 | 표시(`✓`/`✗`) + `actions.status` |
| `summary` | 블록 `content` 앞 200자 | 표시(무슨 결과였나) + `actions.result_summary` |
| `durationMs` | `tool` 이벤트 시각과의 차 | 표시(느린 작업 인지) + `actions.duration_ms` |
| `input` | 짝지어진 `tool` 이벤트의 값 | `actions.input` |

**`actions` 스키마는 손대지 않는다.** 조각B 용으로 설계됐다가 배선되지 않은 채 남아 있었고,
모양이 이미 정확히 맞는다.

```
tool ← name          input ← summarizeToolInput      result_summary ← summary
status ← ok          duration_ms ← durationMs        conversation_id·user_id ← TurnContext
```

**미확인 — 구현 시 실물로 확인한다.** SDK 의 `tool_result` 블록에 `is_error` 가 실제로 실려 오는지는
지금 코드가 읽지 않아 확인된 바 없다. 오지 않으면 `ok` 를 선택 필드로 두고 표시만 degrade 시킨다
(기록은 `status='done'`). **추측으로 구현하지 않는다.**

## 4. 배선

```
SDK 스트림 → progressFromMessage(agent.ts) → onProgress(u) → core.ts
  ├→ ① bus.publish("progress")  → 디스코드 상태 메시지   (기존 그대로)
  └→ ② actions.record()                                  (신규, tool_result 일 때만)
```

**결정 다섯 가지.**

1. **짝짓기는 `agent.ts` 에서 한다.** `input` 은 `tool` 이벤트에만 있어 그대로면 한 행을 채울 수
   없다. `pendingToolNames: Map<string, string>` 을 `Map<string, { name; input; startedAt }>` 로
   바꿔 `tool_use_id` 로 짝짓는다. **id 가 있는 곳에서 짝지어야 한다** — core.ts 가 이름만 보고
   다시 추측하면 같은 도구를 연달아 부를 때 어긋난다.

2. **기록은 `core.ts` 의 `runConversationTurn` 에서.** 그 `onProgress` 클로저가 이미 `conv.id` 와
   `userId` 를 들고 있어 새 배선이 필요 없다.

3. **`ActionsRepo` 신규**(`agent/src/store/actionsRepo.ts`). 기존 리포 패턴 그대로. `CoreRepos` 에
   추가한다 — 2026-07-28 에 `allowedDirs` 로 한 것과 같고, 이제 `npm run typecheck` 가 테스트의
   가짜 repos 누락을 잡아 준다.

4. **실패 격리.** 기록이 턴을 죽이면 안 된다. `void actions.record(...).catch(...)` 로 띄운다 —
   `hub.ts` 의 `touchLastSeen` 과 같은 패턴이다.

5. **`tool_result` 만 기록한다.** `answering` 은 잡음이고, `tool` 은 짝이 맞춰져 한 행에 흡수된다.
   **도구 호출 1건 = 1행.**

## 5. 진행 표시

디스코드 쪽 UI 는 이미 충분하다 — 상태 메시지에 라인을 누적하고, 800ms 스로틀, 연속 중복 접기,
최근 12줄 제한(`agent/src/adapters/discord.ts`). **부족한 건 UI 가 아니라 한 줄의 내용이다.**
바뀌는 것은 `formatProgress`(`core.ts`) **한 함수**이고 어댑터는 손대지 않는다.

**현재**

```
· fs_read("C:\asahi-workspace\1517428698368704650\a.txt")
· fs_read 완료
```

**변경 후**

```
· fs_read a.txt
· ✓ fs_read — 1.2KB (0.3초)
· ✗ fs_write — 허용된 폴더 밖 경로예요
```

- **`✗` 와 사유가 핵심이다.** 지금은 실패해도 `완료` 로 찍힌다.
- **경로는 그 사용자의 폴더 기준 상대경로로 줄인다.** 긴 절대경로가 12줄 예산을 잡아먹는 것을
  막고, 부원에게 자기 폴더 안이라는 사실이 자연스럽게 드러난다.

## 6. `fs_tree` — 폴더 구조 조회

**왜 프롬프트 지침이 아니라 도구인가.** 프롬프트로 "폴더 구조를 물으면 `fs_glob` 으로 조회해
트리로 보여줘"라고 적으면, 모델이 **조회하기로 선택하고** 결과를 **정확히 옮긴다**는 두 번의
기대에 의존하게 된다. 2026-07-28 게이트 점검에서 모델은 도구를 부르지 않고 자기 판단으로
답해버렸다(그때는 거절이었다). 폴더 구조에서 같은 일이 벌어지면 **그럴듯한 가짜 트리**가 나오고,
세션이 길어질수록 확률이 올라간다. 도구는 그 선택지를 없앤다.

성능 측면도 같다. 기억으로 재구성하는 것보다 도구 출력을 그대로 전달하는 쪽이 모델이 덜 고민하는
작업이라, 한 세션에 쌓이는 추론 부담이 줄어 세션 품질이 오래 유지된다.

**게이팅은 새로 만들지 않고 기존 경로에 얹는다.** `path` 인자를 받으므로 `remoteToolHandler` 의
1차 필터(`allowed_dirs` + `scopeDirs`)와 워커의 `checkPath` 를 그대로 탄다.

**함정 — `fs_glob` 과 동일하게 취급해야 한다.** `remoteTools.ts` 의 `needsPathCheck` 는 `path`
인자가 있거나 `LOCAL_TOOL_NAME` 에 등록된 도구일 때만 참이다. `fs_tree` 를 그냥 추가하면 **`path`
를 생략했을 때 1차 필터가 통째로 스킵된다** — `fs_glob` 이 겪었던 FIX6 취약점과 같은 구멍이다.
따라서:

- `path` 가 없어도 검사를 타게 한다
- 생략 시 검사에 쓴 `allowed[0]` 을 **실제 args 에 주입**해, 워커가 자기 `roots[0]` 을 기본값으로
  쓰지 못하게 한다(FIX1 과 같은 이유)

**워커 쪽에서 지킬 것.**

- **심볼릭 링크를 따라가지 않는다.** 재귀 순회는 링크 하나로 워크스페이스 밖을 열거할 수 있다.
  `withFileTypes` 로 링크를 건너뛰거나, 내려가기 전에 `checkPath` 로 재검사한다. `fs_read` 에는
  없던 새 위험이다 — 그건 한 파일만 열지만 `fs_tree` 는 걸어다닌다.
- **상한 셋**: 깊이는 인자로 조절하되 **기본 3·최대 5**, 항목 수 **500개**, 그리고
  `executors.ts` 의 `OUTPUT_MAX`(30000자). 셋 중 먼저 걸리는 것에서 멈춘다.
- **잘렸으면 명시한다.** 조용히 자르면 부원이 "폴더가 비었네"로 오해한다.
- **`node_modules`·`.git` 기본 제외.** 코딩 동아리라 이게 없으면 출력이 즉시 상한을 친다.

**워커 재배포가 필요하다** — 미니PC 에서 `git pull` + `npm ci` + 작업 재시작. 로테이션 작업
(`asahi-worker-logrotate`)이 이미 stop/start 를 하므로 재시작 수단은 있다.

## 7. `/help` 손님 항목

도구가 있어도 **그렇게 물어봐도 된다는 사실**을 모르면 쓰이지 않는다. `renderCommandHelp`
(`agent/src/core/commands.ts`)에 손님이 쓸 수 있는 것을 한 묶음 추가한다 — 자기 폴더 조회, 파일
작업, 셸 실행. 소유자 전용 항목과 섞이지 않게 신원에 따라 갈라 보여준다.

## 8. 테스트 계획

이 저장소는 테스트 우선을 기대한다(`CONTRIBUTING.md`). 순수 함수로 뗄 수 있는 것은 떼고,
실패하는 테스트를 먼저 쓴다.

| 대상 | 방식 |
|---|---|
| `progressFromMessage` 확장 | 순수 함수 — `is_error` 유무, 짝짓기, 같은 도구 연속 호출 |
| `formatProgress` 확장 | 순수 함수 — `✓`/`✗`, 사유, 상대경로 축약, 시간 표기 |
| `ActionsRepo` | pg-mem — 기록·조회 |
| 코어 배선 | `coreMulti.test.ts` — 도구 호출 1건이 1행이 되는지, 기록 실패가 턴을 죽이지 않는지 |
| `fs_tree` 렌더링 | 순수 함수 — 깊이·상한·잘림 표시·제외 목록 |
| `fs_tree` 실행기 | 임시 폴더 — **심볼릭 링크 탈출 거부** 포함 |
| `fs_tree` 게이팅 | `remoteTools.test.ts` — `path` 생략 시 필터를 타는지, `allowed[0]` 이 args 에 주입되는지 |

`npm run typecheck` 와 `npm test` 를 함께 통과시킨다.

## 9. 순서

**M1 — 오픈 전**

1. `tool_result` 확장 + 짝짓기(§3·§4)
2. `ActionsRepo` + 코어 배선(§4)
3. `formatProgress` 개선(§5)
4. `fs_tree`(§6) — **미니PC `git pull` + 재시작 포함**
5. `/help` 손님 항목(§7)
6. 오픈

**M2 — 오픈 후, 데이터로 결정**

`actions` 를 열어 실제 병목을 본다: 어떤 도구가 자주 실패하는가, 어디서 느린가, 부원이 어디서
멈추는가. §2 "밖" 항목의 우선순위를 그 데이터로 정한다.

## 10. 위험 · 미확인

- **`is_error` 존재 여부**(§3) — 구현 시 실물 확인. 없으면 표시만 degrade.
- **기록량** — 도구 호출 1건 = 1행. 개인 연습 규모에서는 문제되지 않을 것으로 보나, 보존 정책이
  없으므로 M2 에서 실측 후 판단한다.
- **`fs_tree` 의 심볼릭 링크**(§6) — 이 문서에서 유일하게 새로 생기는 보안 표면이다. 테스트로
  고정한다.
- **워커 재배포 누락** — 미니PC 를 갱신하지 않으면 `fs_tree` 만 조용히 실패한다. M1 체크리스트에
  명시했다.
