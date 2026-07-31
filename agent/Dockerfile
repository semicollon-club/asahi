# syntax=docker/dockerfile:1
#
# Asahi 에이전트(디스코드 봇) — Railway 배포용 Dockerfile.
#
# 빌드 컨텍스트 전제: 이 파일은 Railway 서비스 설정의 "Root Directory" 를
# `agent` 로 지정했을 때(권장, deploy/railway-셋업.md 참고) 그 디렉터리를
# 빌드 컨텍스트로 사용한다. 즉 아래 COPY 경로들은 리포 루트가 아니라
# agent/ 기준이다. 로컬에서 직접 빌드해 확인하려면 리포 루트에서:
#   docker build -f agent/Dockerfile agent
#
# 경로 문제(중요): src/index.ts, src/config.ts 는 실행 cwd 기준 상대경로
# path.resolve("..", "data", ...) 로 리포 루트의 data/ 를 참조하도록 짜여
# 있다(로컬 PM2 운영 전제 — cwd=agent/, ".."=리포 루트). 컨테이너에는 이
# 리포 루트 구조(agent/ 옆의 data/)가 없으므로, 그 상대참조에 기대는 대신
# DATA_DIR / MEMORY_DIR 환경변수를 절대경로로 주어 우회한다(아래 ENV).
# agentCwd(index.ts) 도 DATA_DIR 기준으로 파생되므로 함께 해결된다.
# 이 방식(b)을 택한 이유: 컨테이너 안에 리포 루트를 흉내낸 형제 디렉터리를
# 두는 방식(a)보다 단순하고, 소스 수정 없이 env 만으로 성립한다.
#
# 실제 데이터(대화 기록·유저·기억)는 Supabase Postgres(DATABASE_URL)에
# 저장되므로, 이 컨테이너의 /data 는 에이전트 작업용 임시 디렉터리일 뿐이며
# 영속 볼륨이 없어도(재배포로 사라져도) 기능에 영향이 없다.

# ---------- builder ----------
FROM node:22-bookworm AS builder
WORKDIR /app

# 의존성 레이어를 소스보다 먼저 캐시.
COPY package.json package-lock.json ./
RUN npm ci

# 소스 복사 후 타입스크립트 빌드.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 프로덕션 의존성만 설치.
# @anthropic-ai/claude-agent-sdk 는 optionalDependencies 로 플랫폼별 바이너리
# (예: -linux-x64)를 갖고 있어, node:22-bookworm(glibc) 위에서 추가 apt 설치
# 없이 npm ci 만으로 리눅스 바이너리가 설치된다(스파이크로 확인). 이 패키지는
# dependencies 라 --omit=dev 로도 그대로 유지된다.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# 스킬은 빌드 산출물이 아니라 읽기 전용 자원이라 소스에서 그대로 옮긴다. 이 줄이 없으면
# 컨테이너에 skills/ 가 없어 스킬이 하나도 로드되지 않는다 — 그런데 그 실패는 배포 후에야,
# 그것도 조용히 드러난다(스킬이 없는 것과 안 켜진 것을 구별할 방법이 없다).
COPY skills ./skills

# 런타임 데이터 경로를 절대경로로 고정 — 위 "경로 문제" 설명 참고.
# /data 자체는 이미지에 없고, 앱이 시작 시 mkdirSync(recursive)로 만든다.
ENV DATA_DIR=/data/store
ENV MEMORY_DIR=/data/memory

# .env 파일은 이미지에 넣지 않는다. 비밀값(DISCORD_TOKEN 등)은 Railway
# Variables 로 런타임에 process.env 주입 — dotenv.config() 는 대상 파일이
# 없어도 예외 없이 조용히 넘어가므로 안전하다(deploy/railway-셋업.md 참고).
# data/ 도 이미지에 넣지 않는다 — 실제 저장소는 Supabase(DATABASE_URL).

CMD ["node", "dist/index.js"]
