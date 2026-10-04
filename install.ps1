function Install-RoastCli {
    $ErrorActionPreference = 'Stop'
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw '请先安装 Node.js 22 或更新版本：https://nodejs.org/'
    }
    $nodeVersion = & node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 22) {
        throw 'RoastCli 需要 Node.js 22 或更新版本：https://nodejs.org/'
    }
    $packageUrl = 'https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz'
    Write-Host '正在安装 RoastCli…'
    & npm.cmd install --global $packageUrl
    if ($LASTEXITCODE -ne 0) { throw '安装失败，请检查上面的 npm 错误信息。' }
    Write-Host '安装完成。运行 roast config 配置 API Key，然后运行 roast。'
}

Install-RoastCli
