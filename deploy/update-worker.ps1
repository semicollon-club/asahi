# 미니PC 워커 자동 갱신. asahi 계정의 작업 스케줄러 작업이 5분마다 부른다.
#
# Stop/Start-ScheduledTask 를 부르지 않는다 — asahi 는 표준 계정이라 그 권한이 없다. 대신
# 센티넬 파일을 만들면 워커가 진행 중인 호출을 마치고 0 이 아닌 코드로 스스로 종료하고,
# 작업 스케줄러의 "실패 시 다시 시작" 정책이 다시 띄운다.
#
# 실패는 반드시 로그(기본 <리포>\update-worker.log)에 남기고 0 이 아닌 코드로 끝난다 —
# 작업 스케줄러 기록 탭의 결과 코드가 그대로 성공/실패 신호가 된다. 새 커밋이 없어 아무 일도
# 안 한 회차는 로그를 남기지 않는다 — 5분마다 한 줄씩 쌓이면 정작 중요한 줄이 묻힌다.
#
# 이 파일은 반드시 UTF-8 "BOM 있음"으로 저장한다 — docs/agent-onboarding.md "배치 파일
# 인코딩" 절 참고. BOM 이 없으면 PowerShell 이 이 안의 한글 문자열을 시스템 코드페이지
# (cp949)로 잘못 디코딩해 로그와 콘솔 출력이 깨진다("새 커밋 발견..." 이 "??而ㅻ컠 諛쒓껄..."
# 처럼 나온다). 저장한 뒤에는 파일 첫 3바이트가 EF BB BF 인지 확인할 것.
param(
  [string]$RepoPath = "C:\asahi-worker",
  # 워커가 따라갈 브랜치. 봇(Railway `asahi` 서비스)이 production 에서 배포되므로 워커도 같은
  # 브랜치를 따른다(2026-09-05). 그전에는 main 을 따랐는데, main 은 부원이 PR 로 자유롭게 쌓는
  # 통합 브랜치라 검증 전 코드가 공유 미니PC 에 먼저 깔렸고, 봇과 워커가 서로 다른 커밋으로 도는
  # 창이 구조적으로 열려 있었다 — "두 커밋이 다르다"가 곧 "다른 코드다"여야 침묵 어긋남이 없다.
  # 클론이 아직 다른 브랜치(옛 설정의 main)에 있으면 아래 본문이 스스로 전환한다 — 사람이 미니PC
  # 에서 체크아웃할 필요가 없다.
  [string]$Branch = "production",
  # 센티넬과 로그를 리포 안에 두는 이유: 윈도우 기본 ACL 에서 표준 계정은 C:\ 루트에 폴더는
  # 만들 수 있어도 "파일"은 만들 수 없다. 2026-08-01 첫 실전 갱신이 정확히 이걸로 막혔다 —
  # 센티넬 생성이 ACCESS DENIED 로 죽었고, 로그조차 같은 이유로 못 남아 작업 스케줄러 결과
  # 코드 말고는 흔적이 없었다. 리포는 이 스크립트를 돌리는 계정(asahi)의 소유라 항상 쓸 수
  # 있고, 두 파일 다 .gitignore 대상이라 git 작업과 충돌하지 않는다.
  [string]$Sentinel = "$RepoPath\update.flag",
  [int]$WaitSeconds = 300,
  [string]$LogPath = "$RepoPath\update-worker.log",
  [int]$MaxLogBytes = 1MB,
  # 워커를 띄우는 작업 이름. 이 스크립트가 갱신 후·워커 부재 시 직접 Start-ScheduledTask 로
  # 부른다 — 2026-08-01 실측으로 그것이 표준 계정 권한으로 된다는 것을 확인했다.
  [string]$WorkerTask = "asahi-worker"
)

$ErrorActionPreference = "Stop"

function Write-Log([string]$Message) {
  # 로그 기록 자체가 실패해도(디스크 꽉 참, 권한 문제 등) 갱신 로직 — 센티넬 정리와 올바른
  # 종료 코드 — 은 반드시 계속돼야 한다. 그래서 이 함수 안의 실패는 밖으로 던지지 않는다.
  try {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt $MaxLogBytes) {
      # 상한을 넘으면 한 번만 갈아치운다 — 여러 세대를 보관할 만큼 중요한 로그는 아니다.
      Move-Item -Path $LogPath -Destination "$LogPath.old" -Force
    }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch {
    # 로그 파일조차 못 쓰는 상황(2026-08-01 의 C:\ 루트 권한이 그랬다)에서도 손으로 실행할
    # 때는 원인이 보이게 stdout 에라도 남긴다. 예약 실행에서는 버려지지만 없는 것보다 낫다.
    try { Write-Output $Message } catch {}
  }
}

