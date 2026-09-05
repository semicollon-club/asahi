---
lastReviewed: 2026-09-05
---

# GitHub App 셋업 — 깃허브 발행용

깃허브 발행(`docs/superpowers/specs/2026-08-07-github-publish-design.md`)이 쓰는 자격증명을
만드는 절차다. **사람이 한 번만** 하며 코드로 대신할 수 없다.

핵심 원칙 하나만 기억하면 된다. **여기서 만드는 개인키는 봇(Railway)에만 둔다. 미니PC 에는
절대 두지 않는다.** 미니PC 는 부원의 `sh_exec` 가 닿는 기계이고(`deploy/worker-셋업.md`
"미니PC 셋업"), 개인키가 거기 있으면 부원 한 명이 셸 한 줄로 동아리 조직 전체 권한을 영구히
가져간다. 이 설계가 워커에 짧은 수명의 단일 리포 토큰만 넘기는 이유가 정확히 이것이다.

## 0. 전제

- 동아리 조직 **`semicollon-club`** 이 있고, 본인이 그 조직의 **owner** 다.
- 조직이어야 한다 — 개인 계정에는 App 설치 토큰으로 리포를 만들 수 없다(설계 §4.1).

## 1. App 등록

조직 페이지 → **Settings** → 왼쪽 사이드바 맨 아래 **Developer settings** → **GitHub Apps** →
**New GitHub App**.

> 개인 계정의 Developer settings 로 들어가지 않도록 주의한다. **조직** 설정에서 시작해야
> 그 App 의 소유자가 조직이 된다. 개인 계정 밑에 만들면 나중에 본인이 동아리를 떠날 때
> App 도 함께 딸려 간다.

### 채울 값

| 필드 | 값 | 비고 |
|---|---|---|
| **GitHub App name** | 예: `asahi-publisher` | **GitHub 전체에서 유일**해야 하고 34자 이하다. 2026-08-07 기준 `asahi-publisher`·`asahi-semicollon`·`semicollon-publisher` 는 동명 계정이 없었다(다른 App 이 선점했을 수는 있다 — 그러면 폼이 거절한다) |
| **Homepage URL** | `https://github.com/semicollon-club` | 필수 필드다. 실제로 쓰이지 않으니 조직 주소면 충분하다 |
| **Description** | 비워도 된다 | |
| **Callback URL** | 비운다 | 사용자 로그인을 받지 않는다 |
| **Webhook → Active** | **체크 해제** | 아래 참고 |

**Webhook 의 `Active` 를 반드시 끈다.** 봇은 웹훅을 받지 않는다. 켜두면 Webhook URL 이
필수가 되고, 쓰지도 않는 공개 수신 표면이 생긴다.

### 권한 (Repository permissions)

세 개만 켠다. 나머지는 전부 `No access` 로 둔다.

| 권한 | 값 | 왜 |
|---|---|---|
| **Contents** | Read and write | git push. 이 기능의 본체다. 2026-09-05 부터는 `sh_exec` 의 git(clone·fetch·push)도 이 권한의 단기 토큰을 쓴다 |
| **Administration** | Read and write | 리포 자동 생성(`POST /orgs/{org}/repos`)에만 쓰인다 |
| **Pull requests** | Read and write | PR 생성(`create_pull_request`, 2026-09-05). 부원이 브랜치를 올린 뒤 main 에 PR 을 내는 마지막 조각이다 |

`Metadata: Read-only` 는 자동으로 켜진다 — 정상이다.

> **이미 만든 App 에 권한을 더하려면**(2026-09-05 기준 `asahi-publisher` 설치에는 `Pull requests`
> 가 없다 — 설치 권한이 `administration`·`contents`·`metadata` 셋뿐인 것을 API 로 확인했다):
> App 설정 → **Permissions & events** → Repository permissions 에서 **Pull requests: Read and
> write** → 아래 **Save changes**. 그다음 **조직 쪽에서 승인**해야 실제로 반영된다 — 조직
> Settings → **GitHub Apps** → `asahi-publisher` 옆 **Configure** 에 "새 권한 요청" 배너가 뜨고
> **Review request → Accept new permissions**. 승인 전까지 설치 토큰은 옛 권한으로만 발급되고,
> `create_pull_request` 는 깃허브의 "permissions requested are not granted" 문구에 이 문서를
> 덧붙여 실패한다. git push 는 영향받지 않는다(셸 토큰은 `contents` 만 요청한다).

