# 미니PC 서비스 자동 갱신 — 봇(계정 asahi-bot)과 워커(계정 asahi)가 같은 스크립트를 각자의 작업 스케줄러
# 작업으로 5분마다 부른다(풀 하네스 1단계, 2026-09-05). 그전까지 워커 전용이던 deploy/update-worker.ps1 의
# 본문을 그대로 옮기고 "어느 클론·어느 작업·무슨 이름"만 인자로 뺐다 — update-worker.ps1 은 이제 워커 기본값으로
# 이 파일을 부르는 얇은 래퍼라, 미니PC 에 등록된 asahi-worker-update 작업 정의는 손대지 않아도 된다.
#
# Stop-ScheduledTask 를 부르지 않는다 — 표준 계정은 그 권한이 없다. 대신 센티넬 파일을 만들면 서비스(봇은
# agent/src/index.ts, 워커는 agent/src/worker.ts)가 진행 중인 작업을 마치고 스스로 종료하고, 이 스크립트가 갱신한
# 뒤 Start-ScheduledTask 로 다시 띄운다(표준 계정으로 되는 것을 2026-08-01 실측). 같은 회차가 서비스 생존도 확인해
# 죽어 있으면 살린다 — 갱신자이자 감시자다.
#
# 실패는 반드시 로그(-LogPath)에 남기고 0 이 아닌 코드로 끝난다 — 작업 스케줄러 기록 탭의 결과 코드가 그대로
# 성공/실패 신호가 된다. 새 커밋이 없어 아무 일도 안 한 회차는 로그를 남기지 않는다 — 5분마다 한 줄씩 쌓이면
# 정작 중요한 줄이 묻힌다.
#
# 이 파일은 반드시 UTF-8 "BOM 있음"으로 저장한다 — docs/agent-onboarding.md "배치 파일 인코딩" 절 참고. BOM 이
# 없으면 PowerShell 5.1 이 이 안의 한글 문자열을 시스템 코드페이지(cp949)로 잘못 디코딩해 로그와 콘솔 출력이
# 깨진다. 저장한 뒤에는 파일 첫 3바이트가 EF BB BF 인지 확인할 것.
param(
  # 갱신할 클론. 봇은 C:\Users\asahi-bot\asahi-bot(계정 A 프로필 안 — .env 가 다른 표준 계정에 보이지 않게),
  # 워커는 C:\asahi-worker. 이 경로가 커맨드라인에 든 node.exe 를 "이 서비스의 프로세스"로 본다(아래 Get-ServiceProcess).
  [Parameter(Mandatory = $true)][string]$RepoPath,
  # 따라갈 브랜치. 봇·워커 모두 production(2026-09-05) — 같은 브랜치를 따라야 "두 커밋이 다르다"가 곧 "다른 코드다"다.
  # 클론이 아직 다른 브랜치(옛 설정의 main)에 있으면 아래 본문이 스스로 전환한다.
  [string]$Branch = "production",
  # 센티넬과 로그를 리포 안에 두는 이유: 윈도우 기본 ACL 에서 표준 계정은 C:\ 루트에 폴더는 만들 수 있어도 "파일"은
  # 만들 수 없다(2026-08-01 첫 실전 갱신이 정확히 이걸로 막혔다). 리포는 이 스크립트를 돌리는 계정의 소유라 항상
  # 쓸 수 있고, 두 파일 다 .gitignore 대상이라 git 작업과 충돌하지 않는다. 서비스의 .env 에 적은 센티넬 경로
  # (BOT_SENTINEL / WORKER_SENTINEL)와 정확히 같아야 한다.
  [string]$Sentinel = "$RepoPath\update.flag",
  [int]$WaitSeconds = 300,
  [string]$LogPath = "$RepoPath\update-service.log",
  [int]$MaxLogBytes = 1MB,
  # 서비스를 띄우는 작업 스케줄러 작업 이름(asahi-bot / asahi-worker). 갱신 후·부재 시 Start-ScheduledTask 로 부른다.
  [string]$ServiceTask = "",
  # 로그 문장에 쓰는 이름(봇 / 워커). 동작에는 영향이 없다.
  [string]$ServiceName = "서비스",
  # (선택) 작업 스케줄러 대신 이 명령으로 서비스를 띄운다 — 하네스(운영자 PC 에서 스크립트를 실제 클론으로 검증할
  # 때)나 작업 스케줄러가 아닌 배치용. 비어 있으면 Start-ScheduledTask -TaskName $ServiceTask 다.
  [string]$StartCommand = ""
)

$ErrorActionPreference = "Stop"

if (-not $StartCommand -and -not $ServiceTask) {
  Write-Output "실패: -ServiceTask(작업 이름) 또는 -StartCommand 중 하나는 있어야 합니다."
  exit 1
}

