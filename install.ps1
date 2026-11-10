#Requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-memory 装进某个 DSH profile（默认 desktop）。

.DESCRIPTION
  `dsh plugin --profile desktop add …` 会被拒绝（desktop 由 Electron 应用独占管理），
  所以手工安装分三步，本脚本把三步做完并保证可回滚：

    1. 包内垫片  node_modules/@deepseek-ai  ->  <DSH_HOME>/profiles/node_modules/@deepseek-ai
       （profile 用 junction 挂载本包时，Node 按 realpath 解析，源码目录向上找不到
        profile 的 node_modules，缺这层垫片宿主半就 import 不到 @deepseek-ai/*。）
    2. 在 <profile>/package.json 里
         dsh.profile.bundles += "@bangbang-03/dsh-memory"
         dependencies["@bangbang-03/dsh-memory"] = "link:<本包路径>"
       进了 bundles 之后包自带的 cordis.patch.yml 会被自动应用，不用改 profile 的 patch 文件。
    3. <profile>/node_modules/@bangbang-03/dsh-memory -> <本包路径>（junction）

  依赖键 / bundles 项 / cordis 行名 / 客户端模块 id 必须都是**同一个真包名**：客户端半的
  浏览器模块按 package.json 的 name 认领，任何一处写成别名，宿主半照常工作但设置面板里的
  界面会整块消失（0.3.2 改成 @bangbang-03/dsh-memory 时漏了这个，0.3.4 修）。老装法用的
  别名 `dsh-memory` 会被本脚本自动迁移掉（清条目 + 摘 junction）。

  改 package.json 前一定先备份；写盘用「临时文件 + 替换」，避免上次那种截断事故。

  远程更新模式（-FromRelease / -FromNpm / -FromUrl）：先把 tarball 解包到
  <DshHome>/plugins/dsh-memory，再对它执行上面三步。重跑同一条命令即完成更新
  （脚本会整体替换 plugins 里的旧版本，junction 与 profile 引用的目录名不变，
  所以 DSH 侧不需要任何额外动作）。
  -FromRelease 走公开的 Release 资产，匿名可下，默认 stable；lab 是已废弃的别名，
  映射到 stable，保留只是为了让老脚本不报错；
  -FromNpm 走 registry 协议（可写 dist-tag，如 @beta），用 GitHub Packages 时把 PAT
  传给 -NpmToken（需 read:packages）。

.PARAMETER Profile
  profile 名，默认 desktop。

.PARAMETER DshHome
  DSH 主目录，默认 $env:DSH_HOME 或 ~/.dsh。

.PARAMETER PackageRoot
  本包根目录，默认脚本所在目录。远程模式（-FromRelease / -FromNpm / -FromUrl）下忽略，改用解包目录。

.PARAMETER FromNpm
  远程包描述，如 "@bangbang-03/dsh-memory"（取 latest）或 "@bangbang-03/dsh-memory@0.3.1"（锁定版本）。

.PARAMETER FromUrl
  直接下载 tarball 的 URL（不走 registry 协议）。公开仓库的 Release 资产不需要任何凭据：
  https://github.com/BangBang-03/dsh-memory-portrait/releases/latest/download/dsh-memory-latest.tgz

.PARAMETER FromRelease
  从 GitHub Release 装指定通道的最新版（公开资产，不需要任何凭据）。通道见 -Channel。

.PARAMETER Channel
  Release 通道，默认 stable：
    stable 稳定线。资产挂在最新正式 Release 上（/latest/ 天然跳过预发布）：
           releases/latest/download/dsh-memory-latest.tgz
    lab    已废弃的别名，等价于 stable（保留是为了老脚本不报错）。

.PARAMETER Registry
  npm registry 根地址，默认 https://registry.npmjs.org；GitHub Packages 用
  https://npm.pkg.github.com（必须配 -NpmToken）。

.PARAMETER NpmToken
  访问 registry 用的 Bearer token（GitHub Packages 必填，npmjs 公共包可省）。
  默认读环境变量 NPM_TOKEN。

.PARAMETER DryRun
  只打印将要做的改动，不落盘、不联网。

.EXAMPLE
  pwsh -File install.ps1                         # 装当前目录这份源码（开发用）
  pwsh -File install.ps1 -Profile web -DryRun
  pwsh -File install.ps1 -FromRelease            # 装最新稳定版（默认 stable）
  pwsh -File install.ps1 -FromNpm "@bangbang-03/dsh-memory" -Registry https://npm.pkg.github.com -NpmToken $env:NPM_TOKEN
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [string]$PackageRoot = '',
  [string]$FromNpm = '',
  [string]$FromUrl = '',
  [switch]$FromRelease,
  [ValidateSet('lab', 'stable')]
  [string]$Channel = 'stable',
  [string]$Registry = 'https://registry.npmjs.org',
  [string]$NpmToken = $(if ($env:NPM_TOKEN) { $env:NPM_TOKEN } else { '' }),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 在 param() 的默认表达式里还没给 $PSScriptRoot 赋值（拿到空串），
# 只有脚本正文里才有。远程模式（-FromNpm / -FromUrl / -FromRelease）不会显式传
# -PackageRoot，旧写法在 5.1 上会卡在第一句 Resolve-Path -LiteralPath ''
# （ParameterBindingValidationErrorEmptyStringNotAllowed），连下载都还没开始就退出。
if (-not $PackageRoot) { $PackageRoot = $PSScriptRoot }

# 真包名：依赖键 / bundles 项 / cordis 行名 / 客户端模块 id 都得是它（见文件头说明）。
$PackageName = '@bangbang-03/dsh-memory'
# 0.3.2 之前用的别名（依赖键与 junction 都叫这个），装过就自动迁移掉。
$LegacyName = 'dsh-memory'
# 远程包解包目录：路径稳定、不跟包名走，重跑 -FromNpm/-FromUrl 时原地替换旧版本。
$RemoteDirName = 'dsh-memory'

function Write-Step([string]$Text) { Write-Host "  $Text" }

<# 备份名按秒带时间戳；同一秒内多次改动就往后编号，绝不覆盖已有备份。 #>
function Get-BackupPath([string]$Path) {
  $stamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
  $candidate = "$Path.bak-$stamp"
  $n = 1
  while (Test-Path -LiteralPath $candidate) {
    $candidate = "$Path.bak-$stamp-$n"
    $n += 1
  }
  return $candidate
}

function New-JunctionSafe([string]$Path, [string]$Target, [switch]$Repoint) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) {
    Write-Step "建目录 $parent"
    if (-not $DryRun) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  }
  <# Test-Path 会跟随 junction 目标：目标被删后（DSH 升级常见）它返回 false，
     New-Item 再建就会报「已存在」。用 Get-Item -Force 看 reparse point 本身。 #>
  $existing = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.LinkType -ne 'Junction') { throw "已存在且不是 junction，拒绝覆盖：$Path" }
    $current = @($existing.Target)[0]
    if ($current -eq $Target) { Write-Step "junction 已就位：$Path"; return $false }
    if (-not $Repoint) { throw "junction 指向别处：$Path -> $current（期望 $Target）" }
    # 只给「包内垫片」用：DSH 升级后官方包位置会变，垫片跟着重指是正常维护动作。
    Write-Step "重指 junction $Path -> $Target（原 $current）"
    if (-not $DryRun) {
      cmd /c rmdir "$Path" | Out-Null
      New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
    }
    return $true
  }
  Write-Step "建 junction $Path -> $Target"
  if (-not $DryRun) { New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null }
  return $true
}

function Save-Json([string]$Path, $Object) {
  $text = $Object | ConvertTo-Json -Depth 24
  $temp = "$Path.tmp-$PID"
  if (-not $DryRun) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temp, $text, $utf8)
    Move-Item -LiteralPath $temp -Destination $Path -Force
  }
}

<#
下载 tarball：先直连 Release 资产地址；连不上就改走 api.github.com 的资产端点。
本机到 github.com:443 时通时不通（DNS 能解析、握手被掐），api.github.com 一直可达，
所以这两条路是「日常能装」的关键，不是冗余代码。
#>
function Save-Tarball([string]$Url, [string]$OutFile, [hashtable]$Headers, [string]$ReleaseTag, [string]$AssetName) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $attempt = 0
  while ($attempt -lt 2) {
    $attempt += 1
    try {
      Invoke-WebRequest -Uri $Url -Headers $Headers -OutFile $OutFile -TimeoutSec 90 -UseBasicParsing -ErrorAction Stop
      return
    } catch {
      Write-Step "直连下载失败（第 $attempt 次）：$($_.Exception.Message)"
      if ($attempt -lt 2) { Start-Sleep -Seconds 2 }
    }
  }
  if (-not $ReleaseTag -or -not $AssetName) { throw "下载失败：$Url" }

  $apiBase = 'https://api.github.com/repos/BangBang-03/dsh-memory-portrait/releases'
  $releaseUrl = if ($ReleaseTag -eq 'latest') { "$apiBase/latest" } else { "$apiBase/tags/$ReleaseTag" }
  Write-Step "改走 GitHub API：$releaseUrl"
  $apiHeaders = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'dsh-memory-install' }
  if ($Headers -and $Headers.ContainsKey('Authorization')) { $apiHeaders['Authorization'] = $Headers['Authorization'] }
  $release = Invoke-RestMethod -Uri $releaseUrl -Headers $apiHeaders -TimeoutSec 60 -ErrorAction Stop
  $asset = @($release.assets) | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
  if (-not $asset) {
    throw "Release $ReleaseTag 里没有资产 $AssetName（现有：$((@($release.assets) | ForEach-Object { $_.name }) -join ', ')）"
  }
  $apiHeaders['Accept'] = 'application/octet-stream'
  Write-Step "下载资产 $AssetName（$([math]::Round($asset.size / 1024)) KB）"
  Invoke-WebRequest -Uri "$apiBase/assets/$($asset.id)" -Headers $apiHeaders -OutFile $OutFile -TimeoutSec 180 -UseBasicParsing -ErrorAction Stop
}

<# 删包目录专用：PS 5.1 的 Remove-Item -Recurse 会跟进 junction 删到目标里，
   会把共享的 @deepseek-ai 模块清掉。先把目录里已知的 junction 用 rmdir 摘掉再删本体。 #>
function Remove-PackageDir([string]$Path) {
  $shim = Join-Path $Path 'node_modules\@deepseek-ai'
  if (Test-Path -LiteralPath $shim) {
    $item = Get-Item -LiteralPath $shim -Force
    if ($item.LinkType -eq 'Junction') {
      Write-Step "摘掉垫片 junction $shim"
      if (-not $DryRun) { cmd /c rmdir "$shim" | Out-Null }
    }
  }
  if (-not $DryRun) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

Write-Host "dsh-memory 安装（profile=$Profile, dryRun=$($DryRun.IsPresent)）"

$pkgRoot = (Resolve-Path -LiteralPath $PackageRoot).Path

# ---------------------------------------------------------------- #
# 可选：远程更新模式（-FromNpm 或 -FromUrl）：拉 tarball 解包到
# <DshHome>/plugins/dsh-memory，之后 $pkgRoot 切到那里继续走本地安装三步。
# -FromNpm 走 registry 协议（元数据 → dist.tarball）；-FromUrl 直接下 tarball
# （比如 Release 资产，公开仓库不需要任何凭据）。
# ---------------------------------------------------------------- #

if ($FromNpm -or $FromUrl -or $FromRelease) {
  $remoteTarget = Join-Path (Join-Path $DshHome 'plugins') $RemoteDirName
  $tarball = ''
  $specLabel = ''
  $npmName = ''

  # 固定资产名（见 README「维护与发布」）。公开仓库的 Release 资产匿名可下，
  # 所以 -FromRelease 不需要任何凭据 —— 这是日常首选路径。
  # lab 通道已合并到 stable；保留别名只是为了让老脚本不报错。
  if ($FromRelease -and $Channel -eq 'lab') {
    Write-Warning 'lab 通道已合并到 stable；本次按 stable 安装。'
    $Channel = 'stable'
  }
  $releaseUrls = @{
    stable = 'https://github.com/BangBang-03/dsh-memory-portrait/releases/latest/download/dsh-memory-latest.tgz'
  }
  $releaseTags = @{ stable = 'latest' }
  $releaseAssets = @{ stable = 'dsh-memory-latest.tgz' }
  $releaseTag = ''
  $releaseAsset = ''

  if ($FromUrl) {
    $tarball = $FromUrl
    $specLabel = "tarball $FromUrl"
  } elseif ($FromRelease) {
    $tarball = $releaseUrls[$Channel]
    $releaseTag = $releaseTags[$Channel]
    $releaseAsset = $releaseAssets[$Channel]
    $specLabel = "$Channel 通道 $tarball"
  } else {
    # 规范：<name> 或 <name>@<version>；scoped 名自带开头的 @，版本分隔要找第二个 @。
    $npmName = $FromNpm
    $wantVersion = ''
    if ($FromNpm.StartsWith('@')) {
      $secondAt = $FromNpm.IndexOf('@', 1)
      if ($secondAt -ge 0) {
        $npmName = $FromNpm.Substring(0, $secondAt)
        $wantVersion = $FromNpm.Substring($secondAt + 1)
      }
    } elseif ($FromNpm.Contains('@')) {
      $at = $FromNpm.IndexOf('@')
      $npmName = $FromNpm.Substring(0, $at)
      $wantVersion = $FromNpm.Substring($at + 1)
    }
    if (-not $npmName) { throw "-FromNpm 缺少包名：'$FromNpm'" }
    $specLabel = if ($wantVersion) { "$npmName@$wantVersion" } else { "$npmName（latest）" }
  }

  if ($DryRun) {
    if ($tarball) { Write-Step "[dry] 会从 $tarball 下载 tarball（$specLabel）" }
    else { Write-Step "[dry] 会从 $Registry 拉 $specLabel" }
    Write-Step "[dry] 解包替换 $remoteTarget，再按本地三步安装（垫片 / package.json / junction）"
    Write-Host ''
    Write-Host 'dry run 结束，没有改动任何文件、没有联网。'
    return
  }

  $headers = @{}
  if ($NpmToken) { $headers['Authorization'] = "Bearer $NpmToken" }

  # PowerShell 5.1 默认不一定启用 TLS 1.2，registry 全是 https。
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  if (-not $tarball) {
    if (-not $NpmToken) {
      Write-Warning "没有 -NpmToken：npmjs 公共包可以匿名拉，GitHub Packages 必须提供 PAT（read:packages）"
    }
    $encoded = [uri]::EscapeDataString($npmName)
    Write-Step "查询 $Registry/$encoded"
    try {
      $meta = Invoke-RestMethod -Uri "$Registry/$encoded" -Headers $headers
    } catch {
      throw "从 $Registry 查询 $npmName 失败：$($_.Exception.Message)（包不存在、版本不存在或 registry 不可达）"
    }
    $distTags = $meta.'dist-tags'
    $version = if ($wantVersion) { $wantVersion } else { [string]$distTags.latest }
    # 版本位写的是 dist-tag（latest / beta / next …）时按标签解析，别当成版本号去查
    if ($wantVersion -and $distTags -and ($distTags.PSObject.Properties.Name -contains $wantVersion)) {
      $version = [string]$distTags.PSObject.Properties[$wantVersion].Value
    }
    if (-not $version) { throw "registry 元数据里没有 dist-tags.latest，且未指定版本" }
    $entry = $meta.versions.PSObject.Properties[$version]
    if (-not $entry) {
      throw "registry 上没有 $npmName@$version（现有版本：$(@($meta.versions.PSObject.Properties.Name) -join ', ')；dist-tags：$($distTags.PSObject.Properties.Name -join ', ')）"
    }
    $tarball = [string]$entry.Value.dist.tarball
    if (-not $tarball) { throw "registry 元数据缺 dist.tarball" }
  }

  Write-Step "下载 $tarball"
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $workDir = Join-Path ([IO.Path]::GetTempPath()) "dsh-memory-$PID-$stamp"
  $extractDir = Join-Path $workDir 'x'
  try {
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    $tempTgz = Join-Path $workDir 'pkg.tgz'
    Save-Tarball -Url $tarball -OutFile $tempTgz -Headers $headers -ReleaseTag $releaseTag -AssetName $releaseAsset
    # GNU tar 会把 "C:\xxx" 的盘符冒号当成远程主机名，所以进到解包目录用相对路径解，
    # GNU/BSD 两种 tar 都不吃亏。
    Push-Location -LiteralPath $extractDir
    try { tar -xzf '../pkg.tgz' } finally { Pop-Location }
    $extracted = Join-Path $extractDir 'package'
    if (-not (Test-Path -LiteralPath (Join-Path $extracted 'cordis.patch.yml'))) {
      throw "tarball 里没有 cordis.patch.yml，不是 dsh-memory 包：$tarball"
    }
    $fetchedVersion = ((Get-Content -LiteralPath (Join-Path $extracted 'package.json') -Raw) | ConvertFrom-Json).version

    # 旧版本目录先改名兜底：新目录就位成功才清理；就位失败则把旧版本放回原位。
    $oldRoot = "$remoteTarget.old-$PID"
    if (Test-Path -LiteralPath $oldRoot) { Remove-PackageDir $oldRoot }
    $hadOld = Test-Path -LiteralPath $remoteTarget
    $swapped = $false
    if ($hadOld) {
      $oldVersion = ((Get-Content -LiteralPath (Join-Path $remoteTarget 'package.json') -Raw) | ConvertFrom-Json).version
      Move-Item -LiteralPath $remoteTarget -Destination $oldRoot
      Write-Step "旧版本 $oldVersion 暂存 -> $oldRoot"
    }
    try {
      $pluginsParent = Split-Path -Parent $remoteTarget
      if (-not (Test-Path -LiteralPath $pluginsParent)) { New-Item -ItemType Directory -Path $pluginsParent -Force | Out-Null }
      Move-Item -LiteralPath $extracted -Destination $remoteTarget
      $swapped = $true
      Write-Step "已就位 $remoteTarget（$fetchedVersion）"
    } finally {
      if (-not $swapped -and (Test-Path -LiteralPath $oldRoot)) {
        Move-Item -LiteralPath $oldRoot -Destination $remoteTarget -Force
        Write-Step "新版本就位失败，已恢复旧版本 $remoteTarget"
      } elseif ($swapped -and (Test-Path -LiteralPath $oldRoot)) {
        Remove-PackageDir $oldRoot
        Write-Step "旧版本目录已清理"
      }
    }
    $pkgRoot = (Resolve-Path -LiteralPath $remoteTarget).Path
  } finally {
    if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $pkgRoot 'cordis.patch.yml'))) {
  throw "$pkgRoot 看起来不是 dsh-memory 包根目录（缺 cordis.patch.yml）"
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$profileJson = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profileJson)) { throw "找不到 profile 的 package.json：$profileJson" }

# ---------------------------------------------------------------- #
# 迁移：0.3.2 之前用别名 dsh-memory 装过的话，先清掉别名条目与那层 junction。
# 别名留着会被同名加载两次，而且客户端半根本注册不上 —— 设置面板整块消失。
# ---------------------------------------------------------------- #
$legacyLink = Join-Path (Join-Path $profileDir 'node_modules') $LegacyName
$legacyRaw = Get-Content -LiteralPath $profileJson -Raw
$legacyJson = $legacyRaw | ConvertFrom-Json
$legacyBundles = @($legacyJson.dsh.profile.bundles) -contains $LegacyName
$legacyDep = $legacyJson.dependencies -and ($legacyJson.dependencies.PSObject.Properties.Name -contains $LegacyName)
if ($legacyBundles -or $legacyDep) {
  if ($DryRun) {
    Write-Step "[dry] 会把旧别名 $LegacyName 从 bundles / dependencies 里清掉"
  } else {
    $backup = Get-BackupPath $profileJson
    Copy-Item -LiteralPath $profileJson -Destination $backup -Force
    Write-Step "迁移旧别名 $LegacyName -> $PackageName（备份 -> $(Split-Path -Leaf $backup)）"
    if ($legacyBundles) {
      $legacyJson.dsh.profile.bundles = @($legacyJson.dsh.profile.bundles | Where-Object { $_ -ne $LegacyName })
      Write-Step "bundles -= $LegacyName"
    }
    if ($legacyDep) {
      $legacyJson.dependencies.PSObject.Properties.Remove($LegacyName)
      Write-Step "dependencies -= $LegacyName"
    }
    Save-Json -Path $profileJson -Object $legacyJson
    Write-Step "写入 $profileJson"
  }
}
if (Test-Path -LiteralPath $legacyLink) {
  $legacyItem = Get-Item -LiteralPath $legacyLink -Force
  if ($legacyItem.LinkType -eq 'Junction' -or $legacyItem.LinkType -eq 'SymbolicLink') {
    Write-Step "摘掉旧别名 junction $legacyLink"
    if (-not $DryRun) { cmd /c rmdir "$legacyLink" | Out-Null }
  } else {
    Write-Warning "旧别名位置是真实目录，保留不动（自己确认后手工删）：$legacyLink"
  }
}

# 垫片的目标：profiles 的共享 scope（DSH 官方包 @deepseek-ai/*）。
# 注意：DSH 升级换 runtime 之后这里可能被清空/摘成死链（升级时会清掉指向旧 runtime 的
# junction），那样垫片指向一个空目录，本地跑测试就会 import 不到 @deepseek-ai/*。
# 这不是安装脚本能自己修的（官方包在应用自己的 asar / runtime 里），所以只做检查与提示。
$sharedScope = Join-Path (Join-Path (Join-Path $DshHome 'profiles') 'node_modules') '@deepseek-ai'
$hasSharedScope = Test-Path -LiteralPath $sharedScope
if (-not $hasSharedScope) {
  Write-Warning "找不到 $sharedScope：跳过垫片。插件在 DSH 里照常工作，但本机跑 host/activate 套件会 import 不到 @deepseek-ai/*"
} elseif (@(Get-ChildItem -LiteralPath $sharedScope -Force -ErrorAction SilentlyContinue).Count -eq 0) {
  Write-Warning "$sharedScope 是空目录（DSH 升级后常见）：插件在应用里照常工作，但本机跑 host/activate 套件会 import 不到 @deepseek-ai/*"
}

# 1. 垫片（目标位置会随 DSH 升级变化，所以允许重指）。
#    共享 scope 不存在时不建：Windows 不允许 junction 指向不存在的目标。
if ($hasSharedScope) {
  New-JunctionSafe -Path (Join-Path $pkgRoot 'node_modules\@deepseek-ai') -Target $sharedScope -Repoint | Out-Null
}

# 2. package.json
$raw = Get-Content -LiteralPath $profileJson -Raw
$json = $raw | ConvertFrom-Json
if (-not $json.dsh) { throw "$profileJson 里没有 dsh 字段，可能不是 profile 清单" }
if (-not $json.dsh.profile) { throw "$profileJson 里没有 dsh.profile 字段" }

$linkTarget = 'link:' + ($pkgRoot -replace '\\', '/')
$bundles = @($json.dsh.profile.bundles)
$hasBundle = $bundles -contains $PackageName
$hasDep = $json.dependencies -and ($json.dependencies.PSObject.Properties.Name -contains $PackageName)
# 依赖值也要对：切通道（源码 link: <-> 远程解包目录）时键还在、值却指别处，
# 只查「有没有这个键」会漏掉，结果 junction 与清单各指一边。
$depValue = if ($hasDep) { [string]$json.dependencies.$PackageName } else { '' }
$depWrong = $hasDep -and ($depValue -ne $linkTarget)

if ($hasBundle -and $hasDep -and -not $depWrong) {
  Write-Step "package.json 已经是目标状态（bundles 与 dependencies 都含 $PackageName 且指向 $pkgRoot）"
} else {
  if (-not $DryRun) {
    $backup = Get-BackupPath $profileJson
    Copy-Item -LiteralPath $profileJson -Destination $backup -Force
    Write-Step "备份 -> $(Split-Path -Leaf $backup)"
  } else {
    Write-Step "[dry] 会先备份 package.json"
  }
  if (-not $hasBundle) {
    $json.dsh.profile.bundles = @($bundles + $PackageName)
    Write-Step "bundles += $PackageName"
  }
  if (-not $hasDep -or $depWrong) {
    if (-not $json.dependencies) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
    $json.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $linkTarget -Force
    if ($depWrong) { Write-Step "dependencies.$PackageName : $depValue -> $linkTarget" }
    else { Write-Step "dependencies.$PackageName = $linkTarget" }
  }
  Save-Json -Path $profileJson -Object $json
  Write-Step "写入 $profileJson"
}

# 3. profile junction（源码 link: 与远程解包目录之间切换时重指，只动 junction 本身）
New-JunctionSafe -Path (Join-Path $profileDir "node_modules\$PackageName") -Target $pkgRoot -Repoint | Out-Null

Write-Host ''
if ($DryRun) { Write-Host 'dry run 结束，没有改动任何文件。' }
else {
  $installedVersion = ((Get-Content -LiteralPath (Join-Path $pkgRoot 'package.json') -Raw) | ConvertFrom-Json).version
  Write-Host "装好了（$PackageName@$installedVersion）。重启 DSH 桌面端（profile=$Profile）后：设置 → 记忆。"
  if ($FromNpm -or $FromUrl -or $FromRelease) {
    Write-Host "更新：重跑同一条命令即可，脚本会整体替换 $remoteTarget 里的旧版本（不需要先卸载）。"
  }
  if ($FromRelease) { Write-Host "通道：$Channel（latest 正式版；lab 是已废弃的别名）。" }
  Write-Host "回滚： pwsh -File uninstall.ps1 -Profile $Profile"
}
