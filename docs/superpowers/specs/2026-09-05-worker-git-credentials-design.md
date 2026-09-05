---
lastReviewed: 2026-09-05
---

# 워커 git 자격증명·PR 생성 — 설계

## 1. 무엇을 고치는가

**디스코드로는 동아리 저장소 작업이 반만 됐다.** 부원이 아사히로 할 수 있는 깃허브 작업은
`publish_project`(새 리포 생성 + 자기 프로젝트 push)와 `restore_project`(그 리포 clone)뿐이었다.
그 밖의 모든 것 — 기존 동아리 저장소(`homepage` 등)를 받아 브랜치에서 고치고 push 하고 PR 을
내는 당연한 흐름 — 은 불가능했다. 원인은 셋이었다.

1. 워커에 깃허브 자격증명이 없다(의도된 설계 — `2026-08-07-github-publish-design.md` §3). 그래서
   `sh_exec` 의 `git push` 는 항상 실패했고, `GIT_TERMINAL_PROMPT` 도 꺼져 있지 않아 자격증명
   프롬프트를 기다리다 `sh_exec` 타임아웃까지 매달릴 수 있었다.
2. `publish_project` 는 `projects` 표에 있는(=아사히가 만든) 리포에만 push 한다. 기존 리포는 표에
   없어 새 리포 생성을 시도하다 "이름이 이미 있다"로 끝났고, `restore_project` 는 "올린 적 없다"로
   거절했다. 표에 넣는 경로도 없었다.
3. 재발행 절차에 fetch 가 없어, 원격이 다른 곳에서 먼저 바뀌거나 폴더를 되받기 없이 다시 만들면
   push 가 non-fast-forward 로 거절됐고 영문 git 오류만 올라갔다.

운영자의 결정(2026-09-05): **부원이 동아리 저장소를 clone → 자기 워크스페이스에서 작업 → 커밋 →
push → main 에 PR 까지는 디스코드만으로 되어야 한다. 봇은 PR 까지만 한다 — 병합은 사람이 깃허브에서
한다.** 브랜치 정책은 깃허브가 집행한다: `main` 은 부원이 PR 로 자유롭게 쌓는 통합 브랜치(CI 필수·
강제 push 금지), `production` 은 운영자만 push·병합할 수 있고 App 도 허용 목록 밖이다(`asahi`·
`homepage` 둘 다 API 로 확인).

## 2. 자격증명 모델 — 무엇이 바뀌고 무엇이 그대로인가

**그대로인 것**: 영구 자격증명(GitHub App 개인키)은 봇(Railway)에만 있다. 미니PC 디스크·`.env`·
git 설정에는 아무것도 남지 않는다. 워커의 `.env` 는 한 줄도 바뀌지 않는다.

**바뀐 것**: 봇이 `sh_exec` 호출마다 **단기 설치 토큰**을 `git` 인자에 실어 보내고, 워커는 그것을
그 셸 프로세스의 **환경변수로만** 얹는다(`agent/src/remote/gitEnv.ts`). git 은 `GIT_CONFIG_COUNT`
규약으로 받은 자격증명 헬퍼가 그 변수를 읽어 인증한다. 프로세스 트리가 끝나면 사라진다.

| | 발행 토큰(기존) | 셸 토큰(신설) | PR 토큰(신설) |
|---|---|---|---|
| 발급 주체 | 봇 | 봇 | 봇 |
| 리포 범위 | 그 리포 하나 | **조직 전체** | 그 리포 하나 |
| 권한 | `contents:write` | `contents:write` | `pull_requests:write` |
| 수명 | 최대 1시간, 호출마다 새로 | 최대 1시간, 봇이 캐시해 약 50분 재사용 | 최대 1시간, 호출마다 새로 |
| 어디까지 가는가 | 워커의 git 프로세스 env | 워커의 셸 프로세스 트리 env | 봇 안에서만 |

셸 토큰이 조직 전체인 이유: 어느 리포를 건드릴 셸 명령인지 미리 알 수 없고, "동아리 저장소
아무것이나 다룬다"가 목적이라 좁힐 축이 없다. 캐시하는 이유: `sh_exec` 는 대부분 git 과 무관한
명령이라 호출마다 발급하면 그 전부가 깃허브 API 왕복을 문다(`agent/src/github/shellToken.ts` —
만료 10분 전 재발급, 실패 60초 냉각, 동시 호출은 한 발급을 나눠 쓴다). 셸 토큰에 `pull_requests`
를 넣지 않는 이유: App 에 그 권한이 아직 없으면 발급 자체가 실패해 git push 까지 막힌다. PR 은 봇이
REST 로 만들므로 git 이 그 권한을 쓸 일이 없다.

## 3. 위협 판단 — 정직하게

