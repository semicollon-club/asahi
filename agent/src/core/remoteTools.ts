import { isPathWithinAny } from "./paths.js";
import { extractCandidatePaths } from "./pathPermission.js";
import { scopeDirs } from "./workerSelect.js";
import { PROC_TOOL_NAMES, procNameFor, isValidUserId } from "../remote/proc.js";
import type { ToolCtx } from "./tools.js";

// 워커에서 실행되는 원격 도구 이름. SDK 내장 Read/Write/Edit/Glob/Grep/Bash 를 대체한다.
// 이름을 달리 지은 이유: 내장 도구와 이름이 겹치면 어느 쪽이 도는지 알 수 없다.
// proc_* 넷은 이름 목록을 여기서 다시 적지 않고 proc.ts 의 것을 그대로 편다 — 목록이 두 곳에
// 있으면 한쪽만 늘어나는 날이 오고, 그때 "게이트를 안 타는 도구"가 조용히 생긴다.
export const REMOTE_TOOL_NAMES = [
  "fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "fs_tree", "sh_exec",
  ...PROC_TOOL_NAMES,
] as const;

// 인자에서 1차 필터를 걸 경로를 뽑는다(fs_read/fs_write/fs_edit 용 — fs_glob/fs_grep 은 아래
// LOCAL_TOOL_NAME 경로로 별도 처리한다). sh_exec 는 경로 인자가 없으므로 대상이 아니다 — 뿐만
// 아니라 봇 쪽에서 경로를 아무리 걸러도 셸 명령 자체(파이프·리다이렉트·PATH 탐색 등)는 경로 인자
// 하나로 판정할 수 있는 대상이 아니다(FIX6). sh_exec 의 유일한 경계는 실행 시 cwd(워커 roots[0])와
// 워커 프로세스를 돌리는 OS 계정의 권한뿐이며, 이는 의도된 설계다 — 셸을 경로로 봉쇄하려는 시도는
// 하지 않는다. 아래 remoteToolHandler 의 주석과 .env.example 도 같은 내용을 명시한다.
// 빈 문자열도 "값이 있는" 것으로 그대로 돌려준다 — "인자 없음"과 "빈 인자"는 다른 상태다.
// 후자를 전자로 취급하면 호출부의 1차 필터 전체가 조용히 스킵된다(빈/공백 판정은 호출부의 몫).
function pathArgOf(args: Record<string, unknown>): string | undefined {
  const p = args.path;
  return typeof p === "string" ? p : undefined;
}

// FIX6(중요): fs_glob·fs_grep 는 path 인자가 없어도 pattern(글롭 패턴, fs_grep 은 +glob 검색
// 필터) 자체가 경로를 담을 수 있다. path 유무만으로 필터 전체를 걸고/건너뛰면 (1) path 를
// 생략하면 allowedDirs 검사가 통째로 스킵되어 — 워커는 path 생략 시 roots[0] 를 기본값으로
// 쓰므로 — 빈 allowedDirs 로도 워커 루트 전체를 열거할 수 있었고, (2) path 가 허용 폴더 안이어도
// pattern="../../**/*"(fs_grep 은 glob="../../**/*")같은 값으로 그 밖을 가리키면 봇 쪽은 path 만
// 보고 통과시켰다(워커도 결과를 roots 로만 재검사할 뿐 allowedDirs 는 모른다). 이 두 도구가
// 대체한 로컬 SDK 의 Glob/Grep 도구(canUseTool 이 쓰던 원래 게이트)는 pathPermission.ts 의
// extractCandidatePaths 로 정확히 이 문제를 이미 풀어 뒀다 — 같은 규칙을 두 번 만들지 않고 그대로
// 재사용한다. "path 생략 시 실행기(executors.ts)가 roots[0] 를 기본값으로 쓴다"는 것과 같은
// 정신으로, 여기서는 allowedDirs[0](사용자가 실제로 허용한 첫 폴더)을 extractCandidatePaths 의
// cwd 인자로 넘긴다 — "후보가 하나도 안 나오면 그 기본값을 검사한다"는 이미 검증된 규칙을 그대로
// 태운다. 다만 "검사"만으로는 부족하다 — 아래 remoteToolHandler 본문의 최종 리뷰 FIX1 주석 참고
// (검사에 쓴 기본값을 실제로 args 에 주입해야, 워커가 자신의 roots[0] 을 대신 쓰는 일이 없다).
// fs_tree 도 path 를 생략할 수 있으므로 같은 취급을 받아야 한다. Glob 으로 매핑하는 이유는
// extractCandidatePaths 가 "path 생략 시 기본값을 검사한다"는 규칙을 그대로 태우기 위해서다 —
// fs_tree 에는 pattern 인자가 없으므로 그 부분은 자연히 후보를 만들지 않는다.
const LOCAL_TOOL_NAME: Partial<Record<string, string>> = { fs_glob: "Glob", fs_grep: "Grep", fs_tree: "Glob" };