function Write-LogOnce([string]$Message) {
  # 같은 문장이 로그의 마지막 몇 줄 안에 이미 있으면 다시 쓰지 않는다 — "전환 대기"처럼 회차마다
  # 반복될 수 있는 상태는 한 번만 남겨야 정작 중요한 줄이 묻히지 않는다(파일 머리말의 원칙).
  # 마지막 한 줄만 보지 않는 이유: 워커가 죽어 있는 동안은 회차마다 "워커를 띄웁니다" 가 끼어들어
  # 마지막 줄이 매번 바뀐다(2026-09-05 운영자 PC 하네스에서 실측 — 대기 줄이 회차마다 쌓였다).
  # 다른 상태가 지나가고 한참 뒤 다시 이 상태가 되면 다시 한 번 남긴다. 타임스탬프는 Write-Log 의
  # 형식대로 앞 20자다.
  try {
    if (Test-Path $LogPath) {
      foreach ($line in @(Get-Content -Path $LogPath -Tail 5 -Encoding UTF8)) {
        if ($line -and $line.Length -gt 20 -and $line.Substring(20) -eq $Message) { return }
      }
    }
  } catch {}
  Write-Log $Message
}

function Get-WorkerProcess {
  # 이 매칭은 미니PC 실측으로 확인됐다 — 워커의 커맨드라인에 리포 경로가 들어간다
  # (npm run worker -> tsx -> node ... src/worker.ts). pm2 데몬은 %APPDATA% 밑이라 안 걸린다.
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$RepoPath*" })
}

function Start-Worker([string]$Why) {
  # asahi(표준 계정)로 이 명령이 되는 것은 2026-08-01 실측으로 확인했다. 같은 날 확인된 반대편:
  # Set-ScheduledTask(작업 "수정")는 관리자여도 저장된 자격증명 재입력을 요구해 스크립트로는
  # 못 한다. 그래서 작업 정의를 건드리는 대신 이 스크립트가 감시자 노릇을 한다.
  Write-Log "워커를 띄웁니다 ($Why)."
  Start-ScheduledTask -TaskName $WorkerTask
  if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { Write-Log "실패: Start-ScheduledTask 종료 코드 $LASTEXITCODE" }
}

function Exit-Failure([string]$Message) {
  Write-Log "실패: $Message"
  # 워커는 돌아와야 한다 — 낡은 코드로라도 도는 편이 안 도는 것보다 낫다. 센티넬을 지우지
  # 않으면 재시작된 워커가 기동 직후 같은 센티넬을 다시 보고 스스로 또 종료해 무한 재시작에
  # 빠진다(agent/src/worker.ts 의 센티넬 감시는 파일 존재만 본다).
  Remove-Item -Path $Sentinel -Force -ErrorAction SilentlyContinue
  exit 1
}

