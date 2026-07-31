// 갱신으로 인한 종료는 0 이 아닌 코드로 끝낸다. 작업 스케줄러의 "실패 시 다시 시작" 정책이
// 0 이 아닌 종료에만 반응하므로, 이 값이 곧 "돌아온다"는 뜻이다 — 반대로 사람이 SIGTERM 으로
// 내린 워커는 0 으로 끝나 스케줄러가 도로 띄우지 않는다. 구체적인 숫자에는 의미가 없다.
export const EXIT_CODE_UPDATE = 10;

// 종료 순서를 정한다. 순수 함수로 뺀 이유는 실제 소켓·프로세스 없이 순서와 코드를 고정하기
// 위해서다 — 이 순서가 이 기능의 전부이기 때문이다.
//
// signal(사람이 멈춤): 소켓을 먼저 닫는다. 예전부터의 동작이고, 사람이 지켜보는 상황이라
// 진행 중 호출 하나가 결과를 못 돌려줘도 무방하다.
// update(갱신): idle 을 먼저 기다린다. 소켓을 먼저 닫으면 진행 중이던 호출의 결과 프레임이
// 허브까지 못 가고, 부원이 시킨 작업이 조용히 실패한다 — "한가할 때 갱신한다"가 거짓이 된다.
// 다만 무한정 기다리지 않는다: sh_exec 는 기본 120초까지 갈 수 있어 상한이 없으면 갱신이
// 영원히 막힌다. 상한을 넘기면 signal 과 같은 순서로 떨어진다.
export async function planShutdown(o: {
  reason: "signal" | "update";
  stopSocket: () => void;
  idle: () => Promise<void>;
  idleTimeoutMs: number;
}): Promise<number> {
  if (o.reason === "signal") {
    o.stopSocket();
    await o.idle();
    return 0;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    o.idle(),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, o.idleTimeoutMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  o.stopSocket();
  return EXIT_CODE_UPDATE;
}