- **부원은 `sh_exec` 로 그 토큰을 읽을 수 있다**(환경변수를 찍으면 된다). 그러면 한 시간 동안
  디스코드 밖에서 조직 리포에 `contents:write` 를 갖는다. 이것은 새로 생긴 능력이 아니라 **디스코드
  안에서 이미 허용하기로 한 것과 같은 능력**이다 — 브랜치 push·강제 push·브랜치 삭제는 `sh_exec`
  로 어차피 된다. 잃는 것은 `actions` 기록(관측)뿐이고, 깃허브 쪽에는 App 이름으로 감사 로그가 남는다.
  발행 설계 §11 이 "푸시가 도는 동안의 토큰 관찰"로 이미 받아들인 위험의 시간 창이 몇 초에서 한
  시간으로, 대상이 리포 하나에서 조직 전체로 늘어난 것이다(`docs/security/risk-register.md` §9).
- **개인키의 천장은 변하지 않는다.** 토큰이 새도 키는 새지 않는다. 리포 생성·삭제(`administration`)는
  키를 쥔 봇만 할 수 있고, 그 키는 Railway 에만 있다.
- **브랜치 규칙은 깃허브가 집행하고, 봇은 그 위에 아무것도 더하지 않는다.** `production` 은 push
  가능자가 운영자로 제한돼 있어 이 토큰으로도 올릴 수 없다(App 은 허용 목록 밖 — 2026-09-05 확인).
  `main` 은 부원이 PR 로 쌓는 통합 브랜치라 일부러 열려 있다(CI 필수·강제 push 금지만). 봇 자신이
  main 에 직접 push 하지 않는 것은 **페르소나 안내**뿐이다(`agent/src/core/persona.ts`) — 셸 명령을
  검사해 `git push origin main` 을 거르는 것은 이 리포가 반복해서 거부해 온 "시늉하는 방어"라 하지
  않는다. 조직은 Free 플랜이라 **비공개** 리포에는 어떤 브랜치 보호도 걸 수 없다는 점은 알아 둔다 —
  지금은 비공개 리포에 지킬 브랜치가 없지만, 생기면 공개 전환이나 GitHub Team 이 선택지다.

## 4. 구성 요소

| 조각 | 위치 | 하는 일 |
|---|---|---|
| 셸 토큰 공급원 | `agent/src/github/shellToken.ts` | 조직 전체 `contents:write` 토큰을 발급·캐시 |
| git 인자 주입 | `agent/src/core/remoteTools.ts` `shellGitArgs` | `sh_exec` 호출에 토큰(또는 사유)·커밋 신원을 싣는다. 모델이 준 `git` 키는 덮어쓴다 |
| 자식 환경 | `agent/src/remote/gitEnv.ts` `shellGitEnv` | `GIT_TERMINAL_PROMPT=0`, 헬퍼 체인 초기화 + 우리 헬퍼, `user.name`/`user.email`, 토큰 또는 사유 변수 |
| 워커 실행기 | `agent/src/remote/executors.ts` `sh_exec` | 위 env 를 `spawn` 에 얹는다. 명령 문자열은 건드리지 않는다 |
| PR 생성 | `agent/src/core/tools.ts` `createPullRequestHandler` + `agent/src/github/appToken.ts` `createPullRequest` | 리포·브랜치 검증 → 그 리포 `pull_requests:write` 토큰 → `POST /repos/{org}/{repo}/pulls`. base 기본 `main`, `production` 은 소유자만 |
| 발행의 원격 맞추기 | `agent/src/remote/gitPublish.ts` `alignWithRemote` | fetch 후 로컬에 커밋이 없으면 `reset --soft FETCH_HEAD`, 원격이 앞서면 멈추고 안내 |
| 모델 안내 | `agent/src/core/persona.ts` `PUBLISH_LINES` | 기존 저장소는 git 으로, 새 브랜치 → push → `create_pull_request`, main·production 직접 push 금지, `git config` 금지 |

토큰이 없을 때(깃허브 미설정·발급 실패·옛 봇) 헬퍼는 자격증명 대신 **사유를 stderr 로** 말하고
git 은 프롬프트 없이 즉시 실패한다 — 2026-09-05 운영자 PC 실측(cmd.exe 경유, Git 2.55):
`아사히: 깃허브 자격증명이 없어요 — …` 다음 줄에 `fatal: could not read Username … terminal prompts
disabled`, 종료 코드 128.

봇과 워커는 따로 배포된다(봇은 `production` 브랜치, 워커는 `main` 자동 갱신). 어느 쪽이 먼저 새
코드가 되어도 안전하다 — 옛 워커는 `git` 인자를 무시하고(자격증명 없이 예전처럼 실패), 옛 봇을 만난
새 워커는 프롬프트만 끄고 기본 사유를 말한다.

## 5. 왜 이 방식인가 — 고르지 않은 것

