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
  // 일반 채널에서 멘션 없이 들어온 예약어(isChannelCommand). 코어는 이 힌트로 conversations 행을
  // 조회하지도 만들지도 않는다 — 만들면 그 채널이 봇 대화로 굳어(decideRoute 의 hasConversation)
  // 이후 그 채널의 모든 메시지에 답하게 된다. 명령 하나를 처리하고 끝나므로 메시지 저장·LLM
  // 대화 턴도 거치지 않는다.
  commandOnly?: true;
};

export type UserMessageEvent = { type: "user_message"; channel: ChannelKind; channelRef: string; text: string; ts: number; hint?: ConversationHint; images?: ImageRef[]; files?: FileRef[] };
export type AssistantMessageEvent = { type: "assistant_message"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type SystemNoticeEvent = { type: "system_notice"; channel: ChannelKind; channelRef: string; text: string; ts: number };
// 턴 처리 중 진행 상황(도구 호출/결과/답변 시작 등)을 알리는 이벤트(2B). 실제 표시(전송·편집)는 어댑터 쪽 책임.
export type ProgressEvent = { type: "progress"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type AgentEvent = UserMessageEvent | AssistantMessageEvent | SystemNoticeEvent | ProgressEvent;

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
