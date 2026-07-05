param(
  [int]$Seconds = 120,
  [double]$IntervalSeconds = 1.0,
  [string]$OutDir = "research/stats"
)

$ErrorActionPreference = "Stop"
$nvidiaSmi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
if (-not $nvidiaSmi) { throw "nvidia-smi was not found on PATH." }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ss-fffZ")
$out = Join-Path $OutDir "gpu-telemetry-$stamp.csv"
$fields = @(
  "timestamp",
  "index",
  "name",
  "temperature.gpu",
  "utilization.gpu",
  "utilization.memory",
  "clocks.gr",
  "clocks.mem",
  "power.draw",
  "power.limit",
  "pstate",
  "memory.used",
  "memory.total",
  "fan.speed"
)

$header = "wallTimeUtc," + ($fields -join ",")
Set-Content -LiteralPath $out -Value $header
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
while ([DateTimeOffset]::UtcNow -lt $deadline) {
  $wall = [DateTimeOffset]::UtcNow.ToString("o")
  $line = & $nvidiaSmi --query-gpu=timestamp,index,name,temperature.gpu,utilization.gpu,utilization.memory,clocks.gr,clocks.mem,power.draw,power.limit,pstate,memory.used,memory.total,fan.speed --format=csv,noheader,nounits
  foreach ($row in $line) { Add-Content -LiteralPath $out -Value ($wall + "," + $row) }
  Start-Sleep -Milliseconds ([Math]::Max(100, [int]($IntervalSeconds * 1000)))
}
Write-Host $out