import path from "node:path";
import type { EventBus, UserMessageEvent, ConversationHint } from "../events/bus.js";
import type { Config } from "../config.js";
import { resolveTurnWorker, type TurnRunner, type TurnContext, type TurnResult, type ProgressUpdate } from "./agent.js";
import { buildSystemPrompt, deriveRapportStage } from "./persona.js";
import { parseSessionCommand, parseDigestCommand, parseHelpCommand, renderCommandHelp } from "./commands.js";
import { DIGEST_TOPICS } from "./digest.js";
import type { DigestRunner, DigestTopic } from "./digest.js";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { ConversationsRepo, Conversation } from "../store/conversationsRepo.js";
import type { ParticipantsRepo } from "../store/participantsRepo.js";
import type { MessagesRepo } from "../store/messagesRepo.js";
import type { SummariesRepo } from "../store/summariesRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { TurnsRepo } from "../store/turnsRepo.js";
import type { AllowedDirsRepo } from "../store/allowedDirsRepo.js";
import type { ActionsRepo } from "../store/actionsRepo.js";
import type { WorkerKind } from "../store/workersRepo.js";
import { scopeDirs } from "./workerSelect.js";
import { pathFlavorOf } from "./paths.js";
import { buildContextBlock, isSessionNotFound } from "./turnPrep.js";
import { buildImageMarker, downloadImages, type ImageRef, type ImageInput } from "./images.js";
import { buildFileMarker, uploadDirFor, type FileRef } from "./attachments.js";

const HOUR_MS = 60 * 60 * 1000;

const SUMMARY_PROMPT = `이 대화 세션이 곧 종료됩니다. 나중에 다시 깨어날 너 자신을 위해 이번 대화를 요약하세요.
- 결정된 것, 사용자에 대해 새로 알게 된 것, 진행 중인 일 중심으로 10줄 이내
- 요약 텍스트만 출력 (인사말·설명 없이)`;

// text/rawPrefix 를 "표시용 비교"에만 쓸 폴딩된 사본으로 바꾼다 — 윈도우 플레이버일 때만 구분자를
// 통일하고(백슬래시→슬래시) 대소문자를 접는다(윈도우 파일시스템은 대소문자를 구분하지 않는다;
// POSIX 는 구분자가 "/" 뿐이고 대소문자도 구분하므로 그대로 둔다). 두 치환 모두 문자 수를 보존한다고
// 가정한다 — paths.ts 의 isPathWithin(33-34번째 줄 부근)도 경계 판정에 같은 toLowerCase 가정을 이미
// 쓰고 있다. 그래서 폴딩된 문자열에서 찾은 접두 길이(rawPrefix.length, 폴딩 전 원래 길이)를 그대로
// 원본 text 자르기에 써도 안전하다 — shortenPath 가 진짜로 필요로 하는 성질이 바로 이것이다.
function foldForCompare(s: string, isWindows: boolean): string {
  const unified = isWindows ? s.replace(/\\/g, "/") : s;
  return isWindows ? unified.toLowerCase() : unified;
}