function Write-Log([string]$Message) {
  # 로그 기록 자체가 실패해도(디스크 꽉 참, 권한 문제 등) 갱신 로직 — 센티넬 정리와 올바른 종료 코드 — 은 반드시
  # 계속돼야 한다. 그래서 이 함수 안의 실패는 밖으로 던지지 않는다.
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
    # 로그 파일조차 못 쓰는 상황에서도 손으로 실행할 때는 원인이 보이게 stdout 에라도 남긴다.
    try { Write-Output $Message } catch {}
  }
}

function Write-LogOnce([string]$Message) {
  # 같은 문장이 로그의 마지막 몇 줄 안에 이미 있으면 다시 쓰지 않는다 — "전환 대기"처럼 회차마다 반복될 수 있는
  # 상태는 한 번만 남겨야 정작 중요한 줄이 묻히지 않는다. 마지막 한 줄만 보지 않는 이유: 서비스가 죽어 있는 동안은
  # 회차마다 "띄웁니다" 가 끼어들어 마지막 줄이 매번 바뀐다. 타임스탬프는 Write-Log 의 형식대로 앞 20자다.
  try {
    if (Test-Path $LogPath) {
      foreach ($line in @(Get-Content -Path $LogPath -Tail 5 -Encoding UTF8)) {
        if ($line -and $line.Length -gt 20 -and $line.Substring(20) -eq $Message) { return }
      }
    }
  } catch {}
  Write-Log $Message
}

function Get-ServiceProcess {
  # 워커에서 미니PC 실측으로 확인된 매칭 — 서비스의 커맨드라인에 클론 경로가 들어간다(npm run ... -> tsx -> node ...
  # src/index.ts 또는 src/worker.ts). 봇이 띄우는 Claude Code CLI 자식(node ... agent\node_modules\...\cli.js)도 같은
  # 경로를 담아 함께 잡히는데, 봇은 센티넬을 보면 진행 중인 턴을 끝내고서야 내려가므로 그 자식들도 함께 사라진다.
  # pm2 데몬은 %APPDATA% 밑이라 안 걸린다.
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$RepoPath*" })
}

function Start-Svc([string]$Why) {
  Write-Log "[$ServiceName] 띄웁니다 ($Why)."
  if ($StartCommand) {
    Invoke-Expression $StartCommand
    return
  }
  # 표준 계정으로 이 명령이 되는 것은 2026-08-01 실측으로 확인했다. 반대편: 작업 정의를 "수정"하는
  # Set-ScheduledTask 는 관리자여도 저장된 자격증명 재입력을 요구해 스크립트로는 못 한다 — 그래서 트리거를 손보는
  # 대신 이 스크립트가 감시자 노릇을 한다.
  Start-ScheduledTask -TaskName $ServiceTask
  if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { Write-Log "실패: Start-ScheduledTask 종료 코드 $LASTEXITCODE" }
}

function Exit-Failure([string]$Message) {
  Write-Log "실패: $Message"
  # 서비스는 돌아와야 한다 — 낡은 코드로라도 도는 편이 안 도는 것보다 낫다. 센티넬을 지우지 않으면 재시작된
  # 서비스가 기동 직후 같은 센티넬을 다시 보고 스스로 또 종료해 무한 재시작에 빠진다(센티넬 감시는 파일 존재만 본다).
  Remove-Item -Path $Sentinel -Force -ErrorAction SilentlyContinue
  exit 1
}

