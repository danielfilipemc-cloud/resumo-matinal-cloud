param(
    [Parameter(Mandatory = $true)]
    [string]$TextFile,

    [string]$BotToken = $env:TELEGRAM_BOT_TOKEN,
    [string]$ChatId = $env:TELEGRAM_CHAT_ID,
    [int]$MaxChunkLength = 3500
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BotToken)) {
    throw "Missing Telegram bot token. Set TELEGRAM_BOT_TOKEN."
}

if ([string]::IsNullOrWhiteSpace($ChatId)) {
    throw "Missing Telegram chat id. Set TELEGRAM_CHAT_ID."
}

if (-not (Test-Path -LiteralPath $TextFile)) {
    throw "Text file not found: $TextFile"
}

$rawText = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($rawText)) {
    throw "Text file is empty: $TextFile"
}

function Split-TelegramMessage {
    param(
        [string]$Text,
        [int]$Limit
    )

    $normalized = $Text -replace "`r`n", "`n"
    $paragraphs = $normalized -split "`n`n+"
    $chunks = New-Object System.Collections.Generic.List[string]
    $current = ""

    foreach ($paragraph in $paragraphs) {
        $candidate = if ([string]::IsNullOrEmpty($current)) { $paragraph } else { "$current`n`n$paragraph" }
        if ($candidate.Length -le $Limit) {
            $current = $candidate
            continue
        }

        if (-not [string]::IsNullOrEmpty($current)) {
            $chunks.Add($current)
            $current = ""
        }

        if ($paragraph.Length -le $Limit) {
            $current = $paragraph
            continue
        }

        $offset = 0
        while ($offset -lt $paragraph.Length) {
            $length = [Math]::Min($Limit, $paragraph.Length - $offset)
            $slice = $paragraph.Substring($offset, $length)
            $chunks.Add($slice)
            $offset += $length
        }
    }

    if (-not [string]::IsNullOrEmpty($current)) {
        $chunks.Add($current)
    }

    return $chunks
}

$chunks = Split-TelegramMessage -Text $rawText -Limit $MaxChunkLength
$total = $chunks.Count
$results = @()

for ($i = 0; $i -lt $total; $i++) {
    $prefix = if ($total -gt 1) { "[Parte {0}/{1}]`n" -f ($i + 1), $total } else { "" }
    $payloadText = $prefix + $chunks[$i]

    $response = & curl.exe -sS -X POST "https://api.telegram.org/bot$BotToken/sendMessage" `
        -d "chat_id=$ChatId" `
        --data-urlencode "text=$payloadText"

    if ($LASTEXITCODE -ne 0) {
        throw "curl.exe failed while sending Telegram message part $($i + 1)."
    }

    $parsed = $response | ConvertFrom-Json
    if (-not $parsed.ok) {
        $errorJson = $response | Out-String
        throw "Telegram API returned an error for part $($i + 1): $errorJson"
    }

    $results += [PSCustomObject]@{
        part = $i + 1
        total_parts = $total
        message_id = $parsed.result.message_id
        date = $parsed.result.date
    }
}

$results | ConvertTo-Json -Depth 4
