# Synx-Sync WebDAV e2e test (PowerShell, works around workers.dev DNS pollution)
#
# Usage:
#   $env:SYNX_WORKER_URL='https://synx-sync-worker.ydxu.workers.dev'
#   $env:SYNX_WEBDAV_ADDRESS='https://dav.jianguoyun.com/dav/'
#   $env:SYNX_WEBDAV_USER='<账号>'
#   $env:SYNX_WEBDAV_PASS='<应用密码>'
#   powershell -ExecutionPolicy Bypass -File scripts/e2e/webdav-e2e.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Write all output to a log file (IDE terminal cannot read console buffer)
$LogFile = 'scripts/e2e/webdav-e2e.log'
Set-Content -Path $LogFile -Value '' -Encoding utf8

$WORKER_URL = $env:SYNX_WORKER_URL
if ($WORKER_URL) { $WORKER_URL = $WORKER_URL.TrimEnd('/') }
$WD_ADDRESS = $env:SYNX_WEBDAV_ADDRESS
$WD_USER = $env:SYNX_WEBDAV_USER
$WD_PASS = $env:SYNX_WEBDAV_PASS
$runId = "$(Get-Date -Format 'yyyyMMddHHmmssfff')-$([Guid]::NewGuid().ToString('N'))"
$REMOTE_BASE_DIR = "synx-e2e-test-$runId"
$SYNC_FOLDER = "synx-e2e-$runId"

if (-not $WORKER_URL -or -not $WD_ADDRESS -or -not $WD_USER -or -not $WD_PASS) {
  Add-Content -Path $LogFile -Value 'missing env vars' -Encoding utf8
  exit 2
}

$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$username = "synx_e2e_$ts"
$email = "synx-e2e-$ts@example.com"
$password = [Guid]::NewGuid().ToString('N')
$authPair = "$WD_USER`:$WD_PASS"
$basicAuth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($authPair))
$path = 'e2e-test.md'

$script:step = 0
$script:token = ''
$storageId = ''
$v1Id = ''

function Log {
  param([string]$msg)
  $script:step++
  $line = "[{0:D2}] {1}" -f $script:step, $msg
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

function LogSub {
  param([string]$msg)
  Add-Content -Path $LogFile -Value "    $msg" -Encoding utf8
}

function Cleanup {
  if (-not $WD_ADDRESS) { return $true }
  $delUrl = "$($WD_ADDRESS.TrimEnd('/'))/$REMOTE_BASE_DIR/"
  try {
    try {
      Invoke-WebRequest -Uri $delUrl -Method DELETE -Headers @{ Authorization = $basicAuth } -UseBasicParsing -TimeoutSec 30 | Out-Null
    } catch {
      if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404) { throw }
    }
    try {
      Invoke-WebRequest -Uri $delUrl -Method PROPFIND -Headers @{ Authorization = $basicAuth; Depth = '0'; 'Content-Type' = 'application/xml' } -Body '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>' -UseBasicParsing -TimeoutSec 30 | Out-Null
      throw "cleanup verification found $REMOTE_BASE_DIR/"
    } catch {
      if ($_.Exception.Response -and @([int]$_.Exception.Response.StatusCode) -contains 404) {
        Add-Content -Path $LogFile -Value "cleanup: verified deletion of $REMOTE_BASE_DIR/" -Encoding utf8
        return $true
      }
      throw
    }
  } catch {
    Add-Content -Path $LogFile -Value "cleanup failed: $REMOTE_BASE_DIR/ may remain ($($_.Exception.Message))" -Encoding utf8
    return $false
  }
}

function Fail {
  param([string]$msg)
  Add-Content -Path $LogFile -Value "FAIL: $msg" -Encoding utf8
  [void](Cleanup)
  exit 1
}

