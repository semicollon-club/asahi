import type { ImageRef } from "../core/images.js";
import type { FileRef } from "../core/attachments.js";

export type ChannelKind = "discord";

// 어댑터가 라우팅을 확정한 뒤 코어에 넘기는 대화 매핑 힌트(2B).
// 코어는 이 힌트로 conversations 행을 조회/생성(멱등)하고 프라이버시 스코프를 정한다.
export type ConversationHint = {
  kind: "dm" | "thread";
  discordChannelId: string;    // 응답·대화 매핑 열쇠 (DM 채널 또는 스레드 채널)
  originMessageId?: string;    // 멱등키: 스레드를 처음 연 트리거 메시지 id (thread-create/adopt)
  guildId?: string;
  parentChannelId?: string;
  isPrivate: boolean;          // DM=true, 서버/스레드=false
  primaryUserId: string;       // 대화의 주 사용자(DM 상대·스레드 개설자)
  userId: string;              // 이번 발화자
  role: "owner" | "allowed";   // blocked/미등록은 애초에 이벤트를 발행하지 않음
  discordMessageId: string;    // 사용자 메시지 id (저장·중복방지)
  // 이번 발화자의 디스코드 표시 이름. 프롬프트에 "누가 말했는가"를 싣는 데만 쓴다(core.ts).
  // 어댑터가 이미 알고 있는 값이라(discord.ts 의 users.upsert) 코어가 매 턴 DB 를 다시 조회하지
  // 않게 하려고 힌트로 나른다. 복구 경로(recoverPending)에는 힌트가 없어 이름 없이 간다.
  displayName?: string;
  // 일반 채널에서 멘션 없이 들어온 예약어(isChannelCommand). 코어는 이 힌트로 conversations 행을
  // 조회하지도 만들지도 않는다 — 만들면 그 채널이 봇 대화로 굳어(decideRoute 의 hasConversation)
  // 이후 그 채널의 모든 메시지에 답하게 된다. 명령 하나를 처리하고 끝나므로 메시지 저장·LLM
  // 대화 턴도 거치지 않는다.
  commandOnly?: true;
};