> **Administration 을 빼고 싶다면** 뺄 수 있다. 대신 리포를 사람이 미리 만들어 둬야 하고
> 봇은 푸시만 한다. 권한이 줄어 더 안전하지만 부원이 새 프로젝트를 만들 때마다 운영자를
> 거쳐야 한다. 어느 쪽이든 설계의 나머지는 그대로다.

### 설치 범위

**Where can this GitHub App be installed?** → **Only on this account**

공개 App 으로 만들 이유가 없다.

**Create GitHub App** 을 누른다.

## 2. App ID 적어 두기

만들면 그 App 의 **General** 페이지로 간다. 위쪽 **App ID** 의 숫자를 적어 둔다 —
`GITHUB_APP_ID` 에 넣을 값이다.

## 3. 개인키 생성

같은 General 페이지를 아래로 내려 **Private keys** → **Generate a private key**.

`.pem` 파일이 즉시 내려받아진다(PEM, PKCS#1 RSAPrivateKey 형식).

> **다시 받을 수 없다.** GitHub 은 공개키만 보관한다. 잃어버리면 새로 만들고 옛것을 지우는
> 수밖에 없다 — 어렵진 않으니 잃어버렸다고 당황할 필요는 없다.

받은 파일을 **다운로드 폴더에 그대로 두지 않는다.** 다음 단계에서 base64 로 바꿔 Railway 에
넣은 뒤, 로컬 파일은 지운다.

## 4. 조직에 설치

App 의 왼쪽 사이드바 → **Install App** → `semicollon-club` 옆 **Install**.

**Repository access** 는 **All repositories** 를 고른다. 발행 대상 리포는 봇이 앞으로 만들
것들이라 지금 고를 수 있는 목록에 없다. 조직 자체가 이 용도로만 쓰이므로 범위를 좁혀 얻을
것이 없다.

설치를 마치면 주소창이 이렇게 된다.

```
https://github.com/organizations/semicollon-club/settings/installations/12345678
```

맨 뒤 숫자가 **Installation ID** 다 — `GITHUB_APP_INSTALLATION_ID` 에 넣을 값이다.

## 5. 개인키를 base64 한 줄로

줄바꿈이 든 PEM 을 환경변수에 그대로 넣지 않는다. 값이 경로마다(`.env` 파서·배포 플랫폼·셸)
다르게 다뤄져 조용히 망가지고, 깨진 키는 "인증 실패" 한 줄로만 드러나 원인을 엉뚱한 곳에서
찾게 된다.

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\asahi-publisher.private-key.pem")) | Set-Clipboard
```

클립보드에 한 줄이 담긴다. 붙여넣은 뒤 **원본 `.pem` 을 지운다.**

## 6. Railway 환경변수 등록

Railway 대시보드 → 해당 서비스 → **Variables** 에서 넷을 넣는다.

| 변수 | 값 |
|---|---|
| `GITHUB_ORG` | `semicollon-club` |
| `GITHUB_APP_ID` | 2단계의 숫자 |
| `GITHUB_APP_INSTALLATION_ID` | 4단계의 숫자 |
| `GITHUB_APP_PRIVATE_KEY_B64` | 5단계의 한 줄 |

넷 중 하나라도 비어 있으면 봇은 발행 도구를 아예 노출하지 않는다 — 부가 기능이 본 기능을
인질로 잡지 않는다.

## 7. 확인

배포 후 소유자 DM 에서 발행을 한 번 시켜 본다. 자세한 기대 결과는 `deploy/smoke-test.md` 의
발행 항목에서 추적한다. 셸 git·PR 생성은 같은 문서의 "워커 git 자격증명·PR 생성" 절이다 — 그쪽은
봇뿐 아니라 **미니PC 워커도 새 코드**여야 한다(`deploy/worker-셋업.md` "자동 갱신").

## 8. 브랜치 보호 — 실제 정책(2026-09-05 확인)

부원이 디스코드로 브랜치를 push 하고 PR 을 낼 수 있게 되면서, 브랜치 규칙은 **깃허브 쪽 설정**이
집행한다. 봇은 셸 명령을 검사해 거르지 않는다(`docs/security/risk-register.md` §9) — 봇 자신은
main·production 에 직접 push 하지도 병합하지도 않고 PR 까지만 하지만, 그건 페르소나 규칙이다.

운영자가 정한 브랜치 정책은 이렇다(`asahi`·`homepage` 둘 다 같은 모양, API 로 확인):

| 브랜치 | 걸린 것 | 뜻 |
|---|---|---|
| `production` | push 가능자를 `wwoosshh` 로 제한 | 병합·배포는 운영자만. App(`asahi-publisher`)은 허용 목록에 없어 **봇 토큰으로도 올릴 수 없다** |
| `main` | CI 상태 체크 필수 + 강제 push 금지 | **부원이 자유롭게 PR 로 쌓는 통합 브랜치.** 검증 뒤 운영자가 production 으로 올린다. PR 필수·병합자 제한은 일부러 걸지 않았다 |

즉 "main 에 PR 필수를 걸어야 한다"는 요구는 없다 — 이 문서의 이전 판이 그렇게 권했는데 운영자의
의도와 달랐다. 새 리포를 만들 때 이 모양을 그대로 따른다.

**비공개 리포는 Free 플랜에서 어떤 브랜치 보호도 걸 수 없다.** 발행으로 생기는 부원 프로젝트
리포가 여기 해당한다 — 그 리포는 그 부원의 것이라 지킬 브랜치가 없지만, 비공개 리포에
production 같은 배포 브랜치를 두게 되면 그때는 공개로 바꾸거나 GitHub Team 으로 올려야 한다.
이건 결함이 아니라 플랜의 한계다.

**권한 승인 페이지를 헷갈리지 않는다.** 조직 Settings 의 "Third-party application access
policy"(OAuth application policy)는 이 App 과 무관한 OAuth 앱 정책이다 — 거기서 "Setup
application access restrictions" 를 켜면 `gh`·Vercel 같은 OAuth 앱이 조직 데이터를 못 보게 돼
운영자 자신이 잠길 수 있다. App 의 새 권한을 승인하는 곳은 **Third-party Access → GitHub Apps →
asahi-publisher → Configure** 이고, 설치 번호를 알면 주소로 바로 간다
(`https://github.com/organizations/semicollon-club/settings/installations/<설치 번호>` —
번호는 4단계에서 적어 둔 `GITHUB_APP_INSTALLATION_ID`).