try {
  Set-Location $RepoPath

  # 감시자 역할(2026-08-01 추가). 갱신보다 먼저 본다 — 새 커밋이 없는 회차에서도 워커가 죽어
  # 있으면 살려야 하는데, 아래 "$local -eq $remote 면 exit 0" 이 그 전에 끝나기 때문이다.
  #
  # 이 역할이 생긴 이유: 원래 설계는 "워커가 0 이 아닌 코드로 나가면 작업 스케줄러의 '실패 시
  # 다시 시작' 정책이 띄운다"였는데 그 전제가 틀렸다. 그 정책은 작업이 "시작에" 실패했을 때를
  # 위한 것이고, 프로그램이 실행돼서 어떤 코드로든 끝나면 스케줄러는 완료로 본다. 2026-08-01
  # 실측: 워커가 코드 10 으로 나간 뒤 재시작 정책(1분·999회)이 켜져 있었는데도 13시간 반 동안
  # 한 번도 안 띄웠다(LastTaskResult 10, NextRunTime 비어 있음). 그 13시간을 아무도 몰랐다.
  #
  # 이제는 이 5분 회차가 갱신·크래시·부팅 실패를 가리지 않고 전부 덮는다.
  if ((Get-WorkerProcess).Count -eq 0) { Start-Worker "감시 — 워커 프로세스가 없음" }

  git fetch origin $Branch | Out-Null
  if ($LASTEXITCODE -ne 0) { Exit-Failure "git fetch origin $Branch 실패 (종료 코드 $LASTEXITCODE)" }

  # git rev-parse 는 없는 ref 를 줘도 던지지 않는다 — 인자 문자열을 그대로 stdout 에 찍고
  # 종료 코드 128 로 끝낼 뿐이다. 확인하지 않으면 $local/$remote 가 "HEAD"·"origin/production"
  # 같은 문자열 그대로 남고, 그 뒤 비교·조상 검사가 엉뚱하게 실패해 로그가 원인을 오진하게 된다.
  $local = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { Exit-Failure "git rev-parse HEAD 실패 (종료 코드 $LASTEXITCODE, 출력: $local)" }
  $remote = (git rev-parse "origin/$Branch").Trim()
  if ($LASTEXITCODE -ne 0) { Exit-Failure "git rev-parse origin/$Branch 실패 (종료 코드 $LASTEXITCODE, 출력: $remote)" }

  # HEAD 가 detached 면 어느 브랜치를 따라가는지 알 수 없다 — pull 도, 아래 전환 판정도 성립하지
  # 않는다. -q 는 detached 에서 아무것도 찍지 않으므로 종료 코드와 빈 출력을 함께 걸러낸다(빈
  # 값에 .Trim() 을 부르면 이 검사 대신 "예외 발생" 이라는 엉뚱한 로그가 남는다).
  $currentRaw = git symbolic-ref -q --short HEAD
  if ($LASTEXITCODE -ne 0 -or -not $currentRaw) {
    Write-Log "실패: HEAD 가 detached 상태라 따라갈 브랜치가 없다. 사람이 리포 상태를 봐야 한다. 워커는 건드리지 않았다."
    exit 1
  }
  $current = "$currentRaw".Trim()

  # 클론이 다른 브랜치(옛 설정의 main)에 있으면 $Branch 로 옮겨 탄다. 전환은 아래 "새 커밋"과 같은
  # 절차(센티넬 → 워커 종료 대기 → 적용 → 재기동)로 하되, checkout 이 pull 의 자리를 대신한다.
  $switching = ($current -ne $Branch)
  if (-not $switching -and $local -eq $remote) { exit 0 }

  $shortLocal = $local.Substring(0, 7)
  $shortRemote = $remote.Substring(0, 7)

  # 로컬 HEAD 가 origin/$Branch 의 조상이어야 한다 — 갱신이면 --ff-only 가 성공하는 조건이고,
  # 전환이면 "지금 도는 코드를 $Branch 가 이미 담고 있다"는 뜻이다. 이걸 워커를 건드리기(센티넬
  # 생성) 전에 확인하지 않으면, 분기된 리포에서 워커만 반복해서 내렸다 올리게 된다 — 5분마다,
  # 영원히, 매번 "갱신 완료"라는 거짓 로그와 함께. 사람이 풀어야 하는 상태이므로 여기서는
  # 워커를 아직 건드리지 않는다.
  #
  # 전환 중에 조상이 아닌 것은 실패가 아니라 대기다. 이 스크립트 자신은 main 으로 먼저 도착하고
  # (옛 스크립트가 main 을 당겨 온다) production 병합은 그 뒤에 오므로, 첫 회차에는
  # origin/production 이 아직 지금 HEAD 를 담지 않은 것이 정상이다. 여기서 성급히 checkout 하면
  # 스크립트가 옛 판(main 추적)으로 되돌아가고, 그 옛 판은 production 커밋을 main 으로
  # fast-forward 하지 못해 영원히 멈춘다 — 그래서 production 이 따라올 때까지 아무것도 건드리지
  # 않고 기다린다. 운영자가 병합하면 다음 회차에 저절로 넘어간다.
  git merge-base --is-ancestor HEAD "origin/$Branch"
  if ($LASTEXITCODE -ne 0) {
    if ($switching) {
      Write-LogOnce "브랜치 전환 대기: 지금은 $current($shortLocal) 인데 origin/$Branch($shortRemote) 가 아직 이 커밋을 담지 않았다. 운영자가 $Branch 에 병합하면 다음 회차에 자동으로 전환한다. 워커는 건드리지 않았다."
      exit 0
    }
    Write-Log "실패: HEAD($shortLocal) 가 origin/$Branch($shortRemote) 의 조상이 아니라 fast-forward 불가. 로컬 커밋이나 리베이스로 분기했을 수 있다 — 사람이 리포 상태를 봐야 한다. 워커는 건드리지 않았다."
    exit 1
  }

  # 조상 검사는 커밋 그래프만 본다 — 실제 pull·checkout 이 성공하려면 조건이 하나 더 필요한데,
  # 그래프와 무관해서 위 검사를 통과한 뒤에도 따로 깨질 수 있다. 여기서 걸러내지 않으면 센티넬을
  # 만들고 워커를 내린 "다음"에야 실패해, 이 스크립트가 막으려는 바로 그 증상(5분마다 워커를
  # 헛되이 내렸다 올리는 무한 루프)을 그대로 재현한다: 추적 파일에 커밋 안 된 변경이 있으면, 그
  # 변경이 들어오는 커밋의 변경분과 겹칠 때 커밋 그래프는 맞아도 작업 트리에 적용하는 단계가
  # "로컬 변경을 덮어쓰게 된다"며 거부한다.
  git diff --quiet HEAD
  if ($LASTEXITCODE -ne 0) {
    Write-Log "실패: 추적 파일에 커밋 안 된 변경이 있어 pull·checkout 이 덮어쓸 수 있다. 사람이 리포 상태를 봐야 한다. 워커는 건드리지 않았다."
    exit 1
  }

  if ($switching) { Write-Log "추적 브랜치 전환: $current($shortLocal) -> $Branch($shortRemote)" }
  else { Write-Log "새 커밋 발견: $shortLocal -> $shortRemote" }

  # 워커에게 "끝나면 나가라"고 알린다. 언제 나갈지는 워커가 정한다.
  New-Item -ItemType File -Path $Sentinel -Force | Out-Null

  # 워커가 사라지기를 기다린다. 강제 종료하지 않는다 — 안 죽는 워커는 그 자체로 조사할 일이고,
  # 자동화가 그것을 덮으면 안 된다. 못 기다리면 이번 회차를 포기하고 다음 5분에 다시 시도한다.
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Get-WorkerProcess).Count -eq 0) { break }
    Start-Sleep -Seconds 5
  }

  # 이 매칭은 검증되지 않았다 — 같은 PC 의 다른 node.exe(예: 이 폴더를 연 VS Code 의 tsserver)를
  # 워커로 오인하거나, 반대로 진짜 워커를 놓쳐 아래 npm ci 가 그 워커가 잡고 있는 esbuild.exe 와
  # 경합할 수 있다(EPERM — docs/agent-onboarding.md "갱신 순서" 절이 이미 기록한 함정). 미니PC
  # 없이는 이 매칭 로직 자체를 고칠 수 없으니, 첫 실배포에서 사람이 판단할 수 있게 매칭된
  # 프로세스 수와 커맨드라인을 그대로 로그에 남긴다.
  $still = Get-WorkerProcess
  if ($still.Count -gt 0) {
    Write-Log "워커가 시간 안에 종료되지 않아 이번 회차를 건너뜁니다. node.exe/$RepoPath 매칭 $($still.Count)건:"
    foreach ($p in $still) { Write-Log "  PID $($p.ProcessId): $($p.CommandLine)" }
    Remove-Item -Path $Sentinel -Force -ErrorAction SilentlyContinue
    exit 0
  }
  Write-Log "워커 프로세스 종료 확인(node.exe/$RepoPath 매칭 0건)."

  $lockBefore = (Get-FileHash "$RepoPath\agent\package-lock.json").Hash
  if ($switching) {
    # -B: 로컬에 같은 이름의 브랜치가 있든 없든 origin/$Branch 를 가리키게 만들고, 시작점이 원격
    # 추적 브랜치라 upstream 도 거기로 잡힌다 — 다음 회차부터의 git pull --ff-only 가 그 upstream 을
    # 따라간다. 옛 브랜치(main)는 지우지 않고 그대로 둔다 — 지울 이유가 없고, 지우다 실패하면 그
    # 실패가 전환 자체를 가린다.
    git checkout -B $Branch "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { Exit-Failure "git checkout -B $Branch origin/$Branch 실패 (종료 코드 $LASTEXITCODE)" }
  } else {
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { Exit-Failure "git pull --ff-only 실패 (종료 코드 $LASTEXITCODE)" }
  }
  $lockAfter = (Get-FileHash "$RepoPath\agent\package-lock.json").Hash

  # npm ci 는 잠금 파일이 바뀐 커밋에만 돌린다. 대부분의 커밋은 의존성을 건드리지 않는데,
  # 19초 걸리는 그 명령이 바로 esbuild.exe 잠금 때문에 워커 정지를 강제하는 원인이다.
  if ($lockBefore -ne $lockAfter) {
    Write-Log "package-lock.json 이 바뀌어 npm ci 를 실행합니다."
    Set-Location "$RepoPath\agent"
    npm ci
    $npmExitCode = $LASTEXITCODE
    Set-Location $RepoPath
    if ($npmExitCode -ne 0) { Exit-Failure "npm ci 실패 (종료 코드 $npmExitCode)" }
  }

  # 센티넬을 먼저 지운다 — 남아 있으면 방금 띄운 워커가 15초 뒤 그것을 보고 또 스스로 나간다.
  Remove-Item -Path $Sentinel -Force -ErrorAction SilentlyContinue
  Start-Worker "갱신 완료 후"
  if ($switching) { Write-Log "브랜치 전환 완료: 이제 $Branch($shortRemote) 를 따른다." }
  else { Write-Log "갱신 완료: $shortLocal -> $shortRemote." }
  exit 0
} catch {
  Exit-Failure "예외 발생: $($_.Exception.Message)"
}
