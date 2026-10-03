# make-icon.ps1 - build a multi-size Windows .ico (32bpp, with alpha) from a
# black-art-on-white PNG, plus an optional transparent PNG of the largest size.
#
# Pure ASCII on purpose (see README.md in this folder): Windows PowerShell 5.1
# decodes a BOM-less UTF-8 script as GBK, and the DSH edit tool drops the BOM.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-icon.ps1 `
#       -SourcePng <white-background png> -OutIco dsh.ico -OutPng dsh-logo.png
#
param(
    [Parameter(Mandatory = $true)][string]$SourcePng,
    [Parameter(Mandatory = $true)][string]$OutIco,
    [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256),
    [string]$OutPng = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = New-Object System.Drawing.Bitmap($SourcePng)

# Turn "black art on white" into "black with alpha": alpha = 255 - luminance.
function Convert-ToAlpha([System.Drawing.Bitmap]$bmp) {
    $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $len = $data.Stride * $bmp.Height
        $bytes = New-Object byte[] $len
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $len)
        for ($y = 0; $y -lt $bmp.Height; $y++) {
            $row = $y * $data.Stride
            for ($x = 0; $x -lt $bmp.Width; $x++) {
                $i = $row + $x * 4
                $b = [int]$bytes[$i]; $g = [int]$bytes[$i + 1]; $r = [int]$bytes[$i + 2]
                $lum = [int](0.299 * $r + 0.587 * $g + 0.114 * $b)
                if ($lum -lt 0) { $lum = 0 }
                if ($lum -gt 255) { $lum = 255 }
                $bytes[$i] = 0; $bytes[$i + 1] = 0; $bytes[$i + 2] = 0
                $bytes[$i + 3] = [byte](255 - $lum)
            }
        }
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $len)
    } finally {
        $bmp.UnlockBits($data)
    }
}

# One .ico image entry in the classic 32bpp DIB form:
# BITMAPINFOHEADER (biHeight doubled) + bottom-up BGRA rows + zero AND mask.
function Get-DibBytes([System.Drawing.Bitmap]$bmp) {
    $w = $bmp.Width
    $h = $bmp.Height
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([uint32]40)
    $bw.Write([int32]$w)
    $bw.Write([int32]($h * 2))
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]0)
    $bw.Write([uint32]($w * $h * 4))
    $bw.Write([int32]0); $bw.Write([int32]0)
    $bw.Write([uint32]0); $bw.Write([uint32]0)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $row = New-Object byte[] ($w * 4)
        for ($y = $h - 1; $y -ge 0; $y--) {
            $p = [IntPtr]($data.Scan0.ToInt64() + $y * $data.Stride)
            [System.Runtime.InteropServices.Marshal]::Copy($p, $row, 0, $row.Length)
            $bw.Write($row)
        }
    } finally {
        $bmp.UnlockBits($data)
    }
    $andRowBytes = [int]([math]::Ceiling($w / 32.0) * 4)
    $bw.Write((New-Object byte[] ($andRowBytes * $h)))
    $bw.Flush()
    # Leading comma: without it PowerShell unrolls the byte[] into single bytes
    # on return and the caller gets an Object[] instead of a byte[].
    return , $ms.ToArray()
}

$sizesSorted = $Sizes | Sort-Object
$maxSize = ($sizesSorted | Measure-Object -Maximum).Maximum
$dibs = @()
$kept = @()

foreach ($s in $sizesSorted) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    Convert-ToAlpha $bmp
    if ($OutPng -ne '' -and $s -eq $maxSize) { $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png) }
    [byte[]]$dib = Get-DibBytes $bmp
    $dibs += , $dib
    $kept += $s
    $bmp.Dispose()
}
$src.Dispose()

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$kept.Count)
$offset = 6 + 16 * $kept.Count
for ($i = 0; $i -lt $kept.Count; $i++) {
    $s = $kept[$i]
    $dim = $s
    if ($s -ge 256) { $dim = 0 }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$dibs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $dibs[$i].Length
}
for ($i = 0; $i -lt $kept.Count; $i++) { $bw.Write($dibs[$i]) }
$bw.Flush()
$outBytes = $ms.ToArray()
[System.IO.File]::WriteAllBytes($OutIco, $outBytes)

Write-Host ('[make-icon] wrote ' + $OutIco + ' (' + $outBytes.Length + ' bytes) sizes=' + ($kept -join ','))
if ($OutPng -ne '') { Write-Host ('[make-icon] wrote ' + $OutPng) }
