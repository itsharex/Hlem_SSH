#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot

# ── 工具函数 ──────────────────────────────────────────────

function Write-Header {
    Clear-Host
    Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║          HelM  Build  Script         ║" -ForegroundColor Cyan
    Write-Host "╠══════════════════════════════════════╣" -ForegroundColor Cyan
    Write-Host "║  1  LTO 编译  (体积小 / 速度慢)      ║" -ForegroundColor White
    Write-Host "║  2  普通编译  (速度快)                ║" -ForegroundColor White
    Write-Host "║  3  清理编译缓存                      ║" -ForegroundColor White
    Write-Host "║  0  退出                              ║" -ForegroundColor DarkGray
    Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Assert-Commands {
    foreach ($cmd in @("npm", "cargo")) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            Write-Host "[错误] 未找到命令: $cmd，请确认已安装并加入 PATH。" -ForegroundColor Red
            exit 1
        }
    }
}

function Install-NodeDeps {
    Write-Step "安装 / 更新前端依赖"
    Push-Location $Root
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    } finally {
        Pop-Location
    }
}

function Show-Artifact {
    $exe = Get-ChildItem -Path "$Root\src-tauri\target\release" `
                         -Filter "helm.exe" -ErrorAction SilentlyContinue |
           Select-Object -First 1
    Write-Host ""
    if ($exe) {
        Write-Host "✔ 编译成功" -ForegroundColor Green
        Write-Host "  产物: $($exe.FullName)" -ForegroundColor Yellow
        $size = [math]::Round($exe.Length / 1MB, 2)
        Write-Host "  大小: ${size} MB" -ForegroundColor Yellow
    } else {
        Write-Host "✔ 编译完成（未在 target/release 找到 helm.exe）" -ForegroundColor Yellow
    }
}

function Invoke-BuildLTO {
    Write-Step "LTO 编译（thin LTO + strip）"
    Install-NodeDeps
    Push-Location $Root
    try {
        $env:CARGO_PROFILE_RELEASE_LTO           = "thin"
        $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "1"
        $env:CARGO_PROFILE_RELEASE_STRIP         = "symbols"
        npm run tauri:build
        if ($LASTEXITCODE -ne 0) { throw "tauri build 失败" }
    } finally {
        Remove-Item Env:\CARGO_PROFILE_RELEASE_LTO           -ErrorAction SilentlyContinue
        Remove-Item Env:\CARGO_PROFILE_RELEASE_CODEGEN_UNITS -ErrorAction SilentlyContinue
        Remove-Item Env:\CARGO_PROFILE_RELEASE_STRIP         -ErrorAction SilentlyContinue
        Pop-Location
    }
    Show-Artifact
}

function Invoke-BuildNormal {
    Write-Step "普通编译"
    Install-NodeDeps
    Push-Location $Root
    try {
        npm run tauri:build
        if ($LASTEXITCODE -ne 0) { throw "tauri build 失败" }
    } finally {
        Pop-Location
    }
    Show-Artifact
}

function Invoke-Clean {
    Write-Step "清理编译缓存"
    $targetDir = "$Root\src-tauri\target"
    if (Test-Path $targetDir) {
        $sizeMB = [math]::Round(
            (Get-ChildItem $targetDir -Recurse -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum / 1MB, 1)
        Write-Host "  目录: $targetDir" -ForegroundColor DarkGray
        Write-Host "  占用: ${sizeMB} MB" -ForegroundColor DarkGray
        Write-Host ""
        $confirm = Read-Host "  确认删除？(y/N)"
        if ($confirm -match "^[Yy]$") {
            Push-Location $Root
            try {
                cargo clean --manifest-path src-tauri/Cargo.toml
                if ($LASTEXITCODE -ne 0) { throw "cargo clean 失败" }
            } finally {
                Pop-Location
            }
            Write-Host "✔ 缓存已清理" -ForegroundColor Green
        } else {
            Write-Host "  已取消" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "  target 目录不存在，无需清理。" -ForegroundColor DarkGray
    }
}

# ── 主循环 ────────────────────────────────────────────────

Assert-Commands

while ($true) {
    Write-Header
    $choice = Read-Host "请选择 [0-3]"

    switch ($choice.Trim()) {
        "1" {
            try { Invoke-BuildLTO }
            catch { Write-Host "[错误] $_" -ForegroundColor Red }
            Write-Host ""
            Read-Host "按 Enter 返回菜单"
        }
        "2" {
            try { Invoke-BuildNormal }
            catch { Write-Host "[错误] $_" -ForegroundColor Red }
            Write-Host ""
            Read-Host "按 Enter 返回菜单"
        }
        "3" {
            try { Invoke-Clean }
            catch { Write-Host "[错误] $_" -ForegroundColor Red }
            Write-Host ""
            Read-Host "按 Enter 返回菜单"
        }
        "0" {
            Write-Host "再见。" -ForegroundColor DarkGray
            exit 0
        }
        default {
            Write-Host "无效输入，请输入 0-3。" -ForegroundColor Yellow
            Start-Sleep -Seconds 1
        }
    }
}
