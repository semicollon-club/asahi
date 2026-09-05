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
export type AssistantMessageEvent = { type: "assistant_message"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type SystemNoticeEvent = { type: "system_notice"; channel: ChannelKind; channelRef: string; text: string; ts: number };
// 턴 처리 중 진행 상황(도구 호출/결과/답변 시작 등)을 알리는 이벤트(2B). 실제 표시(전송·편집)는 어댑터 쪽 책임.
export type ProgressEvent = { type: "progress"; channel: ChannelKind; channelRef: string; text: string; ts: number };
// 파일 반환(2026-09-05, 풀 하네스 0단계): 워커가 봇의 POST /files 로 올린 파일을 그 대화 채널에 첨부로
// 보내라는 이벤트. 다섯 이벤트 중 유일하게 텍스트가 아니라 바이트(data)를 나른다. 발행자는 코어의 턴이
// 아니라 HTTP 핸들러(core/fileReturn.ts)다 — 턴 도중 도구 호출로 나가는 부수 전송이라 어댑터는 이 이벤트로
// 진행 표시(상태 메시지·⏳ 반응)를 끝내지 않는다(adapters/discord.ts).
export type AssistantFileEvent = { type: "assistant_file"; channel: ChannelKind; channelRef: string; name: string; data: Buffer; ts: number };
export type AgentEvent = UserMessageEvent | AssistantMessageEvent | SystemNoticeEvent | ProgressEvent | AssistantFileEvent;

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
