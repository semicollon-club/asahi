import fs from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { FILE_NAME_HEADER, FILE_RETURN_MAX_BYTES } from "../core/fileReturn.js";

// 세션 인프로세스 send_file MCP(풀 하네스 4단계 4.5). 하네스 턴(세션, 계정 B)이 만든 파일을 디스코드로 돌려주는
// 도구다. 얇은 워커 시절에는 원격 도구 executors.send_file 이 같은 일을 했는데(설계 §8), 하네스 턴에는 원격 도구가
// 없으므로 세션 안에서 도는 인프로세스 MCP 도구로 다시 만든다 — 엔드포인트는 같다: 봇의 POST /files(작업 토큰 인증).
//
// 비밀은 없다. 이 도구가 아는 것은 봇의 /files 주소(HUB_URL 에서 유도)와 이 턴의 작업 토큰(frame.token)뿐이고,
// 첨부가 나갈 채널은 그 토큰 안의 channelRef 가 정한다 — 경로도 채널도 모델이 바꿀 수 없다.

export type SendFileDeps = {
  // 봇의 파일 반환 주소(<http base>/files). 워커가 HUB_URL 에서 fileReturnUrlOf 로 유도해 넣는다.
  fileReturnUrl: string;
  // 이 턴의 작업 토큰(frame.token). 봇의 /files 가 검증하고, 그 안의 채널로만 첨부를 보낸다.
  token: string;
  // 작업 폴더(frame.cwd). 이 서브트리 안의 파일만 보낼 수 있다 — 임의 절대경로로 계정 B 의 아무 파일이나 내보내지 못하게.
  cwd: string;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 60_000;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });

// 업로드 본체(테스트가 가짜 fetch·임시 파일로 고정한다). 경로 스코프 → stat(크기·폴더) → 읽기 → POST /files.
export async function sendFileHandler(deps: SendFileDeps, args: { path: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const maxBytes = deps.maxBytes ?? FILE_RETURN_MAX_BYTES;
  // 경로 스코프: cwd 서브트리 안이어야 한다. path.resolve 로 절대화하고 접두를 본다(심링크까지는 보지 않는다 —
  // 소유자 관리자 스코프에서는 지시·옵션 수준의 제한이고, 손님 개방(5단계) 때 realpath 로 굳힌다).
  const resolved = path.resolve(deps.cwd, args.path);
  const root = path.resolve(deps.cwd);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return err(`작업 폴더(${root}) 안의 파일만 보낼 수 있어요. 그 밖의 경로는 보낼 수 없어요: ${args.path}`);
  }
  let size: number;
  try {
    const st = await fs.stat(resolved);
    if (st.isDirectory()) return err("폴더는 보낼 수 없어요 — 파일 하나의 경로를 주세요.");
    size = st.size;
  } catch {
    return err(`파일이 없어요: ${resolved}`);
  }
  if (size > maxBytes) {
    return err(`파일이 디스코드 첨부 상한(${fmtBytes(maxBytes)})을 넘어요 — ${fmtBytes(size)}. 줄이거나 나눠서 보내야 해요.`);
  }
  const name = path.basename(resolved);
  try {
    const bytes = await fs.readFile(resolved);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await (deps.fetchImpl ?? fetch)(deps.fileReturnUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.token}`,
          [FILE_NAME_HEADER]: encodeURIComponent(name),
          "content-type": "application/octet-stream",
        },
        body: bytes,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 413) return err(`봇이 파일을 거절했어요 — 디스코드 첨부 상한을 넘어요.`);
    if (res.status === 401) return err("봇이 업로드 토큰을 거부했어요(만료됐을 수 있어요) — 한 번 더 시도해 보세요.");
    if (!res.ok) return err(`보내지 못했어요(HTTP ${res.status}).`);
    return ok(`${name}(${fmtBytes(size)})을 디스코드에 첨부로 보냈어요.`);
  } catch (e) {
    return err(`보내지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// createSdkMcpServer 로 감싼 인프로세스 MCP 서버. 세션 러너(remote/sessionRunner.ts)가 턴마다 만들어 mcpServers 에
// 넣는다 — 이름은 "file", 도구는 send_file 이라 모델은 mcp__file__send_file 로 본다.
export function makeSendFileServer(deps: SendFileDeps) {
  return createSdkMcpServer({
    name: "file",
    version: "1.0.0",
    tools: [
      tool(
        "send_file",
        "작업 폴더 안의 파일 하나를 디스코드 대화로 첨부해 보낸다. path 는 작업 폴더 기준 상대경로나 그 안의 절대경로. 만든 산출물(이미지·PDF·캡처)을 사용자에게 돌려줄 때 쓴다.",
        { path: z.string().min(1) },
        async (args) => sendFileHandler(deps, args),
      ),
    ],
  });
}
