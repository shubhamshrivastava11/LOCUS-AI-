# External uptime check for Locus AI.
#
# STATUS, 16 Sep 2026: works when run by hand, does NOT work under Windows
# Task Scheduler on this machine, and the scheduled task has been removed
# rather than left registered.
#
# Run by hand it is verified in all three states - healthy, stale, recovered.
# Under the scheduler powershell.exe exits 0 having done nothing at all: no
# log line, no exception, no output even with stdout and stderr redirected.
# Ruled out, each by direct test: the environment (LOCALAPPDATA and
# USERPROFILE both resolve correctly), the script's location (Desktop and
# two other directories behave identically), spaces in the path, argument
# quoting, -File versus -Command, the file's encoding (plain ASCII), zone
# marking (no alternate data stream), Invoke-WebRequest (replaced with
# curl.exe, no change), Group Policy execution policy (Undefined at every
# scope) and Defender ASR rules (none configured). An inline
# -Command works under the same task, so the scheduler runs powershell fine
# and refuses only script files.
#
# It was left removed deliberately. A monitor that silently does not run is
# the precise failure this whole system exists to prevent, and a registered
# task that never fires is worse than no task at all.
#
# The hosted pinger is the better answer regardless: it is always on, where
# this depends on the machine being awake. Point one at the same endpoint
# with the x-internal-key header and treat 503 as down.
#
# Runs on the Windows scheduler, outside the Supabase project, which is the
# entire point: admin-health runs on pg_cron INSIDE that project and therefore
# cannot report the project being gone. If Supabase is unreachable, cron does
# not fire, no email is sent, and silence reads as health - the exact failure
# that left the product dark for most of 16 Sep 2026.
#
# This reads the cached verdict (a GET, roughly three seconds) rather than
# triggering a run, so it costs the system one indexed row read. The endpoint
# returns 503 both when a check is failing AND when the stored results have
# gone stale, so this alerts on "the scheduler has stopped" as well as on "the
# scheduler ran and found something wrong".
#
# Honest limitation: a laptop that is asleep is not monitoring anything. This
# covers the hours the machine is on, which is most of them for a machine
# somebody works on daily, and it is strictly better than nothing. A hosted
# pinger (UptimeRobot, Better Stack, Healthchecks.io) is the always-on version
# and needs an account, which is the only reason this exists instead.
#
# Remove with:  schtasks /Delete /TN "LocusAI Uptime" /F

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 still negotiates SSL3/TLS1.0 by default, and Supabase
# requires TLS 1.2. An interactive session often has this set already by a
# profile or an earlier command, which is exactly why it works by hand and
# fails under the scheduler, where -NoProfile means nothing has set it.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Url         = 'https://imazdfzxinltbgktrgmv.supabase.co/functions/v1/admin-health'
$KeyFile     = "$env:USERPROFILE\Desktop\FYP\aggregate_test_tenant_credentials.txt"
$LogFile     = "$env:LOCALAPPDATA\LocusAI\uptime.log"
$StateFile   = "$env:LOCALAPPDATA\LocusAI\uptime-state.txt"

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

function Write-Log([string]$Line) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Line" | Add-Content -Path $LogFile -Encoding utf8
}

# Toast rather than a console window, because a scheduled task has no console
# anybody is looking at. Wrapped because the WinRT surface differs across
# Windows builds and a failed notification must never be the reason the check
# itself fails - it would be a monitor that dies when it has something to say.
function Show-Toast([string]$Title, [string]$Message) {
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
            [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $texts = $template.GetElementsByTagName('text')
        $texts.Item(0).AppendChild($template.CreateTextNode($Title))    | Out-Null
        $texts.Item(1).AppendChild($template.CreateTextNode($Message))  | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(
            'Microsoft.WindowsPowerShell_8wekyb3d8bbwe!Microsoft.WindowsPowerShell').Show($toast)
    } catch {
        Write-Log "toast failed: $($_.Exception.Message)"
    }
}

# The key lives in the credentials file already rather than being copied into
# this script, so there is one place it exists on disk and rotating it does not
# mean remembering to edit this too.
if (-not (Test-Path $KeyFile)) {
    Write-Log "FAIL  credentials file not found at $KeyFile"
    Show-Toast 'Locus AI uptime check broken' 'Credentials file is missing.'
    exit 1
}

$keyLine = Select-String -Path $KeyFile -Pattern '^INTERNAL_FUNCTION_KEY\s' | Select-Object -First 1
if (-not $keyLine) {
    Write-Log 'FAIL  no INTERNAL_FUNCTION_KEY line in the credentials file'
    Show-Toast 'Locus AI uptime check broken' 'No INTERNAL_FUNCTION_KEY in the credentials file.'
    exit 1
}
$key = ($keyLine.Line -split '\s+', 2)[1].Trim()

# curl.exe rather than Invoke-WebRequest, and this was not a style choice.
#
# Invoke-WebRequest ran fine by hand and, under Task Scheduler, hung without
# erroring and without honouring -TimeoutSec - the script simply produced
# nothing, no log line and no exception, on every scheduled run. PowerShell
# 5.1's web stack leans on .NET and WinINET state that a non-interactive
# service context does not have, and -TimeoutSec does not bound the part that
# stalls. curl.exe has shipped in Windows since 1803, has none of that
# coupling, and its --max-time is a hard ceiling on the whole request.
#
# Three attempts over ninety seconds. One dropped request is a network blip,
# and a monitor that pages on a single failed connection gets muted inside a
# week - at which point it is worse than not having one.
$curl = "$env:SystemRoot\System32\curl.exe"
$status = 0
$body   = $null

for ($attempt = 1; $attempt -le 3; $attempt++) {
    # Body and status in one invocation: the status is appended after a marker
    # so a failed request still yields whatever the server managed to say.
    $raw = & $curl --silent --show-error --max-time 45 `
        --header "x-internal-key: $key" `
        --write-out "`n<<<HTTP:%{http_code}>>>" `
        --request GET $Url 2>&1 | Out-String

    if ($raw -match '<<<HTTP:(\d+)>>>') {
        $status = [int]$matches[1]
        $body = ($raw -split '<<<HTTP:')[0].Trim()
        # A 503 is an answer, not a failure to reach it. Only retry silence.
        if ($status -ne 0) { break }
    }

    $status = 0
    if ($attempt -lt 3) { Start-Sleep -Seconds 30 }
}

$detail = ''
if ($body) {
    try { $detail = (ConvertFrom-Json $body).detail } catch { $detail = '' }
}

$now = if ($status -eq 200) { 'UP' } else { 'DOWN' }

# Only the TRANSITION is announced, never the state. A toast every five minutes
# while something is broken is how a person learns to dismiss toasts, and the
# next real one then lands on somebody who has stopped reading them.
$previous = if (Test-Path $StateFile) { (Get-Content $StateFile -Raw).Trim() } else { '' }
Set-Content -Path $StateFile -Value $now -Encoding utf8

if ($status -eq 200) {
    Write-Log "UP    $detail"
    if ($previous -eq 'DOWN') {
        Show-Toast 'Locus AI recovered' $detail
    }
} else {
    $what = if ($status -eq 0) { 'No response at all - the project may be unreachable.' }
            elseif ($status -eq 503) { $detail }
            elseif ($status -eq 401) { 'Rejected the internal key. It may have been rotated.' }
            else { "Unexpected HTTP $status." }
    Write-Log "DOWN  HTTP $status  $what"
    if ($previous -ne 'DOWN') {
        Show-Toast 'Locus AI is down' $what
    }
}