// 표시용 경로 축약: 그 사용자의 작업 폴더로 시작하면 그 앞부분을 떼어 낸다. 긴 절대경로가
// 상태 메시지의 12줄 예산을 잡아먹는 것을 막고, 부원에게 "내 폴더 안"이라는 게 자연스럽게
// 드러난다. 밖의 경로는 그대로 둔다 — 줄이면 어디인지 알 수 없어진다.
//
// 리뷰 후속(Task 3 사후검토, 실측 실패 케이스 2가지): (1) LLM 이 도구 인자를 슬래시로 정규화해
// 넘기면 base(백슬래시)와 구분자가 섞여 예전의 리터럴 startsWith 두 벌(백슬래시 접미 / "끝만"
// 슬래시로 바꾼 접미 — 내부 백슬래시는 그대로라 base 자체가 이미 POSIX 표기일 때만 맞았다)로는
// 못 잡았다. (2) 드라이브 문자 대소문자만 달라도(c:\ vs C:\) 못 잡았다. 두 경우 다 "조용히" 축약
// 없이 전체 경로가 그대로 노출됐다 — 폴더 밖 경로와 구분이 안 된다.
//
// base 가 윈도우식(드라이브 문자·UNC)인지는 paths.ts 의 pathFlavorOf 로 판정한다 — isPathWithin 이
// "무엇이 윈도우 경로인가"에 쓰는 것과 동일한 규칙이라, 두 곳의 판정이 나중에 갈리지 않는다(같은
// 규칙을 두 벌로 만들면 갈린다는 게 이 저장소가 이미 여러 번 겪은 결함 유형이다 — pathPermission.ts
// 의 resolveAgainstBase 도 같은 이유로 pathFlavorOf 를 재사용한다).
//
// isPathWithin/normalizeDir 자체는 재사용하지 않았다 — 그 함수들은 flavor.resolve() 로 상대경로를
// cwd 기준으로 만들고 '..'를 접은 뒤(+대소문자 폴딩) "같은 경로냐"만 참/거짓으로 답하도록 만들어져,
// 돌려주는 값이 있다면 정규화된 사본이지 "원본에서 그대로 잘라낸 나머지"가 아니다. 이 함수는
// 사용자에게 보여줄 문자열이 원래 표기(사용자가 실제로 준 구분자·대소문자)를 유지해야 하므로,
// 폴딩(foldForCompare)은 "어디서 자를지" 판단(boolean)에만 쓰고 자르기 자체는 항상 원본 text 에서 한다.
function shortenPath(text: string, baseDirs?: string[]): string {
  if (!baseDirs) return text;
  for (const base of baseDirs) {
    const isWindows = pathFlavorOf(base) === path.win32;
    const rawPrefix = base.endsWith("\\") || base.endsWith("/") ? base : `${base}${isWindows ? "\\" : "/"}`;
    if (foldForCompare(text, isWindows).startsWith(foldForCompare(rawPrefix, isWindows))) {
      return text.slice(rawPrefix.length);
    }
  }
  return text;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}초`;
}

// 표시 줄 하나에 실을 결과 요약의 상한(최종 리뷰 Important 2). 이벤트의 summary 상한
// (agent.ts 의 RESULT_SUMMARY_MAX=200)과는 다른 값이고, 달라야 한다 — 200 은 actions.result_summary
// 에 남길 기록 해상도이고, 이 80 은 한 줄짜리 UI 가 감당할 수 있는 길이다. 같은 값에서 나온 두
// 소비자(표시·기록)가 서로 다른 예산을 갖는 지점이 정확히 여기다.
//
// 왜 자르는가: 디스코드 메시지는 2000자가 한도인데, 상태 메시지의 유일한 길이 보호는
// discord.ts 의 12줄 상한(PROGRESS_DISPLAY_MAX_LINES)이었다. 그 값은 짧은 줄(`fs_read 완료`,
// 52자)을 전제로 잡힌 것인데, 이 브랜치가 summary 를 표시 줄에 실으면서 한 줄 최악이 220자가
// 됐다 — 12줄이면 2694자로 한도를 넘는다. 넘으면 send/edit 이 reject 되고 그 catch 는 로그만
// 남기므로, 상태 메시지가 그 턴 내내 옛 내용으로 얼어붙는다(도구를 많이 쓴 턴 = 진행 표시가
// 가장 필요한 턴에서 하필 그렇게 된다). 80 이면 머리글·줄머리·이름·소요시간까지 더해도 12줄이
// 1400자 안쪽이라 한도까지 여유가 넉넉하다.
export const PROGRESS_SUMMARY_MAX = 80;

// 결과 요약을 표시 한 줄로 만든다: 첫 줄만 뽑고 → 경로를 사용자 폴더 기준으로 줄이고 → 상한에서
// 자른다. 자른 자리에 말줄임표를 남긴다 — 한 줄짜리 UI 라 생략해도 되지만, 잘렸는지 아닌지를
// 부원이 구분할 수 있어야 "사유가 원래 이게 전부"라고 오해하지 않는다.
// 코드포인트 단위로 자른다(slice 는 UTF-16 코드유닛 기준이라 이모지가 경계에 걸리면 서로게이트
// 쌍이 쪼개진다 — tools.ts 의 truncateChars 와 같은 이유).
function summaryLine(summary: string, baseDirs?: string[]): string {
  const line = shortenPath(summary.split("\n")[0]!, baseDirs);
  const chars = [...line];
  return chars.length > PROGRESS_SUMMARY_MAX ? `${chars.slice(0, PROGRESS_SUMMARY_MAX).join("")}…` : line;
}

// ProgressUpdate → 사용자용 짧은 텍스트(순수 함수, 디스코드 태스크가 그대로 재사용한다).
// baseDirs(옵셔널): 그 손님의 작업 폴더 목록 — 넘기면 경로를 그 폴더 기준으로 축약한다.
export function formatProgress(u: ProgressUpdate, baseDirs?: string[]): string {
  switch (u.kind) {
    case "tool":
      return u.input !== undefined ? `${u.name} ${shortenPath(u.input, baseDirs)}` : `${u.name}()`;
    case "tool_result": {
      // 실패를 "완료"로 찍던 것이 이 함수의 가장 큰 결함이었다 — 부원이 왜 안 됐는지 알 수
      // 있는 경로가 이 한 줄뿐이다.
      const mark = u.ok ? "✓" : "✗";
      const name = u.name ?? "도구";
      const tail = u.ok
        ? [u.summary === undefined ? undefined : summaryLine(u.summary, baseDirs), u.durationMs === undefined ? undefined : `(${seconds(u.durationMs)})`]
        : [u.summary === undefined ? undefined : summaryLine(u.summary, baseDirs)];
      const rest = tail.filter((x) => x !== undefined).join(" ");
      return rest.length > 0 ? `${mark} ${name} — ${rest}` : `${mark} ${name}`;
    }
    case "answering":
      return "답변 작성 중";
  }
}

export type CoreRepos = {
  users: UsersRepo;
  conversations: ConversationsRepo;
  participants: ParticipantsRepo;
  messages: MessagesRepo;
  summaries: SummariesRepo;
  memories: MemoriesRepo;
  turns: TurnsRepo;
  // 손님에게 "네 작업 폴더가 어디인가"를 알려주기 위해 필요하다(resolveGuestWorkspaceDirs).
  // 실제 경로 게이팅은 remoteToolHandler 가 ToolCtx 의 같은 리포로 따로 수행한다 — 코어는
  // 안내문을 만들 때만 읽는다.
  allowedDirs: AllowedDirsRepo;
  // 도구 호출 기록. 표시(bus)와 같은 이벤트에서 나온다 — 두 벌을 만들면 반드시 어긋난다.
  actions: ActionsRepo;
};

// 대화(conversation)별 세션 + 대화 키별 직렬락으로 동작하는 코어.
// - 같은 conversation 은 직렬(재진입 금지), 다른 conversation 은 병렬.
// - 프라이버시(§6): DM 은 상대의 개인+공용 기억, 서버/스레드는 공용만 주입.
// - 한도(§8): 매 LLM 턴을 TurnsRepo.reserve 로 원자 예약(유저별+전역, 소유자 예약분).
export class AgentCore {
  private bus: EventBus;
  private config: Config;
  private runTurn: TurnRunner;
  private now: () => number;
  private repos: CoreRepos;
  private ownerId: string;
  private agentCwd: string;
  // discord_channel_id(대화 채널 키) → 그 대화의 마지막 작업 프라미스(꼬리). 여기에 이어붙여 직렬화한다.
  // 리포가 async 가 된 뒤로는 대화 행을 조회/생성하는 resolveConversation 자체도 비동기이므로,
  // 아직 conv.id 가 없는(첫 메시지) 시점부터 직렬화하려면 즉시 알 수 있는 채널ID 를 키로 써야 한다
  // (숫자 conv.id 로는 대화가 생성되기 전엔 큐잉할 수 없다 — 동시 첫 메시지 두 개가 대화 행을
  // 중복 생성하려 드는 경쟁을 막는다).
  //
  // 체인을 durable 저장(ingest)과 LLM 턴(turn) 두 갈래로 분리한다. 하나의 체인에 묶으면 앞
  // 메시지의 긴 LLM 턴이 끝날 때까지 뒤 메시지가 insert 조차 되지 못해, 그 사이 크래시하면
  // recoverPending 이 복구할 행 자체가 없어 영구 유실된다(회귀). ingest 는 짧으므로 채널별로
  // 직렬화해도 버스트가 빨리 소진되어 모든 메시지가 즉시 durable 저장되고, turn 은 여전히
  // 채널별(=대화별)로 직렬화되어 같은 대화 재진입 금지 불변식을 유지한다.
  private ingestChains = new Map<string, Promise<void>>();
  private turnChains = new Map<string, Promise<void>>();
  private fetchImpl: typeof fetch;
  // 카탈로그에 이미지가 있는 감정 이름들. 기동 시 한 번 읽어 넣는다(index.ts) — 생략되면 빈
  // 배열로 취급되어 persona.ts 가 표정 지침 자체를 프롬프트에서 뺀다.
  private emotions: string[];
  // FIX3(중요, 최종 리뷰): 능력 안내(persona.ts)가 실제 도구 상태를 반영하려면, systemPrompt 를
  // 만드는 시점(runTurn 호출 전)에 이미 "이번 턴에 워커가 연결돼 있는가"를 알아야 한다 — 그
  // 판정은 agent.ts 의 resolveTurnWorker 가 쓰는 것과 동일하다. Task 7: hub.isConnected 는
  // workerId 를 받는다(userId 가 아니다) — 워커가 registry 에 별도 id 로 등록되므로, 아래 registry
  // 로 실제 workerId 를 먼저 찾아야 한다(둘은 항상 짝으로 쓰인다).
  // 선택값(옵셔널)인 이유: 워커 배선이 없는 환경(테스트 등)에서는 늘 워커 미연결로 간주된다.
  // Task 3: isConnected 하나뿐이던 타입에 call·rootsOf 를 더한다 — 첨부 파일을 실제로 워커에
  // 내려놓으려면(runConversationTurn 의 file_fetch 호출) 연결 여부 확인을 넘어 호출 자체가
  // 필요하다. agent.ts 의 makeRunAgentTurn 이 받는 hub 구조적 타입과 같은 모양으로 맞춘다.
  private hub?: {
    isConnected(workerId: string): boolean;
    call(workerId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
    rootsOf(workerId: string): string[];
  };
  // Task 7: workers 테이블 조회 — resolveTurnWorker 가 "이 턴이 어느 워커를 쓰는가"를 실제
  // id 로 풀 때 쓴다(index.ts 는 repos.workers 를 그대로 넘긴다). hub 와 마찬가지로 배선이 없는
  // 환경(테스트 등)에서는 늘 워커 미연결로 간주된다(resolveTurnWorker 는 registry·hub 둘 중
  // 하나라도 없으면 null 을 돌려준다).
  private registry?: { personalWorkerOf(userId: string): Promise<string | null>; sharedWorkerId(): Promise<string | null> };
  // 정기 게시(조사) 실행기. 옵셔널인 이유는 hub 와 같다 — 배선이 없는 환경(테스트 등)에서는
  // 예약어를 받아도 실행할 대상이 없으므로 ingest 가 안내만 하고 넘어간다.
  // FIX1(치명, 최종 리뷰 3차): 예전엔 여기(AgentCore)에 예약어 전용 채널별 동시 실행 가드
  // (digestInFlight Set)를 따로 뒀다 — 그런데 스케줄 경로(index.ts 의 checkAndRun 타이머)는
  // 이 가드를 전혀 거치지 않아, 이전 틱의 턴이 안 끝난 채 다음 틱이 오면 같은 주제로 새 턴을
  // 또 시작하는 훨씬 심각한 재진입을 막지 못했다(리뷰 재현: 5틱 중 5턴 시작 — 매일 아침의
  // 정상 경로였다). 가드를 DigestRunner 내부(주제별 running Set)로 옮겨 checkAndRun·run 양쪽이
  // 같은 가드를 공유하게 했으므로, 이 필드는 삭제한다 — run() 의 반환값({ started: boolean })만
  // 보고 아래 ingest 에서 안내 여부를 정한다.
  private digest?: DigestRunner;

  constructor(deps: {
    bus: EventBus; config: Config; runTurn: TurnRunner; repos: CoreRepos; agentCwd: string; now?: () => number;
    fetchImpl?: typeof fetch;
    // 필드 선언(위 private hub)과 반드시 같은 타입이어야 한다 — 두 곳이 갈리면 대입에서
    // 컴파일이 막힌다.
    hub?: {
      isConnected(workerId: string): boolean;
      call(workerId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
      rootsOf(workerId: string): string[];
    };
    registry?: { personalWorkerOf(userId: string): Promise<string | null>; sharedWorkerId(): Promise<string | null> };
    emotions?: string[]; digest?: DigestRunner;
  }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.runTurn = deps.runTurn;
    this.repos = deps.repos;
    this.agentCwd = deps.agentCwd;
    this.ownerId = deps.config.ownerId;
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.hub = deps.hub;
    this.registry = deps.registry;
    this.emotions = deps.emotions ?? [];
    this.digest = deps.digest;
  }

  start(): void {
    // onUserMessage 자체는 동기(게이트 확인 + enqueue 만) — 실제 비동기 작업은 enqueue 된
    // ingest 안에서 일어나고 그 오류는 enqueue 의 .catch 가 처리하므로, 여기서
    // 프라미스를 잃어버릴 일이 없다.
    this.bus.subscribe("user_message", (e) => this.onUserMessage(e));
  }

  private onUserMessage(e: UserMessageEvent): void {
    const hint = e.hint;
    if (!hint) return; // 2B 실시간 경로는 항상 대화 힌트를 싣는다.
    if (hint.role !== "owner" && hint.role !== "allowed") return; // 게이트 재확인(방어)

    // durable ingest(대화 조회/생성 + 참가자 upsert + 메시지 저장)만 이 채널의 ingest 체인에
    // 태운다. LLM 턴은 여기서 기다리지 않는다 — ingest 가 끝나면 그 안에서 turn 체인에 별도로
    // 이어붙인다(아래 ingest 참고). conv.id 는 대화가 생성되어야 나오므로, 그 전 단계인 첫
    // 메시지부터 직렬화하려면 힌트에서 즉시 알 수 있는 discordChannelId 를 큐 키로 써야 한다 —
    // 그러지 않으면 같은 채널의 두 메시지가 동시에 도착했을 때 resolveConversation 이 서로의
    // 결과를 보지 못하고 대화 행을 중복 생성하거나(멱등 깨짐) 메시지 저장 순서가 뒤바뀔 수 있다.
    this.enqueue(this.ingestChains, hint.discordChannelId, () => this.ingest(hint, e.ts, e.text, e.images ?? [], e.files ?? [], e.rejectedFiles ?? []));
  }

  // durable 저장만 담당(짧다) — 크래시 복구 불변식: 이 함수가 끝나면 메시지는 반드시
  // processed=false 로 DB 에 있다. 뒤이은 LLM 턴은 turnChains 로 넘겨 별도로 직렬화한다.
  private async ingest(hint: ConversationHint, ts: number, text: string, images: ImageRef[], files: FileRef[], rejectedFiles: string[]): Promise<void> {
    // M-2(최종 리뷰, 의도적으로 고치지 않음): 아래의 조기 반환 갈래들(이 if 블록·바로 아래의
    // /새세션·/기억정리·/help·조사 예약어 — 전부 messages.insert/runConversationTurn 이전에 return
    // 한다. 손으로 적은 목록이라 예약어가 늘면 조용히 어긋난다 — commands.ts 의 COMMAND_HELP
    // 주석이 같은 함정을 지적한다. 여기 갈래를 더할 때 이 줄도 같이 고칠 것)은
    // images/files/rejectedFiles 를 전혀 참조하지 않고 그대로 버린다. 이 경로들은 예약어 하나만
    // 처리하고 LLM 턴도 메시지 저장도 열지 않으므로, 그 메시지에 마침 첨부가 함께 왔어도(예약어와
    // 파일을 같은 메시지로 보내는 드문 경우) 그걸 실을 자리가 없다. 이미지가 이미 겪던 것과 같은
    // 구조적 성질이고 이 브랜치가 만든 회귀가 아니다 — 다음에 이 gap 을 다시 "발견"하면 재조사
    // 없이 여기부터 읽을 것.
    // 일반 채널에서 멘션 없이 들어온 예약어(어댑터의 channel-command 경로). 대화를 조회하지도
    // 만들지도 않고 그 자리에서 끝낸다 — 여기서 conversations 행을 만들면 그 채널이 봇 대화로
    // 굳어(decideRoute 의 hasConversation) 이후 그 채널의 모든 메시지에 답하기 시작한다.
    // 어댑터의 isChannelCommand 를 통과한 것만 오므로 /help 와 조사 예약어 둘뿐이다.
    if (hint.commandOnly) {
      if (parseHelpCommand(text)) {
        // 능력 안내는 워커 연결 여부로 갈린다(최종 리뷰 Important 3) — 아래 helpText 참고.
        // commandOnly 는 일반 채널 경로라 항상 공개(isPrivate:false)다.
        const text2 = await this.helpText(hint.userId, false);
        this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: hint.discordChannelId, text: text2, ts: this.now() });
        return;
      }
      const topic = parseDigestCommand(text);
      if (topic) await this.startDigestCommand(topic, { userId: hint.userId, conv: null, replyRef: hint.discordChannelId, isPrivate: false });
      return;
    }

    const conv = await this.resolveConversation(hint, ts);

    // 세션 예약어 두 갈래. 둘 다 메시지를 저장하지 않고, 본체는 이 ingest 체인이 아니라 그
    // 대화의 turn 체인에 실어 보낸다(각 본체는 resetSession·compactSession).
    //
    // /새세션(reset)이 이 배선을 쓰는 이유는 바로 아래 /기억정리 갈래의 주석에 적힌 것과
    // 완전히 같은 경합이다 — 세션을 끊는다는 점이 같으니 되살아나는 방식도 같다. 다만 깨지는
    // 것이 다르다: 이 명령이 하는 두 가지 일(페르소나 재적용을 위한 세션 끊기, 바닥선)이 함께
    // 무너져, 모델은 이전 대화를 자기 컨텍스트에 그대로 쥔 채 이어가는데 바닥선은 DB 기록만
    // 가린다. 사용자에게는 이미 "안 가져갈게"라고 말한 뒤다. 이 브랜치를 만든 제보가 정확히
    // 이것이다("/새세션 을 했는데 이전 대화를 계속 이어하려고 한다").
    //
    // 큐 키로 conv.discordChannelId 가 아니라 hint.discordChannelId 를 쓰는 이유도 그쪽과 같다.
    const sessionCmd = parseSessionCommand(text);
    if (sessionCmd === "reset") {
      this.enqueue(this.turnChains, hint.discordChannelId, () => this.resetSession(conv.id, conv.discordChannelId));
      return;
    }

    // /기억정리: /새세션 이 "끊고 새로"라면 이쪽은 "정리해서 넘기기"다(Claude Code 의 /compact).
    // 지금 세션을 요약해 summaries 에 넣고 바닥선을 그어, 다음 세션에 원문 20개 대신 그 요약이
    // 실리게 한다. 캐릭터 설정은 지우지 않는다 — 그건 /새세션 의 몫이다.
    //
    // Important 1(리뷰 후속): 본체를 여기서 곧바로 돌리지 않고 그 대화의 turn 체인에 실어 보낸다.
    // 이 함수는 ingest 체인에서 도는데 대화 턴은 turn 체인에서 돌므로, 인라인으로 정리하면 진행
    // 중이던 턴과 완전히 병렬로 실행된다 — 그 턴이 끝나며 setSession(result.sessionId) 을 쓰면
    // 정리가 방금 끊어 놓은 세션이 되살아나고, 바닥선만 그어진 채로 남는다(리뷰 재현 결과:
    // session="s1" + floor 설정됨). 그러면 다음 턴은 정리 안 된 세션을 이어받으면서 DB 기록은
    // 바닥선에 가려 못 보는데, 사용자에게는 이미 "정리했어"라고 말한 뒤다. 게다가 요약 턴 자신이
    // 진행 중인 턴과 같은 SDK 세션을 동시에 resume 하게 되어, turn 체인이 지키는 "같은 대화
    // 재진입 금지" 불변식도 깨진다. 유휴 스윕(summarizeAndClose)이 같은 이유로 처음부터 turn
    // 체인에 실려 있다 — 같은 배선을 그대로 따른다.
    //
    // 큐 키는 conv.discordChannelId 가 아니라 hint.discordChannelId 다 — 이 정리가 직렬화되어야
    // 하는 상대가 바로 아래에서 같은 키로 큐잉되는 runConversationTurn 이기 때문이다. 둘은 보통
    // 같은 값이지만(resolveConversation 은 채널로 먼저 찾는다) 오리진 메시지로 찾아온 대화에서는
    // 갈릴 수 있고, 그때 다른 키를 쓰면 막으려던 병렬 실행이 그대로 돌아온다.
    if (sessionCmd === "compact") {
      this.enqueue(this.turnChains, hint.discordChannelId, () => this.compactSession(conv.id, hint.userId, conv.discordChannelId));
      return;
    }

    // 도움말: 예약어 목록만 보여준다. 모델을 부르지 않는다.
    if (parseHelpCommand(text)) {
      const helpText = await this.helpText(hint.userId, conv.isPrivate);
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId, text: helpText, ts: this.now() });
      return;
    }

    const digestTopic = parseDigestCommand(text);
    if (digestTopic) {
      await this.startDigestCommand(digestTopic, { userId: hint.userId, conv, replyRef: conv.discordChannelId, isPrivate: hint.isPrivate });
      return;
    }

    await this.repos.participants.upsert(conv.id, hint.userId, ts);
    // 미처리(processed=false)로 먼저 저장 → 크래시로 죽어도 부팅 시 recoverPending 이 재개한다.
    // 저장 content는 마커(§6: 과거 이미지 재주입 없음 — 이미지 자체는 저장하지 않고 몇 장/이름만 남긴다).
    const messageId = await this.repos.messages.insert({
      conversationId: conv.id, ts, role: "user", userId: hint.userId,
      discordMessageId: hint.discordMessageId, content: buildImageMarker(text, images), processed: false,
    });
    this.enqueue(this.turnChains, hint.discordChannelId, () => this.runConversationTurn(conv.id, hint.userId, hint.role as "owner" | "allowed", text, messageId, images, files, rejectedFiles));
  }

  // 정기 게시 예약어(/대회·/개발뉴스)를 즉시 실행한다. 스케줄의 lastRun 은 건드리지 않는다 —
  // 수동으로 한 번 봤다고 다음 날 아침 게시가 걸러지면 안 된다.
  //
  // 두 경로가 이 메서드 하나를 쓴다: 대화 안(스레드·DM, conv 있음)과 일반 채널의 예약어
  // (commandOnly, conv 없음). conv 는 안내를 대화 기록에도 남길지에만 쓰인다.
  //
  // replyRef 는 "명령을 친 곳"(안내·거부 문구가 가는 곳)이고, 조사 결과 자체는 그 주제의 지정
  // 채널로 간다 — 스레드에서 부르면 결과가 스레드에 갇혀 밖에서 안 보이던 문제 때문이다.
  // 지정 채널이 없으면(DIGEST_*_CHANNEL_ID 미설정) 친 곳으로 폴백한다.
  //
  // LLM 대화 턴 체인(turnChains)·메시지 저장은 거치지 않지만 손님 한도(turns.reserve)는 반드시
  // 통과시킨다 — 이 조사 턴은 claude-opus·웹검색·maxTurns:30 으로 이 앱에서 가장 비싼 턴이라,
  // 예약어로 이 검사를 건너뛰면 구독 한도 보호가 완전히 무력화된다(리뷰 발견: 손님이 예약어를
  // 연타해 무제한·동시 다발로 조사를 돌릴 수 있었음).
  private async startDigestCommand(
    topic: DigestTopic,
    o: { userId: string; conv: Conversation | null; replyRef: string; isPrivate: boolean },
  ): Promise<void> {
    const publishNotice = (text: string) =>
      this.bus.publish({ type: "system_notice", channel: "discord", channelRef: o.replyRef, text, ts: this.now() });
    // FIX6(사소, 머지 전 리뷰): 리다이렉트 안내는 오류·거부가 아니라 정상 진행 상황이다. discord.ts 는
    // system_notice 를 전부 ⚠️ 로 접두해(어댑터가 갖는 유일한 시각적 구분) 진짜 경고를 눈에 띄게
    // 하는데, 이 문구까지 그 경로를 타면 담담한 안내가 경고처럼 보인다. assistant_message 로 보내
    // 그 접두사를 피한다 — 이 텍스트엔 표정 마커가 없어 parseExpression 은 그대로 통과시키고
    // (emotion:null), resolveExpression 도 즉시 undefined 로 끝나 이미지 경로에 영향이 없다. 턴 종료
    // (finishStatus, ✅ 반응) 처리는 system_notice 와 완전히 같은 경로를 그대로 타므로 그 동작도
    // 달라지지 않는다.
    const publishAck = (text: string) =>
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: o.replyRef, text, ts: this.now() });

    if (!this.digest) {
      publishNotice("지금은 조사 기능이 꺼져 있어요.");
      return;
    }

    // 손님 한도: runConversationTurn 의 예약과 완전히 같은 모양·한도·거부 문구를 그대로 재사용한다
    // (§8 불변식 유지, 새 한도값·문구를 만들지 않는다). 소유자는 신원(userId===ownerId) 기준으로
    // 기존 정책대로 무제한 — 예약 자체를 생략한다. conversationId 는 대화가 없으면 null 이다
    // (turns.reserve 가 허용한다 — 한도 계산은 user_id 와 전역 카운트만 본다).
    const isOwner = o.userId === this.ownerId;
    if (!isOwner) {
      const reserved = await this.repos.turns.reserve({
        userId: o.userId, conversationId: o.conv?.id ?? null, kind: "proactive", ts: this.now(),
        perUserLimit: this.config.maxTurnsPerHourPerUser, globalLimit: this.config.maxTurnsPerHourGlobal,
        ownerReserve: 0, isOwner: false, windowMs: HOUR_MS,
      });
      if (!reserved) {
        const text = "구독 한도 보호를 위해 잠시 쉬고 있어요. 1시간 안에 다시 시도해 주세요.";
        // 대화가 있으면 기존대로 대화 기록에도 남긴다(notify). 없으면 알림만 보낸다.
        if (o.conv) await this.notify(o.conv, text);
        else publishNotice(text);
        return;
      }
    }

    // DM 에서 부른 건 DM 에 답한다. 공개 채널로 돌리면 혼자 확인해 보려던 것이 매번 동아리
    // 채널에 게시돼 버린다 — 스레드에 갇히는 문제는 서버 쪽 이야기고, DM 은 애초에 보기 힘든
    // 곳이 아니다. 공개 채널에 올리고 싶으면 서버에서 부르면 된다(양쪽 다 가능해진다).
    const target = o.isPrivate ? o.replyRef : (this.config.digestChannels[topic] ?? o.replyRef);
    if (target !== o.replyRef) {
      publishAck(`「${DIGEST_TOPICS[topic].label}」 소식은 <#${target}> 에 올릴게. 잠깐만.`);
    }

    // 같은 주제의 동시 실행 방지는 DigestRunner 내부의 주제별 running Set 이 담당한다 —
    // checkAndRun(스케줄)·run(예약어) 양쪽에 똑같이 적용된다. run() 이 { started:false } 를
    // 돌려주면 이미 도는 중이라는 뜻이다. 손님 몫은 위에서 이미 예약했으므로 겹쳐서 거부돼도
    // 되돌려주지 않는다(가장 비싼 턴이 두 번 도는 것보다 손님의 몫 하나를 쓰는 편이 훨씬 싸다).
    //
    // digest 를 지역 상수로 캡처해야 아래 클로저에서 undefined 가 아닌 타입으로 좁혀진다
    // (this.digest 는 위에서 존재를 확인했지만, TS 는 클로저 안에서 this 필드의 좁힘을 유지하지 않는다).
    const digest = this.digest;
    void (async () => {
      try {
        const { started } = await digest.run(topic, target);
        // 거부 안내는 결과가 가는 곳이 아니라 명령을 친 곳으로 보낸다 — 그쪽을 보고 있으니까.
        if (!started) publishNotice("지금 같은 주제로 이미 조사 중이에요. 끝나면 다시 시도해 주세요.");
      } catch (err) {
        console.error("[core] 조사 실행 오류:", err);
      }
    })();
  }

  // 힌트로 대화 행을 확정한다(멱등: discord_channel_id → origin_message_id → 생성).
  private async resolveConversation(hint: ConversationHint, ts: number): Promise<Conversation> {
    const byChannel = await this.repos.conversations.getByChannelId(hint.discordChannelId);
    if (byChannel) return this.reactivate(byChannel);
    if (hint.originMessageId) {
      const byOrigin = await this.repos.conversations.getByOriginMessageId(hint.originMessageId);
      if (byOrigin) return this.reactivate(byOrigin);
    }
    await this.repos.conversations.create({
      kind: hint.kind, discordChannelId: hint.discordChannelId, originMessageId: hint.originMessageId,
      guildId: hint.guildId, parentChannelId: hint.parentChannelId, primaryUserId: hint.primaryUserId,
      isPrivate: hint.isPrivate, lastActiveTs: ts,
    });
    return (await this.repos.conversations.getByChannelId(hint.discordChannelId))!;
  }

  // 유휴 정리로 status='idle' 로 닫혔던 대화가 새 메시지로 재활성되면 'active' 로 되살린다.
  // (listActiveIdle 은 status='active' 만 대상으로 하므로, 복원하지 않으면 이후 유휴 스윕에서 영구 누락된다.)
  private async reactivate(conv: Conversation): Promise<Conversation> {
    if (conv.status !== "active") {
      await this.repos.conversations.setStatus(conv.id, "active");
      return { ...conv, status: "active" };
    }
    return conv;
  }

  // 키별 직렬락(범용): 주어진 체인 맵에서 그 키의 꼬리 프라미스에 작업을 이어붙인다.
  // ingestChains/turnChains 모두 이 헬퍼로 큐잉한다.
  private enqueue(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>): void {
    const prev = map.get(key) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => {
      console.error("[core] 처리 오류:", err);
    });
    map.set(key, next);
  }

  // ingestChains·turnChains 가 모두 안정될 때까지 대기(테스트·그레이스풀 종료용).
  // ingest 가 끝나며 그 안에서 turnChains 에 새 작업을 추가하므로, 두 맵을 함께 스냅샷해
  // 반복 확인해야 "ingest 소진 → 그로 인해 turnChains 에 쌓인 것까지" 모두 잡아낸다.
  async drain(): Promise<void> {
    const maps = [this.ingestChains, this.turnChains];
    for (let i = 0; i < 1000; i++) {
      const chains = maps.flatMap((m) => [...m.values()]);
      await Promise.allSettled(chains);
      const after = maps.flatMap((m) => [...m.values()]);
      if (after.length === chains.length && after.every((p, idx) => p === chains[idx])) return;
    }
  }

  private async runConversationTurn(convId: number, userId: string, role: "owner" | "allowed", text: string, messageId: number, images: ImageRef[] = [], files: FileRef[] = [], rejectedFiles: string[] = []): Promise<void> {
    try {
      const conv = await this.repos.conversations.getById(convId);
      if (!conv) return;
      // 특권/전원열람 게이트는 role 이 아니라 소유자 신원(§6 불변식: primary_user_id=owner)으로 판정한다.
      // manage_access 로 손님에게 'owner' 역할이 부여되어도 신원이 아니면 특권을 갖지 못하게 한다.
      const isOwner = userId === this.ownerId;

      // 한도: 소유자는 어떤 한도도 받지 않는다(예약 생략 → turns 미기록 → 손님 카운트에도 영향 없음).
      // 손님만 유저별+전역 한도로 원자 예약한다(구독 보호는 손님에게만 적용). 실패면 안내 후 종료.
      if (!isOwner) {
        const reserved = await this.repos.turns.reserve({
          userId, conversationId: conv.id, kind: "message", ts: this.now(),
          perUserLimit: this.config.maxTurnsPerHourPerUser, globalLimit: this.config.maxTurnsPerHourGlobal,
          ownerReserve: 0, isOwner: false, windowMs: HOUR_MS,
        });
        if (!reserved) {
          await this.notify(conv, "구독 한도 보호를 위해 잠시 쉬고 있어요. 1시간 안에 다시 시도해 주세요.");
          return;
        }
      }

      // 세션: 열린 세션이 유휴 이내면 resume(새 메시지만), 아니면 새 세션(기억 컨텍스트 주입).
      let resume: string | undefined;
      let prompt = text;
      if (conv.sessionId && this.now() - conv.lastActiveTs < this.idleMs()) {
        resume = conv.sessionId;
      } else {
        prompt = `${await buildContextBlock(this.repos, conv, messageId)}\n\n---\n\n사용자 메시지: ${text}`;
        // 이 메시지가 새 세션 윈도우의 시작 → 요약 범위(from_message_id) 기준점으로 기록한다.
        await this.repos.conversations.setFirstMessageId(conv.id, messageId);
        if (conv.isPrivate && conv.primaryUserId === this.ownerId) {
          await this.repos.conversations.setPrivateMemoryLoaded(conv.id, true);
        }
      }

      const context: TurnContext = { role, isPrivate: conv.isPrivate, isOwner, userId, conversationId: conv.id };
      const rapportStage = deriveRapportStage(await this.repos.messages.countUserMessages(userId));
      // Task 7: 능력 안내는 "지금 이 턴에 워커가 실제로 연결돼 있는가"로 갈린다 — agent.ts 의
      // resolveTurnWorker 와 완전히 같은 판정(위치 기반 선택 → registry 로 workerId 조회 → hub
      // 연결 확인)을 여기서도 계산해 페르소나에 싣는다. 예전(shouldConnectWorker)엔 hub.isConnected
      // 를 userId 로 직접 불렀는데, 워커가 registry 에 별도 id 로 등록되는 지금은 그게 항상
      // 어긋난다 — registry 조회를 거치지 않으면 워커가 실제로 연결돼 있어도 이 안내가 늘 "연결
      // 안 됨"으로 나온다. 도구셋 자체는 agent.ts(makeRunAgentTurn)가 같은 함수로 별도로 다시
      // 계산한다 — 두 계산이 어긋나면(예: 이 사이 워커가 끊기면) 프롬프트와 실제 도구가 그 한
      // 턴만 어긋날 수 있지만, "안내 자체가 없거나 늘 거짓"이었던 이전 버그보다는 낫다.
      const worker = await resolveTurnWorker({ context: { isOwner, isPrivate: conv.isPrivate, userId } }, this.registry, this.hub);
      const workerConnected = worker !== null;
      const workspaceDirs = await this.resolveGuestWorkspaceDirs(worker, isOwner, userId);

      // 첨부 파일을 워커에 내려놓는다. 저장 위치는 봇이 정한다 — 모델이 정하면 폴더 격리를
      // 우회할 수 있다(uploadDirFor: 손님은 이미 좁혀진 폴더, 소유자는 워커 루트).
      //
      // 경로 조립은 워커가 한다. 봇은 리눅스 컨테이너고 워커는 윈도우라 여기서 이어붙이면
      // 구분자가 어긋난다 — 폴더와 이름을 따로 넘긴다.
      const savedFiles: string[] = [];
      // 최종 리뷰 Important — 워커에 내려놓기도 전에 거절된 첨부(크기 초과·이름 위험·개수 초과 등,
      // filterFileAttachments 가 이미 사유까지 문자열로 만들어 둔다: "이름(너무 큼)" 등)를
      // 초기값으로 얹는다. 이걸 빠뜨리면 거절 사유가 discord.ts 의 skipped 배열에서 만들어진 뒤
      // 아무 데도 읽히지 않고 사라진다 — 조용히 사라지는 첨부를 없애는 것이 이 기능의 존재
      // 이유이므로, 워커 단계 실패(아래 for 문)와 같은 목록·같은 마커(buildFileMarker)로 합쳐야
      // 한다.
      const failedFiles: string[] = [...rejectedFiles];
      if (files.length > 0) {
        const hub = this.hub;
        if (worker === null || hub === undefined) {
          // 조용히 버리지 않는다 — 이미지가 아닌 첨부를 무시하던 것이 이 기능이 고치려는 문제다.
          // 같은 침묵을 다른 자리에 다시 만들지 않는다.
          for (const f of files) failedFiles.push(`${f.name}(워커가 연결돼 있지 않아 저장 못 함)`);
        } else {
          // 워커는 붙어 있는데 저장할 폴더를 못 찾은 경우(uploadDirFor 가 null — 손님은
          // allowed_dirs 미등록/조회실패로 workspaceDirs 가 비고, 소유자는 워커가 작업 폴더를
          // 하나도 보고하지 않은 경우)는 연결 문제가 아니다. 위와 같은 문구를 쓰면 사람이 워커
          // 연결부터 확인하러 가서 헛수고한다 — 원인마다 다른 문구를 내야 그 사람이 맞는 곳
          // (허용 폴더 등록)을 본다.
          //
          // 최종 리뷰 Critical: isOwner 를 반드시 함께 넘긴다(attachments.ts 의 uploadDirFor
          // 선언부 참고) — 신원 없이 workspaceDirs 의 모양만 보면 "손님인데 폴더가 없다"와
          // "소유자라 안 좁힌다"가 같은 모양이 될 수 있어, 손님이 워커 루트로 조용히 폴백하는
          // 폴더 격리 우회가 생겼었다.
          const dir = uploadDirFor({ isOwner, workspaceDirs, workerRoots: hub.rootsOf(worker.workerId) });
          if (dir === null) {
            for (const f of files) failedFiles.push(`${f.name}(허용된 저장 폴더가 없어 저장 못 함)`);
          } else {
            for (const f of files) {
              try {
                const r = await hub.call(worker.workerId, "file_fetch", { url: f.url, dir, name: f.name });
                if (r.ok) savedFiles.push(r.content);
                else failedFiles.push(`${f.name}(${r.content})`);
              } catch (err) {
                // 받아오기 실패가 대화를 막지 않는다 — 이미지 다운로드 실패와 같은 원칙이다.
                failedFiles.push(`${f.name}(${err instanceof Error ? err.message : String(err)})`);
              }
            }
          }
        }
      }

      // 저장 경로를 이번 턴 프롬프트에 싣는다. 이미지와 달리 파일은 모델에게 실리는 것이 없어,
      // 여기서 알리지 않으면 모델이 그 파일의 존재도 위치도 모른다. prompt 는 :443/:447 에서
      // 이미 조립됐지만 그때는 워커를 정하기 전이라 경로가 없었다. DB 기록(ingest, 위 messages.insert)은
      // 건드리지 않는다 — 그 시점엔 아직 받아오기 전이라 저장 경로가 없고, 파일명만 적으면 사실이
      // 아닌 것을 기록하게 된다.
      prompt = buildFileMarker(prompt, savedFiles, failedFiles);
      const systemPrompt = buildSystemPrompt({ role, isPrivate: conv.isPrivate, isOwner, deployTarget: this.config.deployTarget, rapportStage, workerConnected, emotions: this.emotions, workspaceDirs });
      const onProgress = (u: ProgressUpdate) => {
        this.bus.publish({ type: "progress", channel: "discord", channelRef: conv.discordChannelId, text: formatProgress(u, workspaceDirs), ts: this.now() });
        // 기록은 도구 호출이 끝난 시점에만 남긴다(tool 이벤트는 짝이 맞춰져 이 한 행에 흡수된다).
        // 부가 기능이므로 실패해도 턴을 죽이지 않는다 — hub.ts 의 touchLastSeen 과 같은 패턴.
        if (u.kind !== "tool_result") return;
        void this.repos.actions
          .record({
            ts: this.now(), conversationId: conv.id, userId,
            tool: u.name ?? "(unknown)", input: u.input,
            resultSummary: u.summary, status: u.ok ? "ok" : "error", durationMs: u.durationMs,
          })
          .catch((err) => console.error("[core] 도구 기록 실패:", err));
      };

      // 이 턴에만 쓰는 이미지 다운로드(§6: DB엔 마커만 저장했으므로, 과거 이미지 재주입은 없다 —
      // 여기서 받는 images 는 이번 턴의 것뿐이다. 크래시복구 재개 시엔 images=[] 로 들어온다).
      // §8: 다운로드가 전부/일부 실패하면 모델이 이미지를 못 보고 텍스트만 받아 오답/환각할 수
      // 있으므로, 사용자에게 안내한다(턴 자체는 계속 진행 — 텍스트만으로라도 답한다).
      let imageInputs: ImageInput[] = [];
      if (images.length > 0) {
        const dl = await downloadImages(images, { fetchImpl: this.fetchImpl });
        imageInputs = dl.inputs;
        if (dl.failed.length > 0) {
          this.bus.publish({ type: "system_notice", channel: "discord", channelRef: conv.discordChannelId, text: `이미지 ${dl.failed.length}장을 불러오지 못했어요.`, ts: this.now() });
        }
      }

      let result: TurnResult;
      try {
        result = await this.runTurn({ prompt, systemPrompt, resume, cwd: this.agentCwd, context, onProgress, images: imageInputs });
      } catch (err) {
        if (resume && isSessionNotFound(err)) {
          // resume 세션이 SDK 쪽에 없음(클라우드 컨테이너 재배포/재시작으로 세션 저장소가 초기화됨 등)
          // → 그 세션을 버리고 새 세션 + 기억 컨텍스트로 재시도한다(대화 연속성 유지).
          console.warn("[core] resume 세션 없음 — 새 세션으로 재시도:", conv.id);
          await this.repos.conversations.setSession(conv.id, null, this.now());
          const fresh = (await this.repos.conversations.getById(convId)) ?? conv;
          // Task 3: 이 재시도 prompt 는 위 prompt 변수를 재사용하지 않고 buildContextBlock 으로
          // 처음부터 새로 조립하므로, 저장 경로 마커도 여기서 다시 입혀야 한다 — 안 그러면 resume
          // 실패(클라우드 재배포 등, 드물지 않게 이미 일어나는 경로)와 파일 첨부가 겹친 턴에서
          // 재시도 쪽 prompt 에서만 마커가 조용히 사라진다. savedFiles/failedFiles 는 위에서 이미
          // 받아오기가 끝난 값이라 재조회 없이 그대로 재사용한다(파일을 다시 받아오지 않는다).
          const retryPrompt = buildFileMarker(
            `${await buildContextBlock(this.repos, fresh, messageId)}\n\n---\n\n사용자 메시지: ${text}`,
            savedFiles, failedFiles,
          );
          await this.repos.conversations.setFirstMessageId(conv.id, messageId);
          if (conv.isPrivate && conv.primaryUserId === this.ownerId) {
            await this.repos.conversations.setPrivateMemoryLoaded(conv.id, true);
          }
          result = await this.runTurn({ prompt: retryPrompt, systemPrompt, resume: undefined, cwd: this.agentCwd, context, onProgress, images: imageInputs });
        } else {
          throw err;
        }
      }

      if (!result.ok) {
        await this.notify(conv, `비서 처리 중 오류가 있었어요: ${result.text}`);
        return;
      }
      if (result.text.trim().length === 0) {
        // 성공했지만 최종 텍스트가 비어 있음(도구만 호출하고 끝낸 경우 등). 빈 메시지는 저장/발행하지 않는다.
        await this.notify(conv, "이번엔 드릴 답을 만들지 못했어요. 다시 한 번 말씀해 주세요.");
        return;
      }

      await this.repos.messages.insert({ conversationId: conv.id, ts: this.now(), role: "assistant", content: result.text });
      await this.repos.conversations.setSession(conv.id, result.sessionId ?? conv.sessionId, this.now());
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId, text: result.text, ts: this.now() });
    } catch (err) {
      // 예외(SDK 프로세스 오류·인증 throw 등)도 종료 이벤트를 반드시 발행해야 한다. 그러지 않으면
      // 어댑터의 finishStatus 가 불려지지 않아 그 채널의 상태 메시지·반응이 유령으로 남고,
      // pendingTriggers(FIFO)가 영구적으로 어긋난다.
      console.error("[core] runConversationTurn 예외:", err);
      const conv = await this.repos.conversations.getById(convId);
      if (conv) {
        await this.notify(conv, "비서 처리 중 예기치 못한 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
      }
    } finally {
      await this.repos.messages.markProcessed(messageId);
    }
  }

  // 부팅 시 미처리 사용자 메시지를 그 대화 문맥으로 재개한다(크래시 복구).
  async recoverPending(): Promise<void> {
    for (const m of await this.repos.messages.unprocessedUserMessages()) {
      const conv = await this.repos.conversations.getById(m.conversationId);
      const userId = m.userId ?? conv?.primaryUserId ?? "";
      const role = await this.repos.users.getRole(userId);
      if (!conv || (role !== "owner" && role !== "allowed")) {
        await this.repos.messages.markProcessed(m.id);
        continue;
      }
      // M-1(최종 리뷰, 의도적으로 고치지 않음): images/files/rejectedFiles 없이(전부 기본값 [])
      // 재개한다. DB 에는 마커 텍스트(§6, buildImageMarker/buildFileMarker 가 만든 문자열)만
      // 남고 원본 첨부 참조(다운로드 URL 등)는 애초에 저장하지 않으므로, 크래시를 넘어 되살릴
      // 값 자체가 없다 — 이미지가 이미 겪던 것과 같은 구조적 성질이고 이 브랜치가 만든 회귀가
      // 아니다. 크래시 시점에 거절됐던 첨부의 사유도 같은 이유로 이 경로에서는 다시 나타나지
      // 않는다.
      this.enqueue(this.turnChains, conv.discordChannelId, () => this.runConversationTurn(conv.id, userId, role, m.content, m.id));
    }
  }

  // /help 안내문. 최종 리뷰 Important 3 — 능력 안내(파일·명령 작업을 시킬 수 있다는 안내)는
  // 워커가 실제로 연결돼 있을 때만 나가야 한다. 판정은 여기서 새로 만들지 않고 runConversationTurn·
  // agent.ts 가 쓰는 것과 완전히 같은 resolveTurnWorker 를 그대로 부른다 — 안내와 집행이 서로 다른
  // 계산에서 나오면 갈린다는 것이 이 저장소가 반복해서 겪은 결함 유형이다(persona.ts 의 FIX4 주석).
  //
  // 조회가 실패해도(레지스트리 DB 오류 등) /help 자체는 반드시 나가야 한다 — 도움말이 통째로
  // 사라지는 것보다 능력 안내 한 문단이 보수적으로 빠지는 편이 낫다. 그래서 실패는 "워커 없음"으로
  // 떨어뜨린다(fail closed: 없는 능력을 있다고 말하지 않는 쪽).
  private async helpText(userId: string, isPrivate: boolean): Promise<string> {
    let workerConnected = false;
    try {
      const worker = await resolveTurnWorker(
        { context: { isOwner: userId === this.ownerId, isPrivate, userId } },
        this.registry,
        this.hub,
      );
      workerConnected = worker !== null;
    } catch (err) {
      console.error("[core] /help 워커 판정 실패 — 능력 안내 없이 진행:", err);
    }
    return renderCommandHelp(workerConnected);
  }

  // 손님에게 자기 작업 폴더 경로를 알려주기 위한 값(persona.ts 의 workspaceDirs). 게이팅에는
  // 쓰이지 않는다 — 실제 판정은 remoteToolHandler 가 매 호출마다 따로 한다. 다만 같은 함수
  // (scopeDirs)와 같은 입력(그 워커의 allowed_dirs)에서 뽑아, 안내와 집행이 갈리지 않게 한다.
  //
  // 소유자는 대상이 아니다: scopeDirs 가 소유자를 좁히지 않아 allowed_dirs 가 곧 "그 사람의
  // 폴더" 하나로 특정되지 않고, 애초에 list_dirs 로 직접 조회할 수 있다. 개인 워커도 대상이
  // 아니다 — 거기엔 손님이 붙지 않는다(resolveWorkerSelector).
  private async resolveGuestWorkspaceDirs(
    worker: { workerId: string; kind: WorkerKind } | null,
    isOwner: boolean,
    userId: string,
  ): Promise<string[] | undefined> {
    if (worker === null || worker.kind !== "shared" || isOwner) return undefined;
    try {
      const dirs = await this.repos.allowedDirs.list(worker.workerId);
      return scopeDirs(dirs, { workerKind: worker.kind, isOwner, userId });
    } catch (err) {
      // 안내용 부가 정보일 뿐이라 실패해도 턴을 죽이지 않는다(경로 없이 진행 — 예전 동작과 같다).
      // scopeDirs 는 joinUnderRoot 를 통해 이상한 userId 를 거부하며 던질 수 있는데, 그 경우
      // remoteToolHandler 도 같은 예외를 fail closed 로 처리하므로 여기서 생략해도 실제 접근이
      // 더 열리지는 않는다 — 안내만 예전처럼 "경로 없음"으로 돌아간다.
      console.error("[core] 손님 작업 폴더 계산 실패 — 경로 안내 없이 진행:", err);
      return undefined;
    }
  }

  // 유휴 대화마다 요약 후 세션을 닫는다(turnChains 로 그 대화의 턴과 직렬).
  async closeIdleConversations(): Promise<void> {
    const cutoff = this.now() - this.idleMs();
    for (const conv of await this.repos.conversations.listActiveIdle(cutoff)) {
      this.enqueue(this.turnChains, conv.discordChannelId, () => this.summarizeAndClose(conv.id));
    }
  }

  private async summarizeAndClose(convId: number): Promise<void> {
    const conv = await this.repos.conversations.getById(convId);
    if (!conv || !conv.sessionId) return;
    if (this.now() - conv.lastActiveTs < this.idleMs()) return; // 그 사이 활동 → 정리 보류

    const isOwner = conv.primaryUserId === this.ownerId;
    // 소유자 대화의 요약도 무제한. 손님 대화 요약만 한도에 포함(초과면 요약은 건너뛰되 세션은 반드시 정리).
    const reserved = isOwner || await this.repos.turns.reserve({
      userId: null, conversationId: conv.id, kind: "summary", ts: this.now(),
      perUserLimit: this.config.maxTurnsPerHourPerUser, globalLimit: this.config.maxTurnsPerHourGlobal,
      ownerReserve: 0, isOwner: false, windowMs: HOUR_MS,
    });
    // 리뷰 #4(MED): 클라우드 재배포/재시작 등으로 세션 저장소가 초기화되면 resume 이 실패할 수
    // 있다(isSessionNotFound 류). 이 요약 시도가 그대로 던지면 예외가 enqueue 의 catch 까지 올라가
    // 아래 compare-and-close 가 전혀 실행되지 않고, 세션이 active 로 고착되어 매 유휴 스윕마다
    // 같은 실패를 반복하며(손님 몫이면 전역 한도까지 소진) 대화가 영원히 안 닫힌다. 요약은
    // "있으면 좋은" 부가 기능이므로, 실패해도 요약만 건너뛰고 아래 세션 정리는 반드시 실행한다
    // (writeSummary 가 예외를 삼키고 false 만 돌려주므로, 그 결과는 여기서 보지 않는다).
    //
    // /기억정리 는 여기와 정반대로 실패하면 아무것도 바꾸지 않는다 — 그쪽은 사용자가 요약을
    // 받으려고 부른 명령이라 밀어놓고 실패하면 대화를 잃고 대신 받은 것도 없다. 두 동작을
    // 하나로 합치지 말 것.
    if (reserved) await this.writeSummary(conv, this.now());
    // compare-and-close: 요약 대상이던 세션이 그대로일 때만 닫는다(동시 생성된 새 세션 보호).
    const fresh = await this.repos.conversations.getById(conv.id);
    if (fresh && fresh.sessionId === conv.sessionId) {
      await this.repos.conversations.setSession(conv.id, null, this.now());
      await this.repos.conversations.setStatus(conv.id, "idle");
    }
  }

  // /새세션 의 본체(ingest 가 그 대화의 turn 체인에 실어 부른다 — 그 이유는 ingest 쪽 주석).
  // LLM 턴 없이 세 가지를 함께 하고 확인을 보낸다.
  // 1) session_id 를 비운다 — 다음 턴에 새 SDK 세션이 열리고 현재 시스템 프롬프트가 적용된다.
  //    resume 된 세션은 만들어질 때의 프롬프트를 유지하므로, 페르소나 파일을 고쳐 배포해도
  //    활발한 DM 에는 반영되지 않는다. 이 명령의 원래 목적이다.
  // 2) 컨텍스트 바닥선을 긋는다 — 이전 대화도 이전 요약도 다음 세션에 싣지 않는다.
  //    데이터는 남는다(소유자는 db_query 로 볼 수 있다).
  // 3) 캐릭터 설정을 지운다 — 페르소나를 바꾼 뒤에도 옛 즉흥 신상이 남으면 새 페르소나와
  //    충돌한다. 가리지 않고 지우는 이유는 그것이 전역이기 때문이다: 방별로 가리면 같은
  //    아사히가 방마다 다른 신상을 갖게 된다(memoriesRepo.characterFacts 주석 참고).
  //
  // 셋 중 캐릭터 설정 삭제만 ingest 에 남겨 두지 않은 이유: (가) 진행 중이던 턴이 그 뒤에
  // remember(scope:"character") 를 쓰면 방금 지운 신상이 되살아난다 — 세션과 똑같은 경합이다.
  // (나) 삭제 개수는 확인 문구에 실리므로 문구를 만드는 시점과 갈리면 안 된다. (다) 무엇보다
  // 확인 문구 자체가 세 가지가 다 끝난 뒤에 나가야 한다 — 이 결함의 본질이 "안 됐는데 됐다고
  // 말한 것"이라, 문구만 먼저 내보내면 고친 의미가 없다.
  //
  // conv 를 인자로 받지 않고 여기서 다시 읽는 것은 compactSession 과 같은 이유다. 다만 그쪽의
  // compare-and-close 같은 세션 비교는 하지 않는다 — 이 명령은 "지금 세션이 무엇이든 끊어라"라서
  // 기다리는 사이 세션이 바뀌었다는 사실이 건너뛸 근거가 되지 못하고(그래도 사용자는 끊기를
  // 원한다), 요약과 달리 버려질 결과물도 없다.
  //
  // Important 3(최종 전체 브랜치 리뷰) — 어떤 경로로 끝나든 정확히 한 건을 발행한다(아래
  // commandFailed 주석). channelRef 를 인자로 받는 이유도 거기에 적었다.
  private async resetSession(convId: number, channelRef: string): Promise<void> {
    try {
      const conv = await this.repos.conversations.getById(convId);
      // 대화 행을 지우는 코드는 이 저장소에 없으므로 실제로는 닿지 않는다. 그래도 조용히
      // 돌아가지 않는 이유는 아래 commandFailed 와 같다 — 발행 없이 끝나는 갈래를 하나라도
      // 남기면 그 갈래가 채널을 영구히 어긋나게 한다.
      if (!conv) return this.commandFailed(channelRef, "/새세션", new Error(`대화를 찾지 못했다: ${convId}`));
      const t = this.now();
      await this.repos.conversations.setSession(conv.id, null, t);
      await this.repos.conversations.setContextFloor(conv.id, t);
      const cleared = await this.repos.memories.deleteCharacterFacts();
      // Minor 4(최종 전체 브랜치 리뷰) — "N개도 지웠어"만으로는 그 삭제가 이 방에만 걸린다고
      // 읽힌다. scope='character' 는 유저·대화 스코프가 없어 어느 방에서 쳐도 전부 지워지고,
      // 손님이 자기 DM 에서 쳐도 소유자 방의 캐릭터 canon 이 함께 사라진다. 권한 모델은 그대로
      // 둔다(쓰기가 이미 전역이라 비우기만 막는 것이 앞뒤가 안 맞는다) — 말해주지 않던 것만 고친다.
      const factNote = cleared > 0 ? ` 지어낸 설정 ${cleared}개는 모든 방에서 지웠어.` : "";
      this.bus.publish({
        type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId,
        text: `…알겠어. 여기까지 나눈 얘기는 안 가져갈게.${factNote} 기억해둔 건 그대로 있어.`,
        ts: t,
      });
    } catch (err) {
      this.commandFailed(channelRef, "/새세션", err);
    }
  }

  // 세션 예약어 본체가 실패했을 때 나가는 한 건. runConversationTurn 의 catch(그쪽 주석)와 같은
  // 이유로 존재한다: 어댑터는 이 메시지를 큐에 넣는 시점에 이미 원본 메시지에 ⏳ 를 달고 채널별
  // FIFO(discord.ts 의 pendingTriggers)에 밀어 넣었고, 그 큐는 나가는 assistant_message·
  // system_notice 한 건마다 하나씩 꺼내진다. 본체가 한 건도 발행하지 않고 끝나면 그 ⏳ 가 안
  // 풀릴 뿐 아니라 그 채널의 이후 모든 턴이 한 칸씩 밀린 엉뚱한 메시지에 ✅ 를 단다 — 되돌아오지
  // 않는 어긋남이다. 두 명령의 본체(resetSession·compactSession)에는 이 보장이 없었다.
  //
  // notify 가 아니라 bus.publish 를 직접 쓰는 이유: notify 는 messages 행을 먼저 넣는데, 이
  // 경로가 존재하는 이유인 실패(리포 호출이 던지는 것)가 바로 그 쓰기도 함께 막는 종류의
  // 실패다. 같은 이유로 channelRef 도 여기서 다시 조회하지 않고 호출부가 인자로 넘겨준다 —
  // conv 조회 자체가 던지는 경우까지 덮으려면 DB 를 한 번도 안 거치는 값이어야 한다. 그 값은
  // ingest 가 이미 들고 있는 conv.discordChannelId 다(성공 경로가 발행하는 곳과 같은 값이라
  // 새로운 비대칭을 만들지 않는다).
  private commandFailed(channelRef: string, command: string, err: unknown): void {
    console.error(`[core] ${command} 처리 실패:`, err);
    this.bus.publish({
      type: "system_notice", channel: "discord", channelRef,
      text: `${command} 처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.`,
      ts: this.now(),
    });
  }

  // /기억정리 의 본체(ingest 가 그 대화의 turn 체인에 실어 부른다 — 그 이유는 ingest 쪽 주석).
  // invokerId 는 명령을 친 사람이다. conv 를 인자로 받지 않고 여기서 다시 읽는 이유: 큐에서
  // 기다리는 동안 앞선 턴이나 /새세션 이 세션을 바꿨을 수 있어, ingest 시점의 스냅샷으로
  // 판단하면 이미 없는 세션을 요약하려 들 수 있다(summarizeAndClose 와 같은 이유·같은 모양).
  //
  // Important 3(최종 전체 브랜치 리뷰) — resetSession 과 마찬가지로 어떤 경로로 끝나든 정확히
  // 한 건을 발행한다(commandFailed 주석). 아래 갈래별 publish·notify 는 각각 뒤에 곧바로
  // return 이 붙어 서로 겹치지 않고, bus.publish 는 구독자 예외를 자기가 삼키므로(events/bus.ts)
  // 발행 뒤에 이 catch 로 떨어져 두 번 나가는 경우도 없다.
  private async compactSession(convId: number, invokerId: string, channelRef: string): Promise<void> {
    try {
      await this.compactSessionBody(convId, invokerId);
    } catch (err) {
      this.commandFailed(channelRef, "/기억정리", err);
    }
  }

  // compactSession 의 본문. 갈래가 많아(세션 없음·한도·요약 실패·세션 바뀜·성공) try 블록으로
  // 통째로 감싸면 들여쓰기 한 겹이 더 생겨 그 갈래들이 읽기 어려워지므로, 감싸는 쪽과 본문을
  // 나눈다 — 보장(정확히 한 건 발행)은 위 compactSession 이 지고, 여기는 원래 모양 그대로 둔다.
  private async compactSessionBody(convId: number, invokerId: string): Promise<void> {
    const conv = await this.repos.conversations.getById(convId);
    // resetSession 과 같은 이유로 조용히 돌아가지 않는다 — 발행 없이 끝나는 갈래를 남기면
    // 그 갈래가 채널을 영구히 어긋나게 한다(commandFailed 주석).
    if (!conv) throw new Error(`대화를 찾지 못했다: ${convId}`);
    const publish = (text: string, ts: number) =>
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId, text, ts });

    if (!conv.sessionId) {
      publish("정리할 대화가 없어. 아직 이 세션에서 얘기한 게 없거든.", this.now());
      return;
    }

    // 손님 한도: 이 명령은 실제 LLM 턴을 하나 돌리므로 runConversationTurn·조사 예약어와 같은
    // 규칙을 그대로 탄다 — 소유자(신원 기준)는 무제한, 손님은 시간당 한도에 포함. 판정 기준은
    // 대화 주인(conv.primaryUserId)이 아니라 명령을 친 사람(invokerId)이다: 어댑터는 이미 있는
    // 스레드에 들어온 손님에게도 그 스레드의 primaryUserId 를 그대로 실어 주므로(discord.ts 의
    // existingPrimaryUserId), 대화 주인으로 재면 손님이 소유자 소유 스레드에서 한도 없이 요약
    // 턴을 연타할 수 있다. 유휴 스윕은 부른 사람이 없어 대화 주인을 쓰지만, 여기는 있다.
    // 세션 확인보다 뒤에 두는 이유는, 요약할 것이 없으면 턴 자체를 안 돌리므로 손님 몫을 깎을
    // 이유가 없기 때문이다.
    if (invokerId !== this.ownerId) {
      const reserved = await this.repos.turns.reserve({
        userId: invokerId, conversationId: conv.id, kind: "summary", ts: this.now(),
        perUserLimit: this.config.maxTurnsPerHourPerUser, globalLimit: this.config.maxTurnsPerHourGlobal,
        ownerReserve: 0, isOwner: false, windowMs: HOUR_MS,
      });
      if (!reserved) {
        await this.notify(conv, "구독 한도 보호를 위해 잠시 쉬고 있어요. 1시간 안에 다시 시도해 주세요.");
        return;
      }
    }

    // 바닥선과 요약의 created_ts 에 같은 값을 쓴다 — 두 번 시각을 구하면 순서에 따라 방금
    // 만든 요약이 스스로 걸러지는 경합이 생긴다(요약 필터가 created_ts >= floor 이므로).
    const t = this.now();
    const ok = await this.writeSummary(conv, t);
    if (!ok) {
      // 실패하면 아무것도 바꾸지 않는다. 세션과 바닥선을 밀어놓고 요약이 없으면 대화를 잃고
      // 대신 받은 것도 없는 상태가 된다 — 사용자는 요약을 받으려고 이 명령을 부른 것이다.
      // 유휴 스윕(summarizeAndClose)이 "실패해도 세션은 반드시 닫는다"인 것과 반대이며,
      // 그래야 한다: 그쪽은 요약이 부수적이고 이쪽은 요약이 목적이다.
      publish("정리하다 실패했어. 대화는 그대로 두었으니 다시 시도해줘.", this.now());
      return;
    }
    // compare-and-close(summarizeAndClose 와 같은 패턴): 요약한 그 세션이 그대로일 때만 끊는다.
    // turn 체인 직렬화가 대화 턴과의 경합은 이미 막지만, 이 대화의 세션을 바꾸는 경로가 그것뿐이라는
    // 보장은 없다 — 다른 경로가 요약 도중에 새 세션을 만들어 놓았다면, 그것을 끊는 것은 사용자가
    // 시킨 일이 아니고 바닥선도 그 새 대화를 가려 버린다. 이미 저장된 요약 행은 그대로 둔다:
    // 바닥선을 안 그었으니 범위 안에 남아 다음 컨텍스트에 그대로 실린다(버릴 이유가 없다).
    const fresh = await this.repos.conversations.getById(conv.id);
    if (!fresh || fresh.sessionId !== conv.sessionId) {
      publish("정리하는 사이에 새 얘기가 들어와서 그대로 뒀어. 다시 시도해줘.", this.now());
      return;
    }
    await this.repos.conversations.setSession(conv.id, null, t);
    await this.repos.conversations.setContextFloor(conv.id, t);
    publish("…정리했어. 지금까지 얘기는 요약해서 가져갈게.", t);
  }

  // 이 대화의 지금 세션을 요약해 summaries 에 넣는다. 성공하면 true.
  // summarizeAndClose(유휴 스윕)와 compactSession(/기억정리)이 함께 쓴다 — 요약 턴의 안전 플래그
  // (noRemoteTools·noWebTools·noSkills·noMemoryWrite)를 두 곳에서 따로 관리하면 한쪽만 빠뜨렸을 때
  // 아무도 모른다.
  //
  // createdTs 를 인자로 받는 이유: /기억정리 는 요약의 created_ts 와 컨텍스트 바닥선에 반드시
  // 같은 값을 써야 한다. 요약 필터가 created_ts >= floor 라(summariesRepo.recent), 두 번 시각을
  // 구하면 순서에 따라 방금 만든 요약이 스스로 걸러지는 경합이 생긴다.
  //
  // 한도(turns.reserve)는 여기서 잡지 않는다 — 누가 이 턴의 값을 치르는가는 부르는 쪽마다
  // 다르다(유휴 스윕은 대화 주인, /기억정리 는 명령을 친 사람). 호출부가 각자 잡는다.
  private async writeSummary(conv: Conversation, createdTs: number): Promise<boolean> {
    // 요약할 세션이 없으면 할 일이 없다. 두 호출부 모두 이미 확인하고 부르므로 실제로는 닿지
    // 않지만, 아래 resume 에 넘길 값이 있다는 것을 여기서 확정해야 한다.
    if (!conv.sessionId) return false;
    const isOwner = conv.primaryUserId === this.ownerId;
    const role: Role = isOwner ? "owner" : "allowed";
    try {
      const recentMsgs = await this.repos.messages.recent(conv.id, 1);
      const toMessageId = recentMsgs[0]?.id ?? conv.firstMessageId ?? 0;
      const result = await this.runTurn({
        prompt: SUMMARY_PROMPT,
        // FIX4(중요, 최종 리뷰): 이 턴은 noRemoteTools 로 원격 도구를 강제로 닫으므로(아래),
        // 페르소나에도 항상 workerConnected:false 를 실어 "안내와 실제 도구"가 어긋나지 않게
        // 한다 — 실제 hub 연결 상태를 여기서 다시 물어 true 가 나오더라도, 이 턴 자체는
        // noRemoteTools 때문에 fs_*/sh_exec 를 못 쓰므로 그 상태를 그대로 안내하면 FIX3 가
        // 고친 것과 같은 종류의 거짓 안내(도구는 없는데 있다고 말하는)가 새로 생긴다.
        systemPrompt: buildSystemPrompt({ role, isPrivate: conv.isPrivate, isOwner, deployTarget: this.config.deployTarget, workerConnected: false, emotions: this.emotions }),
        resume: conv.sessionId, cwd: this.agentCwd,
        context: { role, isPrivate: conv.isPrivate, isOwner, userId: conv.primaryUserId, conversationId: conv.id },
        // FIX4: 유휴 요약은 사람이 지켜보지 않는 타이머로 돌고, 이전에 모델이 읽은 파일 등을
        // 통해 프롬프트 인젝션이 심어졌을 수도 있는 세션을 그대로 이어받는다(resume). 워커
        // 연결 여부·소유자 신원과 무관하게 원격 도구(fs_*/sh_exec, FIX2 로 같은 축에 묶인
        // allow_dir 등)를 강제로 닫는다.
        noRemoteTools: true,
        // FIX3(중요, 최종 리뷰 3차): noRemoteTools 는 이름 그대로 원격 도구 축만 잠그고 SDK
        // 내장 WebSearch 는 건드리지 않는다 — 이 브랜치로 모든 턴이 웹 검색을 갖게 되면서, 이
        // 무인 요약 턴도 실제로는 WebSearch 를 그대로 쓸 수 있었다(리뷰 재현: db_schema/
        // db_query 로 소유자 DB 전체를 읽을 수 있는 턴에 외부로 내보낼 통로까지 열려 있었던
        // 셈). 요약은 이미 끝난 대화를 요약할 뿐 검색이 필요 없으므로, 별도 플래그로 함께 닫는다.
        noWebTools: true,
        // 스킬도 같은 이유로 닫는다 — 이 턴은 사람이 지켜보지 않고, 요약에 스킬이 필요없다.
        // 판단(M-4, 후속 리뷰): 위 workerConnected:false 와 달리, 이 systemPrompt 는 스킬이
        // 닫혔다는 사실을 반영하지 않는다 — buildCapabilityBlock 의 스킬 안내 문장은
        // PersonaContext 의 어떤 필드로도 조건화돼 있지 않아 이 턴에도 그대로 실린다. 의도적으로
        // 고치지 않는다: 그 문장은 "있을 수 있습니다 … 있으면"으로 헤지된 존재-확인 안내일 뿐
        // fs_*/sh_exec 안내처럼 특정 도구를 쓸 수 있다고 단언하지 않고, 이 턴의 프롬프트
        // (SUMMARY_PROMPT)는 "요약 텍스트만 출력"을 지시해 모델이 스킬 사용을 시도할 여지 자체가
        // 없다 — workerConnected 불일치가 막는 위험(모델이 실제로 fs_*/sh_exec 를 시도해 되는
        // 줄 아는 것)과 같은 종류가 아니다. 고치려면 PersonaContext 에 축을 하나 더 넣어야
        // 하는데, 이 한 줄의 실익이 그 비용에 못 미친다고 보고 넘어간다 — 다음에 같은 불일치를
        // 다시 발견하면 이 주석부터 읽을 것.
        noSkills: true,
        // Important 2(리뷰 후속): 이 턴은 대화 주인(conv.primaryUserId)의 신원으로 서므로, 소유자
        // 스레드에 들어온 손님이 /기억정리 를 치면 손님이 쓴 텍스트가 담긴 세션을 소유자 도구셋
        // (remember·forget 포함)으로 이어받게 된다 — 위 FIX3/FIX4 가 막으려던 인젝션 면과 같은
        // 면이다. 요약 턴은 기억을 건드릴 일이 전혀 없으므로, 그 축을 통째로 닫는다(정기 게시
        // 턴과 같은 조치). Important 2(최종 전체 브랜치 리뷰)로 character_fact 까지 이 축에
        // 묶였다 — 손님 DM 의 유휴 요약 턴이 실측으로 그 도구를 들고 돌았고, 그것이 넣는
        // scope='character' 행은 방을 가리지 않아 소유자 방에도 그대로 실린다.
        //
        // 이 플래그가 닫는 것은 기억뿐이다. 네 플래그를 다 세워도 이 턴이 "텍스트 요약만" 하는
        // 상태가 되지는 않는다 — 소유자 DM 에서는 manage_access·db_schema·db_query·runtime_info
        // 가 그대로 남는다(어느 축도 그 넷을 닫지 않는다). 예전 주석은 여기서 "기억이 오염·삭제될
        // 여지 자체가 없다"까지만이 아니라 그 이상을 말했는데, 안전 주석이 실제보다 넓게 적히면
        // 다음 사람이 그 문장을 믿고 확인을 건너뛴다.
        noMemoryWrite: true,
      });
      if (result.ok && result.text.trim().length > 0) {
        await this.repos.summaries.insert({
          conversationId: conv.id, fromMessageId: conv.firstMessageId ?? 0, toMessageId,
          content: result.text.trim(), createdTs,
        });
        return true;
      }
      // Minor(리뷰 후속): 이 두 갈래는 예전엔 아무 말 없이 false 만 돌려줬다 — /기억정리 사용자는
      // "정리하다 실패했어"를 받는데 로그에는 아무것도 없어, 모델이 실패한 것인지 빈 답을 낸
      // 것인지조차 구분할 수 없었다. 아래 catch 와 같은 수준으로 남긴다.
      if (!result.ok) console.warn("[core] 요약 턴이 실패로 끝남:", conv.id, result.text);
      else console.warn("[core] 요약 턴이 빈 텍스트를 돌려줌:", conv.id);
      return false;
    } catch (err) {
      // 예외를 밖으로 던지지 않는다 — 유휴 스윕은 이 실패에도 세션을 반드시 닫아야 하고
      // (summarizeAndClose 의 리뷰 #4 주석), /기억정리 는 false 를 받아 아무것도 바꾸지 않는다.
      console.warn("[core] 요약 턴 실패:", conv.id, err);
      return false;
    }
  }

  private async notify(conv: Conversation, text: string): Promise<void> {
    await this.repos.messages.insert({ conversationId: conv.id, ts: this.now(), role: "system", content: text });
    this.bus.publish({ type: "system_notice", channel: "discord", channelRef: conv.discordChannelId, text, ts: this.now() });
  }

  private idleMs(): number {
    return this.config.sessionIdleMinutes * 60 * 1000;
  }
}
