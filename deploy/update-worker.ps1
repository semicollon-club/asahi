# 미니PC 워커 자동 갱신. asahi 계정의 작업 스케줄러 작업이 5분마다 부른다.
#
# Stop/Start-ScheduledTask 를 부르지 않는다 — asahi 는 표준 계정이라 그 권한이 없다. 대신
# 센티넬 파일을 만들면 워커가 진행 중인 호출을 마치고 0 이 아닌 코드로 스스로 종료하고,
# 작업 스케줄러의 "실패 시 다시 시작" 정책이 다시 띄운다.
param(
  [string]$RepoPath = "C:\asahi-worker",
  [string]$Sentinel = "C:\asahi-worker-update.flag",
  [int]$WaitSeconds = 300
)

Set-Location $RepoPath

git fetch origin main 2>&1 | Out-Null
$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse origin/main).Trim()
if ($local -eq $remote) { exit 0 }

Write-Output "새 커밋 발견: $($local.Substring(0,7)) -> $($remote.Substring(0,7))"

# 워커에게 "끝나면 나가라"고 알린다. 언제 나갈지는 워커가 정한다.
New-Item -ItemType File -Path $Sentinel -Force | Out-Null

# 워커가 사라지기를 기다린다. 강제 종료하지 않는다 — 안 죽는 워커는 그 자체로 조사할 일이고,
# 자동화가 그것을 덮으면 안 된다. 못 기다리면 이번 회차를 포기하고 다음 5분에 다시 시도한다.
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$RepoPath*" }
  if (-not $running) { break }
  Start-Sleep -Seconds 5
}

$still = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$RepoPath*" }
if ($still) {
  Remove-Item $Sentinel -Force -ErrorAction SilentlyContinue
  Write-Output "워커가 시간 안에 종료되지 않아 이번 회차를 건너뜁니다."
  exit 0
}

$lockBefore = (Get-FileHash "$RepoPath\agent\package-lock.json").Hash
git pull --ff-only
$lockAfter = (Get-FileHash "$RepoPath\agent\package-lock.json").Hash

# npm ci 는 잠금 파일이 바뀐 커밋에만 돌린다. 대부분의 커밋은 의존성을 건드리지 않는데,
# 19초 걸리는 그 명령이 바로 esbuild.exe 잠금 때문에 워커 정지를 강제하는 원인이다.
if ($lockBefore -ne $lockAfter) {
  Write-Output "package-lock.json 이 바뀌어 npm ci 를 실행합니다."
  Set-Location "$RepoPath\agent"
  npm ci
  Set-Location $RepoPath
}

Remove-Item $Sentinel -Force -ErrorAction SilentlyContinue
Write-Output "갱신 완료: $((git rev-parse HEAD).Substring(0,7)). 작업 스케줄러가 워커를 다시 띄웁니다."