// 원격 호출은 실패해도 예외를 던지지 않는다 — 도구 하나의 실패가 턴 전체를 죽이면
// 모델이 다른 방법을 시도하거나 사용자에게 알릴 기회 자체가 사라진다.
//
// 신원 재확인은 이제 "ctx.remote 가 있는가" 하나다. 예전에는 isOwnerDm 을 여기서 다시 확인했지만,
// 그 판정은 워커가 소유자 DM 전용이던 시절의 것이다. 지금은 어느 기계를 쓸지 자체가
// resolveTurnWorker(agent.ts) 의 결과이고, 그 결과가 ctx.remote 로 나타난다 — 도구 목록과
// 핸들러가 같은 하나의 판정을 공유하므로 "도구는 보이는데 실행은 거부"가 생기지 않는다.
// 권한 차이는 아래 scopeDirs 가 만든다(손님은 자기 폴더로 좁혀진다).
//
// 경로 검사는 두 겹이다 — 단, fs_read/fs_write/fs_edit/fs_glob/fs_grep 에 한해서다. 여기(봇)는
// 사용자가 allow_dir 로 관리하는 목록(scopeDirs 로 좁혀진 뒤)에 대한 1차 필터로, 왕복 전에
// 빠르게 거르고 안내 문구를 낸다. 최종 판정은 워커(remote/roots.ts)가 한다 — realpath·심볼릭
// 링크·실제 존재 여부를 아는 건 파일시스템을 가진 그쪽뿐이다. sh_exec 는 이 두 겹 중 어느 쪽에도
// 속하지 않는다(FIX6 — 문서만 바로잡을 뿐 동작은 원래도 이랬다): 셸 명령은 경로 인자 자체가 없어
// 위 필터가 적용될 대상이 없고, 워커 쪽(executors.ts)도 sh_exec 는 roots 로 판정하지 않는다 —
// 유일한 경계는 실행 시 cwd(roots[0])와 워커 프로세스를 돌리는 OS 계정의 권한뿐이다. 셸을
// "경로"로 봉쇄하려는 시도는 하지 않는다 — 셸은 애초에 경로 판정이 성립하지 않는다(파이프·
// 서브셸·PATH 탐색 등으로 얼마든지 우회된다). Task 7 로 손님도 공유 기계에서 sh_exec 를 받게
// 되면서 이 한계는 그대로 손님에게도 적용된다 — 공유 기계의 셸 접근은 애초에 폴더 격리로
// 완전히 봉쇄할 수 있는 종류의 권한이 아니다(문서화된, 받아들여진 위험).
//
// 반환은 문자열이 아니라 { content, ok } 다. 예전엔 문자열 하나였는데, 그 순간 워커(executors.ts)와
// 이 함수의 1차 필터가 이미 계산해 둔 성패가 구조적으로 소실됐다 — 호출측(tools.ts 의 textResult)은
// 실을 값 자체가 없으니 MCP 의 isError 를 세울 수 없었고, MCP 는 isError 가 없으면 성공으로 보므로
// tool_result 블록에 is_error:true 가 실릴 경로가 아예 없었다. 그 결과 부원이 겪는 실패 전부가
// `✓ fs_write — 허용된 폴더 밖 경로예요` 처럼 성공으로 표시되고 actions.status 도 'ok' 로 기록됐다
// (이전의 `... 완료` 보다 더 단정적으로 틀린 문장이 된 셈이다). 새 개념을 만들지 않고, 이미 존재하던
// 불리언을 여기서 잇기만 한다.
//
// 분류 규칙은 하나다: 아래 조기 반환은 전부 실패(ok:false)다 — 워커 미연결, 빈 경로, 허용 폴더
// 목록 확인 불가, 허용 폴더 조회 오류, allow_dir 안내, 허용 폴더 밖 경로, 원격 호출 예외. 전부
// "요청한 작업이 수행되지 않았다"는 뜻이고, 사용자에게 보여야 할 사유가 있으며, M2 의 첫 질의
// ("어떤 도구가 자주 실패하는가")가 세어야 할 사건이다. 성공은 워커가 ok:true 를 준 경우뿐이다.
export async function remoteToolHandler(
  ctx: ToolCtx,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ content: string; ok: boolean }> {
  // 거부는 전부 이 헬퍼를 거친다 — 새 조기 반환을 추가하면서 ok 를 빠뜨리는 일이 없게, "거부"라는
  // 낱말 자체가 ok:false 를 뜻하게 만든다.
  const deny = (content: string) => ({ content, ok: false });

  const remote = ctx.remote;
  if (!remote) return deny("지금은 워커가 연결돼 있지 않아 PC 작업을 할 수 없어요.");

  const singlePathArg = pathArgOf(args);
  const localTool = LOCAL_TOOL_NAME[tool];
  // FIX6: fs_glob·fs_grep 는 path 가 없어도(localTool 이 있으면) 아래 필터를 계속 타야 한다.
  // 나머지 도구(fs_read/fs_write/fs_edit)는 path 인자가 있을 때만(기존 방식 그대로) 검사한다.
  // sh_exec 는 path 도 없고 localTool 도 없으므로 이 필터의 대상이 아니다(위 주석 참고).
  const needsPathCheck = singlePathArg !== undefined || localTool !== undefined;

  // proc_* 은 경로 인자가 없어 위 needsPathCheck 가 false 인데도 "이 사람의 폴더가 어디인가"를
  // 알아야 한다 — proc_start 의 cwd 가 바로 그 폴더다. 그래서 스코프 계산(allowedDirs 조회 +
  // scopeDirs)만은 경로 검사와 별개의 조건으로 돌린다. 아래 needsPathCheck 블록(후보 경로 검사와
  // FIX1 주입)은 예전 그대로 경로 도구만 탄다 — 계산을 밖으로 끌어올렸을 뿐, 어떤 도구가 무엇을
  // 검사받는지는 하나도 바뀌지 않았다.
  const isProcTool = (PROC_TOOL_NAMES as readonly string[]).includes(tool);
  const needsScope = needsPathCheck || isProcTool;

  // 리뷰 Finding 3(중요, 컨트롤러 결정): needsScope(=needsPathCheck || isProcTool) 를 타는 도구
  // 전부가 "allowed 가 비어 있으면 안 된다"는 아니다. proc_stop·proc_list·proc_logs 는 아래
  // isProcTool 주입 블록에서 신원 인자(name·onlyUserId)를 allowed 가 아니라 ctx.userId 로부터
  // 무조건 계산한다 — allowed 를 단 한 번도 읽지 않는다. 반면 proc_start 는 allowed[0] 을 cwd 로
  // 그대로 주입해야 하므로(아래) 빈 목록으로는 애초에 진행할 수 없다. 경로 도구(needsPathCheck)도
  // 전부 allowed 로 후보 경로를 검사하므로 마찬가지다.
  //
  // 종전에는 이 네 도구가 전부 "allowed 가 비면 거부"를 공유했는데, 이게 proc_stop·proc_list·
  // proc_logs 에는 보호가 아니라 함정이었다 — 관리자가 회원의 allow_dir 를 회수했는데 그 회원의
  // dev 서버가 여전히 돌고 있으면, 회원도 관리자도 그 프로세스를 멈추거나 로그를 볼 방법이
  // 없어졌고, 그 순간 나가는 안내 문구("allow_dir 로 폴더를 허용해 주세요")조차 이 세 도구와
  // 무관한 조치를 가리켰다. "띄운 것은 항상 멈출 수 있어야 한다"는 컨트롤러의 결정에 따라 이
  // 셋을 뺀다. proc_start 에 대해서는 이 상수가 "빈 allowed 로 주입부까지 흘러가지 않는다"는
  // 불변식을 tool 이름만으로 고정한다(tool === "proc_start" 는 입력과 무관하게 참·거짓이 갈린다) —
  // 아래 deny 가 이 상수를 그대로 조건으로 쓰므로, proc_start 에 대해서는 누가 proc_* 이름을
  // 늘려도 이 판정 하나만 보면 된다.
  //
  // 리뷰 Finding 3(사소함, 표현 정정): 그러나 나머지 셋(proc_stop·proc_list·proc_logs)을 "뺀다"는
  // 것은 tool 이름 하나로 끝나는 고정된 분류가 아니다 — needsAllowedNonEmpty 는 needsPathCheck 를
  // 그대로 물려받고, needsPathCheck 는 tool 이 아니라 args 를 본다(위 pathArgOf 참고). 이 세
  // 도구의 실제 스키마(tools.ts)는 path 인자를 선언하지 않으므로 보통은 needsPathCheck 가 false
  // 지만, 모델이 그래도 문자열 path 를 끼워 보내면 그 호출 한 번만큼은 needsPathCheck(따라서
  // needsAllowedNonEmpty 도) true 로 뒤집힌다 — 종전의 "allowed 비면 거부"와 아래 needsPathCheck
  // 블록의 경로 후보 검사가 그 호출에 한해 그대로 되살아난다. fail closed 방향으로만 움직이므로
  // (거부가 늘 뿐 건너뛰는 검사는 없다) 안전에는 영향이 없다 — 정확한 술어는 "proc_stop·
  // proc_list·proc_logs 이면서 이 호출에 경로 인자가 없다"이지 "proc_stop·proc_list·proc_logs
  // 이다"가 아니다.
  const needsAllowedNonEmpty = needsPathCheck || tool === "proc_start";

  let allowed: string[] = [];
  if (needsScope) {
    // 빈 문자열/공백 문자열은 "경로 인자 없음"이 아니라 "잘못된 경로 인자"다 — 여기서 걸러내지
    // 않으면 아래 필터 전체가 조용히 스킵되고 호출이 그대로 워커로 넘어간다.
    if (singlePathArg !== undefined && singlePathArg.trim().length === 0) {
      return deny("경로가 비어 있어요. 올바른 절대경로를 지정해 주세요.");
    }

    // repos.allowedDirs 가 없는 호출측은 현재 운영 코드(buildToolCtx)에서는 나타나지 않아야
    // 하지만, "판정할 수 없다"를 "통과시킨다"로 처리하면(fail open) 이 1차 필터가 있으나 마나
    // 해진다. 판정 불가 상태의 안전한 기본값은 거부다(fail closed).
    if (!ctx.repos?.allowedDirs) return deny("허용 폴더 목록을 확인할 수 없어 요청을 거부했어요.");

    // Task 7: allowed_dirs 는 워커(remote.workerId) 기준으로 저장된다 — 같은 사람이라도 기계가
    // 다르면(소유자의 노트북 vs 동아리 공용 PC) 목록이 섞이면 안 된다. scopeDirs 가 그 목록을
    // 이 사용자 몫으로 좁힌다 — 공유 워커의 손님은 자기 하위 폴더로, 개인 워커거나 소유자면
    // 그대로(관리자는 좁히지 않는다).
    //
    // 리뷰 Finding 2(사소함, 주석 정정): 예전엔 여기서 "scopeDirs(→joinUnderRoot)가 ctx.userId 를
    // 경로 조각으로 그대로 쓰므로 Discord 스노플레이크가 아닌 값이 오면 예외를 던지고, 아래 catch
    // 가 fail closed 로 막는다"고 적혀 있었다 — 이 지점까지 오는 모든 도구가 반드시 그 검증을
    // 거친다는 전제였다. 그 전제는 proc_stop·proc_list·proc_logs 가 "allowed 가 비면 거부"를 함께
    // 쓰던 동안만 성립했다. joinUnderRoot 는 scopeDirs 가 guest+shared 분기에서 dirs.map(...) 을
    // 돌 때만 불리는데(workerSelect.ts), dirs(이 워커의 allow_dir 원본 목록)가 비어 있으면 map 의
    // 콜백이 한 번도 실행되지 않아 joinUnderRoot 자체가 안 돈다. 아래 needsAllowedNonEmpty 로
    // proc_stop·proc_list·proc_logs 를 그 거부에서 뺀 뒤로는, dirs 가 빈 워커에서 이 셋을 부르면
    // ctx.userId 가 이 catch 는 물론 joinUnderRoot 의 검증도 한 번도 거치지 않은 채로 아래
    // isProcTool 주입까지 도달한다. 오늘은 위험하지 않다 — ctx.userId 는 항상 디스코드 메시지
    // 작성자의 스노플레이크이고(adapters/discord.ts) 회원이 임의 문자열로 바꿔치기할 방법이
    // 없다. 그래도 이 값이 그대로 pm2 프로세스 이름이 되어 셸 명령까지 흘러가므로(executors.ts 의
    // runPm2), 아래 isProcTool 블록 앞에서 방어적으로 한 번 더 확인한다(그 지점의 주석 참고) —
    // 오늘 닿지 않는 경로라는 사실을 이 함수가 스스로 보장하지 않고 호출 습관에만 기대지 않는다.
    try {
      const dirs = await ctx.repos.allowedDirs.list(remote.workerId);
      allowed = scopeDirs(dirs, { workerKind: remote.workerKind, isOwner: ctx.isOwner, userId: ctx.userId });
    } catch (e) {
      // allowedDirs.list 는 실제 DB 호출이라 reject 할 수 있다(아래 허브 콜과 달리 "절대
      // reject 하지 않는다"는 보장이 없다) — 여기서 잡아 문자열로 바꾼다. scopeDirs 가 잘못된
      // 경로 조각을 거부해 던지는 예외도 여기서 같은 방식으로 잡힌다.
      return deny(`허용 폴더 확인 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 리뷰 Finding 3: 위 needsAllowedNonEmpty 가 false 인 도구(proc_stop·proc_list·proc_logs)는
    // allowed 가 비어 있어도 이 줄을 그냥 지나간다 — 문구·조건 자체는 그대로 두고 "누가 이 줄을
    // 맞는지"만 좁혔다.
    if (needsAllowedNonEmpty && allowed.length === 0) return deny("먼저 allow_dir 로 작업할 폴더를 허용해 주세요.");

    // Task 8: 손님의 개인 폴더는 첫 접근 때 만든다("1인당 1폴더"가 규칙이라 없다고 거부할 이유가
    // 없다). 모델에게 시키지 않고 봇이 직접 끼워 넣는다 — 모델이 fs_write 나 sh_exec 로 제각각
    // 만들게 두면 실패 처리도 제각각이 된다. 개인 워커·소유자는 대상이 아니다: 개인 워커는 애초에
    // 그 소유자 한 명 몫이라 "손님용 하위 폴더" 개념이 없고, 소유자는 scopeDirs 가 좁히지 않으므로
    // allowed[0]이 "그 사람의 폴더" 하나로 특정되지 않는다(관리자 권한으로 아무 폴더나 다룬다).
    //
    // 이 생성이 needsPathCheck 가 아니라 needsScope 아래에 있는 이유: proc_start 는 이 폴더를
    // cwd 로 받는데(아래 주입 참고), 폴더가 없으면 pm2 가 그 자리에서 실패한다 — 경로 인자가
    // 없는 도구라고 준비를 건너뛰면 손님의 첫 proc_start 는 항상 실패한다.
    //
    // 이 호출은 매 원격 호출(스코프 계산을 타는 도구는 전부)마다 반복된다 — "최초 1회만" 판정하는
    // 캐시를 일부러 두지 않았다. fs_mkdir(recursive:true)은 이미 있으면 그대로 성공하는 멱등
    // 연산이라 반복 호출 자체에 부작용이 없고, 캐시를 두면 "그 사이 누군가 그 폴더를 지웠다"는
    // 경우를 다음 호출까지 놓친다 — 상태 없이 매번 확인하는 쪽이 더 단순하고 더 안전하다. 비용은
    // 워커 왕복 한 번인데, 이미 각 fs_* 호출 자체가 워커 왕복이므로 자릿수가 하나 늘 뿐이다.
    //
    // 실패해도 그냥 진행한다(.catch(() => {})): 이 생성은 편의를 위한 사전 준비일 뿐 요청의
    // 일부가 아니다 — 실패하는 이유(권한, 디스크 오류 등)는 뒤이은 진짜 호출에서도 똑같이
    // 겪을 테니 거기서 한 번만 사용자에게 보고되면 충분하고, 준비 단계의 실패로 요청 자체를
    // 막을 이유는 없다.
    //
    // 리뷰 Finding 3: allowed.length > 0 을 추가로 확인한다. 위에서 조건을 좁힌 뒤로
    // proc_stop·proc_list·proc_logs 는 allowed 가 빈 채로 바로 이 지점까지 올 수 있게 됐다 —
    // 그때 allowed[0] 은 undefined 라 만들 폴더 자체가 없다(이 셋은 폴더가 아니라 pm2 프로세스
    // 이름으로만 동작한다). 이 셋을 제외한 기존 경로(경로 도구 전부·proc_start)는 위 deny 가
    // 이미 allowed.length > 0 을 보장해 두므로, 이 추가 조건이 그 경로들의 동작을 바꾸지 않는다.
    //
    // 최종 리뷰 지적(Minor, Finding 6): 위 세 가지 조건(shared·손님·allowed 있음)을 전부
    // 만족해도, 이 준비 호출이 실제로 필요한 도구는 그 폴더를 쓰는 도구뿐이다 — 경로 인자가 있는
    // 기존 도구 전부(needsPathCheck)와 proc_start(cwd 로 이 폴더를 받는다)뿐, proc_stop·
    // proc_list·proc_logs 는 isProcTool 이라 needsScope 는 타지만 이 폴더를 구조적으로 전혀
    // 건드리지 않는다. 그런데도 이 호출이 needsScope 조건만 따라가면, 조회성 호출인 proc_list
    // 하나에도 워커 왕복이 하나 더 붙고 읽기 전용 요청이 폴더 생성이라는 부작용을 낳는다.
    // needsPathCheck 는 proc_* 이 아닌 기존 도구에 한해 needsScope 와 정확히 같으므로(위
    // needsScope 선언부 주석 참고), 이 조건을 추가해도 그 도구들의 동작은 그대로다 — 바뀌는
    // 것은 새로 편입된 proc_stop·proc_list·proc_logs 세 도구뿐이다.
    if (remote.workerKind === "shared" && !ctx.isOwner && allowed.length > 0 && (tool === "proc_start" || needsPathCheck)) {
      await remote.call("fs_mkdir", { path: allowed[0] }).catch(() => {});
    }
  }

  if (needsPathCheck) {
    // FIX6: fs_glob/fs_grep 은 path·pattern(fs_grep 은 +glob) 양쪽에서 후보 경로를 뽑는다
    // (extractCandidatePaths 가 path 생략 시 allowed[0] 기본값까지 포함해 처리한다). 나머지
    // 도구는 기존처럼 path 하나만 본다.
    const candidates = localTool
      ? extractCandidatePaths(localTool, args, undefined, allowed[0])
      : singlePathArg !== undefined ? [singlePathArg] : [];
    for (const c of candidates) {
      if (!isPathWithinAny(c, allowed)) return deny(`허용된 폴더 밖 경로예요: ${c}`);
    }

    // 최종 리뷰 FIX1(치명): 위에서 "검사"만 하고 끝내면 안 된다 — fs_glob/fs_grep 은 path 가
    // 생략되면 워커(executors.ts)가 자신의 roots[0](워커 루트, 보통 allowed_dirs 보다 넓다)을
    // 기본값으로 쓴다. 방금 검사에 쓴 allowed[0] 은 봇이 "이 값을 기준으로 검색될 것"이라고
    // 가정하고 확인한 값인데, 실제로 워커에 보내는 args 를 그대로 두면 워커는 그 가정과 무관하게
    // roots[0] 을 쓴다 — "검사한 값"과 "실제로 쓰이는 값"이 달라 검사 자체가 무의미해진다(리뷰
    // 재현: path 없이 fs_grep 을 부르면 워커 루트 전체가 열거됐다). path 를 생략한 경우에 한해,
    // 검사에 쓴 allowed[0] 을 args 에 실제로 주입해 워커로 보낸다 — 사용자가 이미 path 를
    // 지정했다면(singlePathArg !== undefined) 그 값을 존중해 덮어쓰지 않는다.
    if (localTool && singlePathArg === undefined) {
      args = { ...args, path: allowed[0] };
    }
  }

  // 이름·작업 폴더·목록 필터는 검증이 아니라 주입이다. 모델이 name 을 정하게 두면 부원 A 가
  // "B 가 돌리는 서버 좀 꺼줘"로 남의 프로세스를 죽일 수 있다 — 위 FIX1 과 정확히 같은 구조의
  // 문제다(검사한 값과 워커가 실제로 쓰는 값이 다르면 검사 자체가 무의미해진다). 그래서 이름을
  // "검사"하지 않고 아예 봇이 정한다: 모델이 무엇을 넘기든 손님 몫은 procNameFor(ctx.userId)
  // 하나뿐이고, 그 이름이 곧 소유권이자 1인 1개 상한이다(proc.ts).
  //
  // 소유자는 그 기계의 관리자이므로 이름을 지정할 수 있고 목록도 좁히지 않는다 — scopeDirs 가
  // 소유자의 허용 폴더를 좁히지 않는 것과 똑같은 규칙이다(두 곳이 서로 다른 기준을 쓰면 "폴더는
  // 다 보이는데 프로세스는 내 것만 보인다" 같은 앞뒤 안 맞는 권한이 생긴다).
  if (isProcTool) {
    // 리뷰 Finding 2(사소함, 방어적 계층): ctx.userId 가 위 scopeDirs/joinUnderRoot 를 한 번도
    // 거치지 않고(dirs 가 빈 워커) 여기까지 올 수 있는 경로가 생겼다(위 try 블록 주석 참고). 이
    // 값이 procNameFor 를 거쳐 그대로 pm2 프로세스 이름이 되고, runPm2(executors.ts)의 인용은
    // cmd.exe 메타문자까지는 막지 않는다고 스스로 문서화하고 있다 — 오늘은 ctx.userId 가 항상
    // 디스코드 스노플레이크라 닿지 않는 경로지만, "닿지 않는다"를 이 함수가 직접 보장하지 않고
    // 호출측의 습관에만 기대는 것은 paths.ts 의 joinUnderRoot 가 이미 한 번 지적한 것과 같은
    // 종류의 문제다(그 파일의 SEGMENT_PATTERN 주석 참고). proc.ts 가 parseProcName 에서 이미 쓰는
    // 것과 같은 규칙을 isValidUserId 로 내보내 재사용한다 — 새 규칙을 만들지 않는다.
    if (!isValidUserId(ctx.userId)) return deny("사용자 식별자가 올바르지 않아 요청을 거부했어요.");
    const mine = procNameFor(ctx.userId);
    // proc_start 의 cwd 는 위에서 검사·생성까지 끝낸 그 폴더다. 모델이 준 cwd 는 쳐다보지 않는다 —
    // 손님이 cwd 를 고를 수 있으면 폴더 격리가 셸 한 줄로 무너진다.
    //
    // Defect 1(운영 중 발견): 예전엔 여기서 무조건 allowed[0](회원 폴더 루트)을 cwd 로 썼다 —
    // 그런데 프로젝트가 폴더 루트가 아니라 그 아래 하위 폴더(예: "…\<id>\테스트 1\")에 있는 게
    // 보통이라, package.json 을 못 찾고 npm run dev 가 그 자리에서 실패했다. 이제 proc_start 는
    // 선택적 path 인자를 받는다 — pathArgOf 가 이미 "path" 라는 이름의 인자를 읽으므로, path 를
    // 실어 보내는 것만으로 위 needsPathCheck 가 켜지고 기존 후보 경로 검사(allowed 대조)를 그대로
    // 탄다(새 게이트를 만들지 않는다). 여기서는 그 검사에 실제로 쓰인 값(singlePathArg)을 그대로
    // cwd 로 옮길 뿐이다 — FIX1 원칙(검사한 값과 실제로 쓰는 값이 같아야 한다) 그대로다. args.path
    // 는 이 지점까지 오는 동안 한 번도 재작성되지 않았다(proc_start 는 LOCAL_TOOL_NAME 에 없어
    // 위 FIX1 주입 대상이 아니다 — path 가 필수인 fs_read 등과 같은 부류다). path 를 생략하면
    // (singlePathArg===undefined) 예전 그대로 allowed[0]을 쓴다.
    if (tool === "proc_start") args = { ...args, name: mine, cwd: singlePathArg ?? allowed[0] };
    if (tool === "proc_stop" || tool === "proc_logs") {
      args = ctx.isOwner && typeof args.name === "string" && args.name.length > 0 ? args : { ...args, name: mine };
    }
    // 소유자에게도 키를 undefined 로 실어 보낸다(키 자체를 지우지 않는다) — 실행기(executors.ts)는
    // str(args.onlyUserId) 가 undefined 면 필터를 걸지 않으므로 결과는 "전원"이다.
    if (tool === "proc_list") {
      // labels 는 name·cwd·onlyUserId 와 같은 부류다 — 모델이 정하지 않고 여기서 주입한다.
      // 워커는 디스코드를 모르므로 userId 를 사람 이름으로 풀 수 없다(신원 해석은 봇만 한다).
      //
      // 범위는 onlyUserId 가 이미 긋고 있던 경계를 그대로 따른다: 손님은 자기 프로세스만 보므로
      // 자기 이름 하나만, 소유자는 전원을 보므로 전체 맵을 보낸다. 새 프라이버시 경계가 생기지
      // 않는다는 것이 중요하다 — 손님에게 남의 이름이 가지 않는 것은 지금과 똑같다.
      const names = await ctx.repos.users.displayNames();
      const mineName = names[ctx.userId];
      const labels = ctx.isOwner ? names : mineName === undefined ? {} : { [ctx.userId]: mineName };
      args = ctx.isOwner
        ? { ...args, onlyUserId: undefined, labels }
        : { ...args, onlyUserId: ctx.userId, labels };
    }
  }

  let r: { ok: boolean; content: string };
  try {
    r = await remote.call(tool, args);
  } catch (e) {
    // WorkerHub.call 은 reject 하지 않도록 설계돼 있지만, 그 보장이 깨지는 경우까지 대비한다 —
    // "절대 던지지 않는다"는 이 함수 자신의 계약이므로 방어를 이중으로 둔다.
    return deny(`원격 작업 처리 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 여기가 유일하게 ok:true 가 나올 수 있는 지점이다 — 그마저도 워커가 준 값을 그대로 옮길 뿐,
  // 이 함수가 성패를 새로 판단하지는 않는다(내용이 비었다고 실패로 바꾸지도, 그 반대도 하지 않는다).
  return {
    content: r.content.length > 0 ? r.content : (r.ok ? "(완료)" : "(실패했지만 내용이 없어요)"),
    ok: r.ok,
  };
}