try {
  Set-Location $RepoPath

  # 감시자 역할. 갱신보다 먼저 본다 — 새 커밋이 없는 회차에서도 서비스가 죽어 있으면 살려야 하는데, 아래
  # "$local -eq $remote 면 exit 0" 이 그 전에 끝나기 때문이다. 작업 스케줄러의 "실패 시 다시 시작" 정책은 이 용도로
  # 쓸 수 없다 — 그 정책은 작업이 "시작에" 실패했을 때를 위한 것이고, 프로그램이 실행돼서 어떤 코드로든 끝나면
  # 스케줄러는 완료로 본다(2026-08-01 실측: 워커가 코드 10 으로 나간 뒤 13시간 반 동안 한 번도 안 띄웠다).
  if ((Get-ServiceProcess).Count -eq 0) { Start-Svc "감시 — 프로세스가 없음" }

  # 목적지 refspec 을 명시한다 — `git fetch origin production` 만으로는 클론의 remote.origin.fetch 가 그 브랜치를
  # 덮을 때만 origin/production 이 갱신된다. --single-branch 클론이나 옛 클론에서는 FETCH_HEAD 만 바뀌고
  # origin/production 은 생기지 않아 아래 rev-parse 가 실패한다.
  git fetch origin "+refs/heads/${Branch}:refs/remotes/origin/${Branch}" | Out-Null
  if ($LASTEXITCODE -ne 0) { Exit-Failure "git fetch origin $Branch 실패 (종료 코드 $LASTEXITCODE)" }

  # git rev-parse 는 없는 ref 를 줘도 던지지 않는다 — 인자 문자열을 그대로 stdout 에 찍고 종료 코드 128 로 끝낼
  # 뿐이다. 확인하지 않으면 $local/$remote 가 "HEAD"·"origin/production" 같은 문자열 그대로 남는다.
  $local = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { Exit-Failure "git rev-parse HEAD 실패 (종료 코드 $LASTEXITCODE, 출력: $local)" }
  $remote = (git rev-parse "origin/$Branch").Trim()
  if ($LASTEXITCODE -ne 0) { Exit-Failure "git rev-parse origin/$Branch 실패 (종료 코드 $LASTEXITCODE, 출력: $remote)" }

  # HEAD 가 detached 면 어느 브랜치를 따라가는지 알 수 없다 — pull 도, 아래 전환 판정도 성립하지 않는다.
  $currentRaw = git symbolic-ref -q --short HEAD
  if ($LASTEXITCODE -ne 0 -or -not $currentRaw) {
    Write-Log "실패: HEAD 가 detached 상태라 따라갈 브랜치가 없다. 사람이 리포 상태를 봐야 한다. [$ServiceName] 는 건드리지 않았다."
    exit 1
  }
  $current = "$currentRaw".Trim()

  # 클론이 다른 브랜치(옛 설정의 main)에 있으면 $Branch 로 옮겨 탄다. 전환은 아래 "새 커밋"과 같은 절차(센티넬 →
  # 종료 대기 → 적용 → 재기동)로 하되, checkout 이 pull 의 자리를 대신한다.
  $switching = ($current -ne $Branch)
  if (-not $switching -and $local -eq $remote) { exit 0 }

  $shortLocal = $local.Substring(0, 7)
  $shortRemote = $remote.Substring(0, 7)

  # 로컬 HEAD 가 origin/$Branch 의 조상이어야 한다 — 갱신이면 --ff-only 가 성공하는 조건이고, 전환이면 "지금 도는
  # 코드를 $Branch 가 이미 담고 있다"는 뜻이다. 이걸 서비스를 건드리기(센티넬 생성) 전에 확인하지 않으면, 분기된
  # 리포에서 서비스만 반복해서 내렸다 올리게 된다 — 5분마다, 영원히. 사람이 풀어야 하는 상태이므로 여기서는
  # 서비스를 아직 건드리지 않는다. 전환 중에 조상이 아닌 것은 실패가 아니라 대기다 — 운영자가 $Branch 에 병합해
  # 그 커밋이 지금 HEAD 를 담는 순간 다음 회차에 저절로 넘어간다.
  git merge-base --is-ancestor HEAD "origin/$Branch"
  if ($LASTEXITCODE -ne 0) {
    if ($switching) {
      Write-LogOnce "브랜치 전환 대기: 지금은 $current($shortLocal) 인데 origin/$Branch($shortRemote) 가 아직 이 커밋을 담지 않았다. 운영자가 $Branch 에 병합하면 다음 회차에 자동으로 전환한다. [$ServiceName] 는 건드리지 않았다."
      exit 0
    }
    Write-Log "실패: HEAD($shortLocal) 가 origin/$Branch($shortRemote) 의 조상이 아니라 fast-forward 불가. 로컬 커밋이나 리베이스로 분기했을 수 있다 — 사람이 리포 상태를 봐야 한다. [$ServiceName] 는 건드리지 않았다."
    exit 1
  }

  # 조상 검사는 커밋 그래프만 본다 — 추적 파일에 커밋 안 된 변경이 있으면 그래프는 맞아도 작업 트리 적용 단계가
  # "로컬 변경을 덮어쓰게 된다"며 거부한다. 여기서 걸러내지 않으면 센티넬을 만들고 서비스를 내린 "다음"에야 실패해,
  # 5분마다 서비스를 헛되이 내렸다 올리는 무한 루프를 그대로 재현한다.
  git diff --quiet HEAD
  if ($LASTEXITCODE -ne 0) {
    Write-Log "실패: 추적 파일에 커밋 안 된 변경이 있어 pull·checkout 이 덮어쓸 수 있다. 사람이 리포 상태를 봐야 한다. [$ServiceName] 는 건드리지 않았다."
    exit 1
  }

  if ($switching) { Write-Log "추적 브랜치 전환: $current($shortLocal) -> $Branch($shortRemote)" }
  else { Write-Log "새 커밋 발견: $shortLocal -> $shortRemote" }

  # 서비스에게 "끝나면 나가라"고 알린다. 언제 나갈지는 서비스가 정한다(봇은 진행 중인 턴을, 워커는 진행 중인 호출을 마친다).
  New-Item -ItemType File -Path $Sentinel -Force | Out-Null

  # 서비스가 사라지기를 기다린다. 강제 종료하지 않는다 — 안 죽는 프로세스는 그 자체로 조사할 일이고, 자동화가 그것을
  # 덮으면 안 된다. 못 기다리면 이번 회차를 포기하고 다음 5분에 다시 시도한다.
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Get-ServiceProcess).Count -eq 0) { break }
    Start-Sleep -Seconds 5
  }

  # 같은 PC 의 다른 node.exe(예: 이 폴더를 연 VS Code 의 tsserver)를 서비스로 오인할 수 있다 — 사람이 판단할 수 있게
  # 매칭된 프로세스 수와 커맨드라인을 그대로 로그에 남긴다.
  $still = Get-ServiceProcess
  if ($still.Count -gt 0) {
    Write-Log "[$ServiceName] 가 시간 안에 종료되지 않아 이번 회차를 건너뜁니다. node.exe/$RepoPath 매칭 $($still.Count)건:"
    foreach ($p in $still) { Write-Log "  PID $($p.ProcessId): $($p.CommandLine)" }
    Remove-Item -Path $Sentinel -Force -ErrorAction SilentlyContinue
    exit 0
  }
  Write-Log "[$ServiceName] 프로세스 종료 확인(node.exe/$RepoPath 매칭 0건)."

  $lockBefore = (Get-FileHash "$RepoPath\agent\package-lock.json").Hash
  if ($switching) {
    # -B: 로컬에 같은 이름의 브랜치가 있든 없든 origin/$Branch 를 가리키게 만들고, upstream 도 거기로 잡힌다.
    git checkout -B $Branch "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { Exit-Failure "git checkout -B $Branch origin/$Branch 실패 (종료 코드 $LASTEXITCODE)" }
    # 단일 브랜치 클론이면 remote.origin.fetch 가 main 만 덮어 사람이 손으로 git pull 해도 $Branch 가 따라오지
    # 않는다 — 클론을 사람이 다룰 수 있는 정상 모양으로 남긴다. 둘 다 실패해도 전환 자체는 이미 끝났으므로 결과를
    # 확인하지 않는다.
    $spec = "+refs/heads/${Branch}:refs/remotes/origin/${Branch}"
    $have = @(git config --get-all remote.origin.fetch)
    if (($have -notcontains $spec) -and ($have -notcontains "+refs/heads/*:refs/remotes/origin/*")) {
      git config --add remote.origin.fetch $spec
    }
    git branch --set-upstream-to="origin/$Branch" $Branch | Out-Null
  } else {
    # git pull 이 아니라 방금 명시적으로 가져온 origin/$Branch 로 merge --ff-only 한다 — pull 은 클론의
    # refspec·upstream·pull.rebase 설정에 따라 결과가 달라지는데, 이 스크립트는 그 설정을 통제하지 않는다.
    git merge --ff-only "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { Exit-Failure "git merge --ff-only origin/$Branch 실패 (종료 코드 $LASTEXITCODE)" }
  }
  $lockAfter = (Get-FileHash "$RepoPath\agent\package-lock.json").Hash

  # npm ci 는 잠금 파일이 바뀐 커밋에만 돌린다. 대부분의 커밋은 의존성을 건드리지 않는데, 19초 걸리는 그 명령이
  # 바로 esbuild.exe 잠금 때문에 서비스 정지를 강제하는 원인이다.
  if ($lockBefore -ne $lockAfter) {
    Write-Log "package-lock.json 이 바뀌어 npm ci 를 실행합니다."
    Set-Location "$RepoPath\agent"
    npm ci
    $npmExitCode = $LASTEXITCODE
    Set-Location $RepoPath
    if ($npmExitCode -ne 0) { Exit-Failure "npm ci 실패 (종료 코드 $npmExitCode)" }
  }

  # 센티넬을 먼저 지운다 — 남아 있으면 방금 띄운 서비스가 15초 뒤 그것을 보고 또 스스로 나간다.
  Remove-Item -Path $Sentinel -Force -ErrorAction SilentlyContinue
  Start-Svc "갱신 완료 후"
  if ($switching) { Write-Log "브랜치 전환 완료: 이제 $Branch($shortRemote) 를 따른다." }
  else { Write-Log "갱신 완료: $shortLocal -> $shortRemote." }
  exit 0
} catch {
  Exit-Failure "예외 발생: $($_.Exception.Message)"
}