## 개인키를 다뤄야 할 때

**GitHub 공식 문서는 개인키를 환경변수가 아니라 키 볼트에 두라고 권한다** — "the single most
valuable secret for a GitHub App" 이라는 표현을 쓴다. 이 프로젝트는 그 권고를 따르지 않고
Railway 환경변수에 둔다. 동아리 규모에서 키 볼트를 도입하는 비용이 얻는 것보다 크다고 보기
때문이며, **의식적인 선택이지 모르고 지나친 것이 아니다.** 대신 아래를 지킨다.

- 키는 리포에 커밋하지 않는다(`.env` 는 `.gitignore` 에 있다).
- 키는 미니PC 에 두지 않는다(이 문서 맨 위).
- App 설치 범위를 `semicollon-club` 하나로 제한해, 키가 새더라도 피해가 그 조직에 갇힌다.

### 유출이 의심되면

**1. App 의 General → Private keys 에서 그 키를 삭제한다.** 즉시 무효가 된다. 새 키를 만들어
5·6단계를 다시 하면 복구된다.

**2. 조직 리포가 지워지지 않았는지 확인한다.** 이 App 은 `Administration: write` 를 갖고 있어
**리포를 삭제할 수 있다**(2026-08-07 실측: 발급한 토큰으로 `DELETE /repos/{org}/{repo}` 가
HTTP 204 로 성공했다). 유출된 키를 쥔 사람은 조직의 리포를 전부 지울 수 있다는 뜻이다.

> 이 문서의 초판은 "이 App 의 권한으로는 리포 삭제가 안 된다"고 적었다. **틀린 서술이었다.**
> 사고 대응 문서의 틀린 안내는 그 자체로 결함이라 실측으로 확인해 고쳤다.

지워졌다면 조직 Settings → **Deleted repositories** 에서 **90일 안에** 복구할 수 있다(포크
네트워크에 속했던 리포는 예외 — 그 네트워크의 다른 리포가 남아 있으면 복구되지 않는다).
삭제 후 최대 1시간이 지나야 목록에 뜨고, 팀 권한은 함께 복구되지 않는다.

**3. 자동 생성을 안 쓴다면 `Administration` 을 아예 빼는 것을 고려한다.** 이 위험의 원천이
그 권한 하나다 — 빼면 유출된 키로도 리포를 지울 수 없다(§1단계의 대가는 사람이 리포를 미리
만들어야 한다는 것뿐이다).

## 관련 문서

- 설계 배경·위협 모델: `docs/superpowers/specs/2026-08-07-github-publish-design.md`
- 셸 git 자격증명·PR 생성(2026-09-05): `docs/superpowers/specs/2026-09-05-worker-git-credentials-design.md`
- 왜 워커에 영구 자격증명을 두지 않는가: `docs/security/risk-register.md` §2·§5·§9
- 미니PC 전제조건: `deploy/worker-셋업.md`
