# Downloads the two open-source libraries from npm and copies them into site/vendor/
# so the website serves them itself (no third-party CDNs). Requires Node.js.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$tmp = Join-Path $root 'vendor-tmp'
$vendor = Join-Path $root 'site\vendor'
New-Item -ItemType Directory -Force $tmp, $vendor | Out-Null

Push-Location $tmp
try {
  npm init -y | Out-Null
  npm install --no-audit --no-fund --ignore-scripts pdfjs-dist@4.10.38 mammoth@1.8.0
  Copy-Item node_modules\pdfjs-dist\build\pdf.min.mjs, node_modules\pdfjs-dist\build\pdf.worker.min.mjs $vendor -Force
  Copy-Item node_modules\pdfjs-dist\LICENSE (Join-Path $vendor 'LICENSE-pdfjs.txt') -Force
  Copy-Item node_modules\mammoth\mammoth.browser.min.js $vendor -Force
  Copy-Item node_modules\mammoth\LICENSE (Join-Path $vendor 'LICENSE-mammoth.txt') -Force
} finally {
  Pop-Location
  Remove-Item -Recurse -Force $tmp
}
Write-Host "Done. Files in $vendor :"
Get-ChildItem $vendor | Select-Object Name, Length
