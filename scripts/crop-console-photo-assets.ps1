param()

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$assetRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\src\assets\console"))
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

if (-not $assetRoot.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to process assets outside the workspace."
}

function Crop-TransparentPng {
  param([Parameter(Mandatory = $true)][string]$FileName)

  $path = [System.IO.Path]::GetFullPath((Join-Path $assetRoot $FileName))
  if (-not $path.StartsWith($assetRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to process an asset outside the console asset directory."
  }

  $source = [System.Drawing.Bitmap]::FromFile($path)
  try {
    $left = $source.Width
    $top = $source.Height
    $right = -1
    $bottom = -1

    for ($y = 0; $y -lt $source.Height; $y += 1) {
      for ($x = 0; $x -lt $source.Width; $x += 1) {
        if ($source.GetPixel($x, $y).A -le 2) { continue }
        if ($x -lt $left) { $left = $x }
        if ($x -gt $right) { $right = $x }
        if ($y -lt $top) { $top = $y }
        if ($y -gt $bottom) { $bottom = $y }
      }
    }

    if ($right -lt $left -or $bottom -lt $top) {
      throw "Asset has no visible pixels: $FileName"
    }

    $rect = [System.Drawing.Rectangle]::FromLTRB($left, $top, $right + 1, $bottom + 1)
    $cropped = $source.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $temporaryPath = "$path.cropped.png"
      $cropped.Save($temporaryPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
      $cropped.Dispose()
    }
  }
  finally {
    $source.Dispose()
  }

  Move-Item -LiteralPath "$path.cropped.png" -Destination $path -Force
}

@(
  "panel-blank-photo.png",
  "button-phenolic-up.png",
  "button-phenolic-square.png",
  "key-white-photo.png",
  "key-white-photo-b.png",
  "key-black-photo.png",
  "selector-arrow-photo.png"
) | ForEach-Object { Crop-TransparentPng -FileName $_ }
