// 워커가 봇보다 낡았는지 판정하고, 언제 알릴지 정한다.
//
// 불일치 자체는 정상 상태이기도 하다 — 봇이 배포되고 워커가 갱신되기까지 반드시 어긋난다.
// 그래서 "다르면 즉시 알림"은 배포마다 울려 금방 무시당하고, 그러면 정작 갱신이 진짜로 막힌
// 날에도 보지 않게 된다. 자동 갱신이 5분 주기이므로 임계(기본 15분)를 넘겼다는 것은 그
// 자동화가 실제로 막혔다는 뜻이다 — 그때만 울린다.
//
// 키에 botCommit 을 넣는 이유: 봇이 다시 배포되면 botCommit 이 바뀌어 "새로운 불일치"가
// 시작된 것이므로 다시 셈을 시작해야 한다. workerId 만으로 키를 잡으면 한 번 알린 뒤로는
// 어떤 새 불일치도 알리지 못한다.
//
// 반대로 workerCommit 은 키에 넣지 않는다 — 워커가 갱신되는 동안 옛 커밋 사이를 오가더라도
// "봇과 아직 안 맞다"는 사실 자체는 하나로 이어지는 사건이다. 일치하는 순간 그 사건을 지우려면
// 불일치가 시작됐을 때 썼던 것과 같은 키를 계산할 수 있어야 하는데, workerCommit 을 넣으면
// 일치 판정 시점(현재 커밋 = botCommit)의 키가 불일치 시작 시점(그때의 옛 커밋)의 키와 달라져
// delete 가 엉뚱한 키를 지우게 된다 — 기록이 영영 안 지워지는 버그가 된다.
export type StaleState = Map<string, number>;

// 워커가 아예 사라진 것을 알리는 쪽. decideStaleAlerts 와 짝이지만 보는 것이 정반대다 —
// 저쪽은 "붙어 있는 워커의 커밋이 낡았나"를 보고, 이쪽은 "붙어 있던 워커가 없어졌나"를 본다.
//
// 이 함수가 생긴 이유(2026-08-01): 워커가 13시간 반 사라져 있었는데 아무 알림도 오지 않았다.
// decideStaleAlerts 는 workersInfo() 가 돌려주는 "붙어 있는" 워커만 훑으므로, 워커가 통째로
// 없어지면 훑을 대상 자체가 없어 조용하다. 사라진 것이야말로 가장 먼저 알아야 할 상태인데
// 유일하게 안 알리던 상태였다.
//
// 값은 "마지막으로 붙어 있는 것을 본 시각"이고, -1 은 "이미 알렸다"는 표식이다.
export type SeenState = Map<string, number>;

// 이 봇 프로세스가 사는 동안 "붙은 적 있는" 워커만 대상으로 삼는다. 등록은 돼 있지만 며칠째
// 안 붙는 워커(owner-laptop 같은)까지 알리면 매번 울려 아무도 안 보게 된다 — 그렇게 되면 정작
// 공유 워커가 죽은 날에도 그 줄이 묻힌다. 봇이 재배포되면 이 맵도 비워지는데, 그때는 아직
// 아무것도 "붙은 적 없는" 상태라 첫 연결부터 다시 세면 되므로 무해하다.
export function decideMissingAlerts(o: {
  connected: string[];
  now: number;
  seen: SeenState;
  thresholdMs: number;
}): string[] {
  const live = new Set(o.connected);
  for (const id of live) o.seen.set(id, o.now); // 복귀가 셈을 되돌린다 — 두 번째 사고를 놓치지 않으려고
  const alerts: string[] = [];
  for (const [id, since] of o.seen) {
    if (live.has(id) || since === -1) continue;
    if (o.now - since >= o.thresholdMs) {
      o.seen.set(id, -1);
      alerts.push(
        `워커 ${id} 가 ${Math.round((o.now - since) / 60_000)}분째 붙어 있지 않아요. ` +
          `미니PC 가 꺼져 있거나, 갱신 뒤 워커가 다시 뜨지 못했을 수 있어요 — ` +
          `미니PC 의 갱신 로그(C:\\asahi-worker\\update-worker.log)부터 확인해 주세요.`,
      );
    }
  }
  return alerts;
}

export function decideStaleAlerts(o: {
  workers: Array<{ workerId: string; commit?: string }>;
  botCommit?: string;
  now: number;
  state: StaleState;
  thresholdMs: number;
}): string[] {
  // 비교할 기준이 없으면 아무 판정도 하지 않는다. "모른다"를 "낡았다"로 보고하면 거짓 경보다.
  if (o.botCommit === undefined) return [];
  const alerts: string[] = [];
  for (const w of o.workers) {
    if (w.commit === undefined) continue; // 옛 워커 — 판정할 근거가 없다
    const key = `${w.workerId}:${o.botCommit}`;
    if (w.commit === o.botCommit) {
      o.state.delete(key);
      continue;
    }
    const since = o.state.get(key);
    if (since === undefined) {
      o.state.set(key, o.now);
      continue;
    }
    // -1 은 "이미 알렸다"는 표식이다. 같은 조합으로 다시 울리지 않는다.
    if (since === -1) continue;
    if (o.now - since >= o.thresholdMs) {
      o.state.set(key, -1);
      alerts.push(
        `워커 ${w.workerId} 가 ${Math.round((o.now - since) / 60_000)}분째 낡은 코드로 돌고 있어요 ` +
          `(워커 ${w.commit.slice(0, 7)} / 봇 ${o.botCommit.slice(0, 7)}). 자동 갱신이 막혔을 수 있어요 — ` +
          `미니PC 의 갱신 작업을 확인해 주세요.`,
      );
    }
  }
  return alerts;
}
