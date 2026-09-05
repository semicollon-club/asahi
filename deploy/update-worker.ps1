# 미니PC 워커 자동 갱신 — asahi 계정의 작업 스케줄러 작업(asahi-worker-update)이 5분마다 부른다.
#
# 2026-09-05(풀 하네스 1단계)부터 본문은 봇·워커 공용인 deploy/update-service.ps1 에 있다. 이 파일은 워커 기본값
# (클론 C:\asahi-worker, 작업 asahi-worker, 로그 update-worker.log)으로 그 스크립트를 부르는 얇은 래퍼다 — 미니PC 에
# 이미 등록된 asahi-worker-update 작업은 이 경로를 인자 없이 가리키므로, 작업 정의를 손대지 않고도 갱신된 본문을
# 그대로 탄다(등록 절차: deploy/worker-셋업.md "자동 갱신" 절). 매개변수 이름은 예전 그대로다.
#
# 이 파일도 UTF-8 "BOM 있음"으로 저장한다(update-service.ps1 머리말·docs/agent-onboarding.md "배치 파일 인코딩").
param(
  [string]$RepoPath = "C:\asahi-worker",
  [string]$Branch = "production",
  [string]$Sentinel = "$RepoPath\update.flag",
  [int]$WaitSeconds = 300,
  [string]$LogPath = "$RepoPath\update-worker.log",
  [int]$MaxLogBytes = 1MB,
  [string]$WorkerTask = "asahi-worker",
  # (선택) 하네스용 — update-service.ps1 의 같은 이름 인자로 그대로 넘긴다.
  [string]$StartCommand = ""
)

& "$PSScriptRoot\update-service.ps1" -RepoPath $RepoPath -Branch $Branch -Sentinel $Sentinel -WaitSeconds $WaitSeconds `
  -LogPath $LogPath -MaxLogBytes $MaxLogBytes -ServiceTask $WorkerTask -ServiceName "워커" -StartCommand $StartCommand
exit $LASTEXITCODE
