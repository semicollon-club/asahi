---
lastReviewed: 2026-08-07
---

# CI 워크플로우 — 사람이 한 번 넣어야 하는 파일

`agent/` 의 테스트·타입체크를 리눅스·윈도우 양쪽에서 돌리는 GitHub Actions 워크플로우다.
**내용은 [ci-워크플로우.yml.txt](ci-워크플로우.yml.txt) 에 있고, 아직 `.github/workflows/`
에는 없다.**

## 왜 리포에 바로 못 들어갔나

GitHub 은 **OAuth 앱 토큰이 `.github/workflows/` 아래 파일을 만들거나 고치는 것을 `workflow`
스코프 없이 거부한다.** 이 리포의 자격증명(Git Credential Manager 가 저장한 토큰)에는 그
스코프가 없어서, 다른 파일은 전부 정상적으로 푸시되는데 이 파일 하나만 막힌다.

```
! [remote rejected] ... (refusing to allow an OAuth App to create or update
  workflow `.github/workflows/agent.yml` without `workflow` scope)
```

**결함이 아니라 GitHub 의 의도된 제약이다** — 토큰이 새면 CI 가 임의 코드를 돌리는 통로가
되므로 별도 스코프로 갈라 놓은 것이다.

## 넣는 방법 — 둘 중 하나

### A. 웹 UI (스코프 불필요, 1분)

웹에서 만드는 커밋은 OAuth 스코프 제약을 받지 않는다.

1. `https://github.com/wwoosshh/asahi` → **Add file** → **Create new file**
2. 파일명에 `.github/workflows/agent.yml` 을 그대로 입력한다(슬래시를 치면 폴더가 만들어진다)
3. [ci-워크플로우.yml.txt](ci-워크플로우.yml.txt) 의 내용을 그대로 붙여넣는다
4. 커밋한다

### B. 토큰에 스코프 추가 (근본 해결)

앞으로 CI 를 고칠 때마다 같은 벽에 부딪히므로, 한 번 풀어두는 편이 낫다.

```powershell
gh auth refresh -h github.com -s workflow
gh auth setup-git
```

**두 번째 줄이 핵심이다.** `gh` 와 `git` 은 서로 다른 자격증명을 본다 — `git push` 는 Git
Credential Manager 가 저장한 토큰을 쓰므로, `gh auth refresh` 만 해서는 `git push` 에 아무
영향이 없다. `gh auth setup-git` 이 git 을 gh 토큰 쪽으로 연결한다.

**계정 주의**: 승인은 브라우저에 로그인된 계정으로 이뤄진다. 이 리포는 `wwoosshh` 소유이고
동아리 계정(`semicollon-git`)은 협업자가 아니므로, 동아리 계정으로 로그인된 브라우저에서
승인하면 실패한다. 시크릿 창에서 `wwoosshh` 로 로그인해 승인한다.

## 넣고 나서

`docs/status/STATUS.md` 의 "테스트" 절이 이 파일을 "아직 리포에 없다"고 적고 있다 — 넣은
뒤에는 그 서술을 고친다. 그리고 이 문서와 `ci-워크플로우.yml.txt` 는 지워도 된다.

## 왜 두 OS 를 모두 도는가

봇은 리눅스(Railway), 워커는 윈도우(미니PC)에서 돌고, 경로 처리 테스트 상당수가
`it.skipIf(process.platform ...)` 로 한쪽에서만 실행된다. 특히 워커의 최종 경로 관문
(`checkPath`, `agent/tests/remoteRoots.test.ts`) 5건은 윈도우에서만 돈다 — 리눅스만 돌리면
그 관문이 CI 에서 한 번도 검증되지 않는데, 실환경에서도 봇 쪽 1차 필터에 먼저 걸려 아직
도달한 적이 없는 경로라 유닛 테스트가 유일한 검증 수단이다.

타입체크도 양쪽에서 돌린다 — import 경로의 대소문자 불일치는 리눅스에서만 드러난다.
