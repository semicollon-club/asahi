---
lastReviewed: 2026-09-05
---

# 다른 PC에서 Asahi 운영하기

이 PC가 꺼져 있어도 다른 PC에서 봇을 띄울 수 있게 하는 절차. 코드는 GitHub(`semicollon-club/asahi` — 옛 주소 `wwoosshh/asahi` 는 리다이렉트된다)에 있고, **비밀값(.env)은 git에 올라가지 않으므로** 새 PC에서 따로 준비한다. 대화·기억 등 실제 상태는 **Supabase Postgres**(`DATABASE_URL`)에 중앙 저장되므로, 같은 `DATABASE_URL`을 가리키기만 하면 새 PC에서도 기억이 그대로 이어진다.

## 사전 요구
- **Node.js 22 이상**, **git**
- **`DATABASE_URL`(Supabase Session pooler) 필수** — 같은 DB를 가리켜야 기억이 이어진다. 발급 방법·형식은 [deploy/railway-셋업.md](railway-셋업.md)의 "DATABASE_URL — 반드시 Session pooler를 쓴다" 절 참고.

## 최초 셋업 (새 PC에서 한 번)

```powershell
git clone https://github.com/semicollon-club/asahi.git
cd asahi\agent
npm install
npm run build
```

### .env 준비 (리포 루트에 둔다: `asahi\.env`)
`.env.example`을 복사해 값을 채운다.
```powershell
cd ..
copy .env.example .env
notepad .env
```
- `DISCORD_TOKEN` — 이 PC와 **같은 봇**의 토큰 (Discord Developer Portal)
- `DISCORD_OWNER_ID` — 소유자(본인) 디스코드 숫자 ID
- `DATABASE_URL` — Supabase **Session pooler** 연결 문자열, **기존 PC와 동일한 값**. 발급·형식은 [deploy/railway-셋업.md](railway-셋업.md)의 "DATABASE_URL" 절 참고.
- `CLAUDE_CODE_OAUTH_TOKEN` — `claude setup-token`으로 발급한 구독 토큰
- 나머지(한도·경로 등)는 비워두면 기본값

### 실행
```powershell
cd agent
pm2 start ..\deploy\ecosystem.config.cjs
pm2 logs asahi-assistant --lines 20   # "[discord] 로그인 완료" 확인
```
(부팅 자동시작·PM2 명령어는 `deploy/PM2-명령어.md` 참고)

## ⚠️ 반드시 지킬 것

### 1. 봇은 한 번에 한 곳에서만
디스코드 봇 토큰은 하나다. **두 곳에서 동시에 실행하면 게이트웨이 세션이 충돌**한다. 다른 PC에서 띄우기 전에 현재 PC의 봇을 반드시 멈춘다:
```powershell
pm2 stop asahi-assistant     # 기존 PC에서
```
그 다음 다른 PC에서 `pm2 start`. 즉 "현재 PC 미작동 → 다른 PC 가동"은 되지만 **동시 가동은 금지**. 이 제약은 Railway(클라우드 상시구동)와도 동일하게 적용된다 — 로컬 PC와 Railway를 동시에 띄워서도 안 된다(자세한 내용은 [deploy/railway-셋업.md](railway-셋업.md)의 "봇은 한 번에 한 곳만" 참고).

### 2. 기억은 Supabase Postgres 중앙이라 어느 PC에서도 이어짐
유저·대화·기억 등 실제 상태는 `DATABASE_URL`이 가리키는 Supabase Postgres에 저장된다. **같은 `DATABASE_URL`을 쓰는 한 어느 PC에서 봇을 띄워도 이전 기억 그대로 이어진다** — 별도 이전 작업이 필요 없다. `data/`에 남는 마크다운 캐시(장기 기억 문서)만 각 PC 로컬이라 자동으로 이어지지 않는다(아래 "데이터 이전" 참고).

### 3. 허용 폴더(Phase A)는 그 PC 경로 기준
`allow_dir`로 등록한 폴더 목록도 Supabase Postgres에 저장돼 다른 PC에서 그대로 보이지만, 경로 문자열 자체는 그 폴더를 등록한 PC의 파일시스템 기준이다. 새 PC에서는 같은 폴더라도 실제 경로(드라이브 문자 등)가 다를 수 있으므로, 그 PC에서 다시 `allow_dir` 해야 한다.

## 코드 업데이트 (양쪽 PC 공통)
이 PC에서 작업 후:
```powershell
git add -A && git commit -m "..."   # 커밋
git push
```
다른 PC에서 받기:
```powershell
git pull
cd agent && npm install   # package.json 바뀌었을 때만
npm run build
pm2 restart asahi-assistant
```

## 데이터 이전 (마크다운 기억을 그대로 옮기고 싶을 때)
유저·대화·기억 등 실제 상태는 Postgres에 있으므로 **DB 이전은 필요 없다**. 옮길 게 있다면 `data/memory`의 마크다운 기억 문서뿐이다 — 봇을 멈춘 뒤 새 PC의 같은 위치(리포 루트 아래 `data/memory`)로 복사한다.

> 런타임 상태(유저·대화·기억)는 이미 Supabase로 공유된다. 로컬 마크다운 기억(`data/memory`)만 수동으로 이전하면 된다.