// rejectedFiles: filterFileAttachments(attachments.ts)가 걸러낸 첨부의 거절 사유 문자열
// (예: "big.pdf(너무 큼)"). files 와 달리 워커에 내려받을 것이 없으므로 FileRef 가 아니라
// 사유 텍스트 그대로 나른다 — core.ts 가 이 값을 failedFiles 의 초기값으로 얹어야 거절된
// 첨부가 조용히 사라지지 않는다(최종 리뷰 Important).
export type UserMessageEvent = { type: "user_message"; channel: ChannelKind; channelRef: string; text: string; ts: number; hint?: ConversationHint; images?: ImageRef[]; files?: FileRef[]; rejectedFiles?: string[] };
// triggerId(빠른 개선 2차, 2026-11-25 리뷰): 이 종료 이벤트를 낸 턴을 시작시킨 디스코드 메시지 id. 어댑터는 반응 순번을 지금처럼
// 맨 앞부터 꺼내되, 꺼낸 메시지가 이 값과 같을 때만 긴 작업 완료 알림을 보낸다 — 순번이 어긋난 때(대화 안 /help 등) 엉뚱한 사람을
// 부르지 않게. 대화 턴(runConversationTurn)의 종료 이벤트만 싣고, 나머지는 비워 둔다(그러면 알림이 없다).
export type AssistantMessageEvent = { type: "assistant_message"; channel: ChannelKind; channelRef: string; text: string; ts: number; triggerId?: string };
export type SystemNoticeEvent = { type: "system_notice"; channel: ChannelKind; channelRef: string; text: string; ts: number; triggerId?: string };
// 턴 처리 중 진행 상황(도구 호출/결과/답변 시작 등)을 알리는 이벤트(2B). 실제 표시(전송·편집)는 어댑터 쪽 책임.
// kind(2026-11-25, N1): 그 줄이 무엇에서 나왔는가. 어댑터가 머리줄의 단계 수(tool 의 개수)를 세고, 끝난 뒤 기록에서
// 최종 답의 첫 문장인 마지막 note 를 빼려면 줄의 종류를 알아야 한다. notice 는 진행 중 턴에 덧붙이는 안내(도중에 온
// 메시지·중지 요청)다. 선택인 이유: 종류를 모르는 발행자도 지금처럼 줄만 보낼 수 있다(단계로 세지 않을 뿐이다).
export type ProgressKind = "tool" | "tool_result" | "note" | "answering" | "notice";
// record(2026-11-25 리뷰): 끝난 뒤 남는 기록에 실을 줄이 text 와 다를 때만 싣는다 — 도구 결과의 요약(출력 첫 줄)은 진행 중
// 표시에만 보이고 공개 스레드에 영구히 남지 않게 한다(core.ts 의 formatProgressRecordLine). 없으면 text 를 그대로 쓴다.
export type ProgressEvent = { type: "progress"; channel: ChannelKind; channelRef: string; text: string; ts: number; kind?: ProgressKind; record?: string };
// 파일 반환(2026-09-05, 풀 하네스 0단계): 워커가 봇의 POST /files 로 올린 파일을 그 대화 채널에 첨부로
// 보내라는 이벤트. 다섯 이벤트 중 유일하게 텍스트가 아니라 바이트(data)를 나른다. 발행자는 코어의 턴이
// 아니라 HTTP 핸들러(core/fileReturn.ts)다 — 턴 도중 도구 호출로 나가는 부수 전송이라 어댑터는 이 이벤트로
// 진행 표시(상태 메시지·⏳ 반응)를 끝내지 않는다(adapters/discord.ts).
export type AssistantFileEvent = { type: "assistant_file"; channel: ChannelKind; channelRef: string; name: string; data: Buffer; ts: number };
// 턴을 끝내지 않는 한 줄(2026-11-25). assistant_message·system_notice 는 어댑터에서 "그 채널의 턴이 끝났다"로 읽혀
// 진행 상태 메시지를 정리하고 반응 순번(pendingTriggers)을 하나 넘긴다 — 진행 중인 턴과 무관한 알림(소유자 DM 경보,
// 취소 요청에 대한 "멈출 작업이 없어요" 등)을 그 둘로 보내면 다른 턴의 상태를 엉뚱하게 닫는다. 이 이벤트는 전송
// 체인에만 합류한다(assistant_file 과 같은 자리). warn 이면 어댑터가 경고 표시를 붙인다(system_notice 와 같은 표시).
export type SideNoticeEvent = { type: "side_notice"; channel: ChannelKind; channelRef: string; text: string; ts: number; warn?: true };
// 진행 중인 턴을 멈춰 달라는 요청(N2, 2026-11-25). 어댑터가 상태 메시지의 중지 버튼 클릭에서 발행하고 코어의
// requestCancel 이 받는다 — 예약어 /취소 는 user_message 로 와서 코어의 ingest 가 같은 함수로 보낸다. 권한 판정(시킨
// 사람·소유자)은 코어가 한다. 어댑터는 그 클릭이 등록된 사람의 것인지만 거른다.
export type CancelRequestEvent = { type: "cancel_request"; channel: ChannelKind; channelRef: string; userId: string; ts: number };
// 사용자가 아직 끝나지 않은 턴의 메시지를 고쳤다(빠른 개선 2차 §3.5, 2026-11-25). 어댑터가 messageUpdate 에서 내용이 실제로 바뀐
// 경우, 그리고 그 메시지가 반응 순번(아직 끝나지 않은 턴)에 있을 때만 낸다. text 는 처음 받을 때와 같이 만든 본문이다(봇 멘션 제거·
// 답장 인용). 코어는 아직 시작하지 않은 메시지면 고친 내용으로 처리하고, 이미 시작한 턴의 것이면 반영되지 않았다고 알린다.
export type UserMessageEditEvent = { type: "user_message_edit"; channel: ChannelKind; channelRef: string; discordMessageId: string; userId: string; text: string; ts: number };
// 대기 중이던 메시지가 앞 턴에 묶여 처리됐다(빠른 개선 2차 §3.6). 어댑터는 메시지마다 👀 를 달았으므로 그 몫의 순번도 닫아야 한다 —
// 이 이벤트는 상태 메시지를 건드리지 않고 순번 하나만 ✅ 로 바꾼다. 묶인 턴의 종료 이벤트(답) 뒤에, 묶인 메시지 수만큼 차례로 온다.
export type TurnMergedEvent = { type: "turn_merged"; channel: ChannelKind; channelRef: string; ts: number };
export type AgentEvent =
  | UserMessageEvent | AssistantMessageEvent | SystemNoticeEvent | ProgressEvent | AssistantFileEvent | SideNoticeEvent | CancelRequestEvent
  | UserMessageEditEvent | TurnMergedEvent;

type Handler = (e: AgentEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<AgentEvent["type"], Handler[]>();

  subscribe<T extends AgentEvent["type"]>(
    type: T,
    handler: (e: Extract<AgentEvent, { type: T }>) => void | Promise<void>,
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as Handler);
    this.handlers.set(type, list);
  }

  publish(event: AgentEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => console.error(`[bus] 핸들러 오류 (${event.type}):`, err));
        }
      } catch (err) {
        console.error(`[bus] 핸들러 오류 (${event.type}):`, err);
      }
    }
  }
}