function Invoke-Api {
  param([string]$method, [string]$route, $headers, $body, $query)
  $url = $WORKER_URL + $route
  if ($query -and $query.Count) {
    $qs = ($query.GetEnumerator() | ForEach-Object { "$($_.Key)=$([Uri]::EscapeDataString($_.Value))" }) -join '&'
    $url = $url + '?' + $qs
  }
  $allHeaders = @{ 'Content-Type' = 'application/json' }
  if ($headers) { foreach ($k in $headers.Keys) { $allHeaders[$k] = $headers[$k] } }
  $bodyJson = $null
  if ($body) { $bodyJson = $body | ConvertTo-Json -Compress -Depth 10 }
  try {
    $resp = Invoke-WebRequest -Uri $url -Method $method -Headers $allHeaders -Body $bodyJson -UseBasicParsing -TimeoutSec 60
    $json = $null
    if ($resp.Content) { $json = $resp.Content | ConvertFrom-Json }
    return @{ status = [int]$resp.StatusCode; json = $json; text = $resp.Content }
  } catch {
    $r = $_.Exception.Response
    if (-not $r) { throw }
    $sr = New-Object System.IO.StreamReader($r.GetResponseStream())
    $errText = $sr.ReadToEnd()
    $errJson = $null
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $errJson = $errText | ConvertFrom-Json
    $ErrorActionPreference = $prev
    return @{ status = [int]$r.StatusCode; json = $errJson; text = $errText }
  }
}

function AuthHeaders {
  param($extra)
  $h = @{ Authorization = "Bearer $script:token" }
  if ($extra) { foreach ($k in $extra.Keys) { $h[$k] = $extra[$k] } }
  return $h
}