| | 방식 | 왜 아닌가 |
|---|---|---|
| A | 미니PC 에 영구 자격증명(GCM 로그인·SSH 키) | 발행 설계 §3 을 깬다. 키가 새면 영구히 샌다 |
| B | 워커 안 로컬 HTTP 서버 + 헬퍼 스크립트가 push 순간에만 봇에게 리포별 토큰을 요청 | 토큰 노출 창이 가장 짧고 리포별로 좁힐 수 있다. 대신 워커→봇 역방향 프레임·로컬 리스너·헬퍼 파일·sh 인용이 새로 생겨 미니PC 에서 깨질 자리가 넷 늘어난다. 얻는 것은 "부원이 한 시간짜리 토큰을 읽지 못한다"인데 §3 대로 그건 이미 허용한 능력이다 |
| C | 봇이 `sh_exec` 명령을 검사해 `git push origin main` 을 거른다 | 시늉하는 방어(스크립트 파일·별칭·다른 리모트 이름으로 우회). 다음 사람이 진짜 경계로 착각한다 |
| D | `gh` CLI 를 워커에 두고 `GH_TOKEN` 으로 PR 까지 셸에서 | 미니PC 에 gh 설치·갱신이 하나 더 생기고, 셸 토큰에 `pull_requests` 를 더해야 해 App 권한이 없을 때 git push 까지 막힌다 |
| E | `git -c` 로 명령 문자열을 재작성 | 모델의 명령을 봇이 고쳐 쓰면 cmd.exe 인용 경계가 깨진다(`docs/agent-onboarding.md` 5절). 환경변수 규약은 명령을 건드리지 않는다 |

## 6. 운영자가 해야 하는 것(코드 밖)

1. **GitHub App 권한 추가와 설치 승인** — `asahi-publisher` 에 `Pull requests: Read and write`.
   2026-09-05 에 App 쪽에는 추가됐지만 **조직 설치가 새 권한을 승인해야** 토큰에 반영된다(승인 전
   설치 권한은 `administration`·`contents`·`metadata` 그대로다). 절차는 `deploy/github-app-셋업.md`
   §권한. 승인 전에는 `create_pull_request` 가 깃허브의 "권한이 없다" 문구에 그 문서를 덧붙여
   실패한다 — git push 는 영향받지 않는다.
2. **미니PC 의 Git for Windows 가 2.31 이상**인지(`GIT_CONFIG_COUNT` 규약). 2021년 3월 이후 판이면 된다.
3. **브랜치 정책은 이미 의도대로다** — `asahi`·`homepage` 모두 `production` 은 운영자만, `main` 은
   CI 필수(부원의 통합 브랜치). 새 공개 리포를 만들면 같은 모양을 따른다(`deploy/github-app-셋업.md` §8).
4. 병합 후 미니PC 워커는 5분 안에 자동 갱신된다(`deploy/update-worker.ps1`). 봇은 `production` 배포로
   간다. 양쪽이 모두 새 코드일 때 비로소 자격증명이 붙는다(§4 마지막 문단).

## 7. 검증

유닛: `agent/tests/gitEnv.test.ts`(env 모양 + **실제 git** 이 그 env 로 자격증명을 주고, 없으면 즉시
실패하는 것 — CI 의 리눅스·윈도우 양쪽), `shellToken.test.ts`(캐시·재발급·동시성·실패 냉각),
`remoteTools.test.ts`(주입·폴백·다른 도구 무영향), `remoteExecutors.test.ts`(env 가 실제 셸까지 닿는
것), `gitPublish.test.ts`(fetch·reset·갈라짐 거절), `tools.test.ts`·`appToken.test.ts`(PR 검증·권한
안내·성공 경로), `persona.test.ts`(안내와 도구 노출의 일치).

실환경: `deploy/smoke-test.md` "워커 git 자격증명·PR 생성" 절 — 전부 미검증이다.

## 8. 남는 일

- 셸 토큰을 읽어 디스코드 밖에서 쓴 흔적은 `actions` 에 남지 않는다 — 깃허브 감사 로그만이 단서다.
- `publish_project` 는 여전히 자기 프로젝트 리포의 `main` 에 직접 push 한다. 그 리포는 그 부원의
  것이라 운영자 병합 규칙의 대상이 아니라고 봤다 — 바뀌면 `publishArgv` 의 브랜치 하나만 고치면 된다.
- 기존 리포를 `projects` 표에 "입양"하는 경로는 만들지 않았다 — 기존 리포는 이제 git 으로 직접
  다루므로 `restore_project`/`publish_project` 를 거칠 이유가 없다.
- 셸 토큰은 소유자·손님·DM·서버를 가리지 않는다. 신원별로 좁힐 축이 생기면(예: 특정 부원은 읽기만)
  `shellGitArgs` 가 `ctx` 를 이미 받고 있으므로 그 자리에서 가른다.
