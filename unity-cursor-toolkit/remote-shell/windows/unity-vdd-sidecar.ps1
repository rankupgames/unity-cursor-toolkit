param(
	[Parameter(Mandatory = $true)][string]$WorkspacePath,
	[Parameter(Mandatory = $true)][string]$UnityPlayerPath,
	[string]$WindowTitle = "Unity VDD Shell",
	[int]$Monitor = 2,
	[int]$Width = 1280,
	[int]$Height = 720,
	[int]$Fps = 30,
	[int]$Quality = 70,
	[int]$StreamPort = 48170,
	[int]$ControlPort = 48171,
	[string]$FfmpegPath = "ffmpeg"
)

$ErrorActionPreference = "Stop"

if ((Test-Path -LiteralPath $UnityPlayerPath) -eq $false) {
	throw "Unity player not found: $UnityPlayerPath"
}

if ((Test-Path -LiteralPath $WorkspacePath) -eq $false) {
	New-Item -ItemType Directory -Force -Path $WorkspacePath | Out-Null
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UctInput {
	[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
	[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
	[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
}
"@

$state = [ordered]@{
	startedAt = (Get-Date).ToUniversalTime().ToString("o")
	workspacePath = $WorkspacePath
	unityPlayerPath = $UnityPlayerPath
	windowTitle = $WindowTitle
	monitor = $Monitor
	width = $Width
	height = $Height
	fps = $Fps
	quality = $Quality
	streamPort = $StreamPort
	controlPort = $ControlPort
	streamUrl = "http://127.0.0.1:$StreamPort/viewport.mjpg"
}

function ConvertTo-MjpegQualityScale([int]$Percent) {
	$clamped = [Math]::Min(100, [Math]::Max(1, $Percent))
	return [Math]::Min(31, [Math]::Max(2, [int](31 - (($clamped / 100.0) * 29))))
}

function Send-Json($Context, $Payload, [int]$StatusCode = 200) {
	$json = ($Payload | ConvertTo-Json -Depth 8)
	$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
	$Context.Response.StatusCode = $StatusCode
	$Context.Response.ContentType = "application/json; charset=utf-8"
	$Context.Response.ContentLength64 = $bytes.Length
	$Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
	$Context.Response.OutputStream.Close()
}

function Read-BodyJson($Request) {
	$reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
	$body = $reader.ReadToEnd()
	if ([string]::IsNullOrWhiteSpace($body)) {
		return @{}
	}
	return $body | ConvertFrom-Json
}

function Send-Input($InputPayload) {
	$type = if ($InputPayload.type) { [string]$InputPayload.type } else { "click" }
	if ($type -eq "move" -or $type -eq "click" -or $type -eq "pointerDown" -or $type -eq "pointerUp") {
		$x = [int]$InputPayload.x
		$y = [int]$InputPayload.y
		[UctInput]::SetCursorPos($x, $y) | Out-Null
		if ($type -eq "click" -or $type -eq "pointerDown") {
			[UctInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
		}
		if ($type -eq "click" -or $type -eq "pointerUp") {
			[UctInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
		}
		return @{ success = $true; type = $type; x = $x; y = $y }
	}

	if ($type -eq "key") {
		$keyCode = [byte]([int]$InputPayload.keyCode)
		[UctInput]::keybd_event($keyCode, 0, 0, [UIntPtr]::Zero)
		[UctInput]::keybd_event($keyCode, 0, 0x0002, [UIntPtr]::Zero)
		return @{ success = $true; type = "key"; keyCode = $keyCode }
	}

	return @{ success = $false; error = "Unsupported input type: $type" }
}

$unityArgs = @(
	"-monitor", "$Monitor",
	"-screen-width", "$Width",
	"-screen-height", "$Height",
	"-screen-fullscreen", "1",
	"-window-mode", "borderless"
)
$unityProcess = Start-Process -FilePath $UnityPlayerPath -ArgumentList $unityArgs -WorkingDirectory $WorkspacePath -PassThru

Start-Sleep -Seconds 3

$qualityScale = ConvertTo-MjpegQualityScale $Quality
$ffmpegArgs = @(
	"-hide_banner",
	"-loglevel", "warning",
	"-f", "gdigrab",
	"-framerate", "$Fps",
	"-draw_mouse", "1",
	"-i", "title=$WindowTitle",
	"-q:v", "$qualityScale",
	"-f", "mpjpeg",
	"-listen", "1",
	"http://127.0.0.1:$StreamPort/viewport.mjpg"
)
$ffmpegProcess = Start-Process -FilePath $FfmpegPath -ArgumentList $ffmpegArgs -WorkingDirectory $WorkspacePath -PassThru

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$ControlPort/")
$listener.Start()
$stopping = $false

try {
	while (-not $stopping) {
		$context = $listener.GetContext()
		$path = $context.Request.Url.AbsolutePath.ToLowerInvariant()
		switch ($path) {
			"/status.json" {
				Send-Json $context @{
					success = $true
					unityRunning = (-not $unityProcess.HasExited)
					ffmpegRunning = (-not $ffmpegProcess.HasExited)
					unityPid = $unityProcess.Id
					ffmpegPid = $ffmpegProcess.Id
					state = $state
				}
			}
			"/input" {
				$inputResult = Send-Input (Read-BodyJson $context.Request)
				Send-Json $context $inputResult
			}
			"/stop" {
				$stopping = $true
				Send-Json $context @{ success = $true; stopping = $true }
			}
			default {
				Send-Json $context @{ success = $false; error = "Unknown route: $path" } 404
			}
		}
	}
}
finally {
	$listener.Stop()
	if ($ffmpegProcess -and (-not $ffmpegProcess.HasExited)) {
		$ffmpegProcess.Kill()
	}
	if ($unityProcess -and (-not $unityProcess.HasExited)) {
		$unityProcess.CloseMainWindow() | Out-Null
		Start-Sleep -Milliseconds 500
		if (-not $unityProcess.HasExited) {
			$unityProcess.Kill()
		}
	}
}