try {
  # 01 register
  Log "register user $username"
  $r = Invoke-Api 'POST' '/api/auth/register' $null @{ username = $username; email = $email; password = $password } $null
  if ($r.status -ne 201) { Fail "register expected 201, got $($r.status): $($r.text)" }
  $script:token = $r.json.token
  LogSub "token ok, user=$($r.json.user.username)"

  # 02 connectivity test
  Log 'POST /api/storage/test (real jianguoyun)'
  $cfg = @{ address = $WD_ADDRESS; username = $WD_USER; password = $WD_PASS; authType = 'basic'; remoteBaseDir = $REMOTE_BASE_DIR }
  $r = Invoke-Api 'POST' '/api/storage/test' (AuthHeaders $null) @{ type = 'webdav'; config = $cfg } $null
  if ($r.status -ne 200 -or -not $r.json.ok) { Fail "storage/test expected {ok:true}, got $($r.status): $($r.text)" }
  LogSub 'connectivity OK'

  # 03 create storage
  Log 'POST /api/storage create webdav storage'
  $r = Invoke-Api 'POST' '/api/storage' (AuthHeaders $null) @{ name = "e2e-$ts"; type = 'webdav'; config = $cfg } $null
  if ($r.status -ne 201) { Fail "storage create expected 201, got $($r.status): $($r.text)" }
  $storageId = $r.json.storage.id
  LogSub "storageId=$storageId"

  $storageHeaders = AuthHeaders @{ 'X-Storage-Id' = $storageId }
  $putHeaders = AuthHeaders @{ 'X-Storage-Id' = $storageId; 'X-Sync-Folder' = $SYNC_FOLDER }

  # 04 put v1
  Log "POST /api/put v1 (path=$path)"
  $v1Content = "hello e2e v1 @ $ts"
  $v1B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v1Content))
  $r = Invoke-Api 'POST' '/api/put' $putHeaders @{ path = $path; mtime = $ts; content = $v1B64; author = 'e2e-script' } $null
  if ($r.status -ne 201) { Fail "put v1 expected 201, got $($r.status): $($r.text)" }
  $v1Id = $r.json.version.versionId
  if (-not $v1Id) { Fail 'put v1 did not return version.versionId' }
  LogSub "versionId=$v1Id"

  # 05 get verify
  Log 'GET /api/get verify content'
  $r = Invoke-Api 'GET' '/api/get' $storageHeaders $null @{ path = $path }
  if ($r.status -ne 200) { Fail "get expected 200, got $($r.status): $($r.text)" }
  $got = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($r.json.content))
  if ($got -ne $v1Content) { Fail "content mismatch: $got" }
  LogSub 'content matches'

  # 06 list
  Log 'GET /api/list'
  $r = Invoke-Api 'GET' '/api/list' $storageHeaders $null $null
  if ($r.status -ne 200) { Fail "list expected 200, got $($r.status): $($r.text)" }
  $hit = $r.json.files | Where-Object { $_.path -eq $path }
  if (-not $hit) { Fail "list did not find $path" }
  LogSub "list contains $path ($($r.json.files.Count) current files total)"

  # 07 put v2
  Log 'POST /api/put v2'
  $v2Content = "hello e2e v2 @ $ts"
  $v2B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v2Content))
  $r = Invoke-Api 'POST' '/api/put' $putHeaders @{ path = $path; mtime = ($ts + 1000); content = $v2B64; author = 'e2e-script' } $null
  if ($r.status -ne 201) { Fail "put v2 expected 201, got $($r.status): $($r.text)" }
  LogSub "versionId=$($r.json.version.versionId)"

  # 08 history
  Log 'GET /api/history'
  $r = Invoke-Api 'GET' '/api/history' $storageHeaders $null @{ path = $path }
  if ($r.status -ne 200) { Fail "history expected 200, got $($r.status): $($r.text)" }
  if ($r.json.versions.Count -lt 2) { Fail "history expected >=2 versions, got $($r.json.versions.Count)" }
  LogSub "$($r.json.versions.Count) versions in history"

  # 09 rollback to v1
  Log "POST /api/rollback to $v1Id"
  $r = Invoke-Api 'POST' '/api/rollback' $putHeaders @{ path = $path; version = $v1Id } $null
  if ($r.status -ne 201) { Fail "rollback expected 201, got $($r.status): $($r.text)" }
  LogSub "new version $($r.json.version.versionId) (content reverted to v1)"

  # 10 verify rollback content
  Log 'GET /api/get verify rollback content'
  $r = Invoke-Api 'GET' '/api/get' $storageHeaders $null @{ path = $path }
  if ($r.status -ne 200) { Fail "get expected 200, got $($r.status): $($r.text)" }
  $got = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($r.json.content))
  if ($got -ne $v1Content) { Fail "rollback content should be v1, got: $got" }
  LogSub 'rollback content = v1 OK'

  # 11 jianguoyun PROPFIND to confirm object landed
  Log 'jianguoyun PROPFIND confirm object landed'
  $propUrl = "$($WD_ADDRESS.TrimEnd('/'))/$REMOTE_BASE_DIR/$SYNC_FOLDER/"
  $propBody = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>'
  $propRes = Invoke-WebRequest -Uri $propUrl -Method PROPFIND -Headers @{ Authorization = $basicAuth; Depth = '1'; 'Content-Type' = 'application/xml' } -Body $propBody -UseBasicParsing -TimeoutSec 60
  $xml = $propRes.Content
  if ($xml -notlike "*$path*") { Fail "jianguoyun side did not find $path" }
  $occ = ([regex]::Matches($xml, [regex]::Escape($path))).Count
  LogSub "jianguoyun side found $occ $path version objects"

  Log 'DELETE /api/storage removes only Synx metadata and preserves remote files'
  $r = Invoke-Api 'DELETE' "/api/storage/$storageId" (AuthHeaders $null) $null $null
  if ($r.status -ne 200 -or -not $r.json.ok) { Fail "storage delete expected 200 {ok:true}, got $($r.status): $($r.text)" }
  if (-not $r.json.remoteFilesPreserved -or $r.json.deletedVersions -lt 3) { Fail "storage delete intermediary semantics invalid: $($r.text)" }
  $verify = Invoke-Api 'GET' "/api/storage/$storageId" (AuthHeaders $null) $null $null
  if ($verify.status -ne 404) { Fail "storage metadata should be deleted, GET got $($verify.status): $($verify.text)" }
  $remote = Invoke-WebRequest -Uri $propUrl -Method PROPFIND -Headers @{ Authorization = $basicAuth; Depth = '1'; 'Content-Type' = 'application/xml' } -Body $propBody -UseBasicParsing -TimeoutSec 60
  if ($remote.Content -notlike "*$path*") { Fail 'remote file was not preserved after removing Synx storage' }
  $storageId = ''
  LogSub "deleted $($r.json.deletedVersions) metadata rows and preserved remote files"

  Add-Content -Path $LogFile -Value 'PASS: full e2e passed with intermediary-only storage removal' -Encoding utf8
}
catch {
  Add-Content -Path $LogFile -Value "EXCEPTION: $($_.Exception.Message)" -Encoding utf8
  Add-Content -Path $LogFile -Value "$($_.ScriptStackTrace)" -Encoding utf8
  [void](Cleanup)
  exit 1
}

if (-not (Cleanup)) { exit 1 }
