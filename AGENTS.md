# SilkWarp 项目协作与自动同步规则

> 本规则作用于 `silkwarp` 仓库根目录及全部子目录；仅规范交付后 Git 同步与隐私安全门禁，涉及代理调度与模型选择时始终遵守全局规范。

## 1. 优化完成后自动同步推送

- 每次完成代码优化、功能开发或缺陷修复，且**本机构建检查与相关自动化测试全部通过**后，必须在同一轮任务收尾阶段自动完成 Git 同步推送：
  1. 暂存变更：`git add` 本次涉及的源码、测试、配置模板与规则文件；
  2. 提交变更：使用清晰的 Conventional Commits 提交信息（例如 `perf(desktop): ...`、`fix(desktop): ...`、`feat(desktop): ...`）；
  3. 推送远端：执行 `git push origin <当前分支>`（默认 `origin main`），确保多台开发/测试设备随时可直接拉取最新代码。
- 若本轮任务仅为纯问答、方案讨论或只读排查（未产生有效文件变更），则不生成空提交。

## 2. 桌面端新版本同步发布 GitHub Release 安装包

- 每当完成桌面端功能开发/性能优化或 `apps/desktop/package.json` 版本号更新，且 `npm run build` 与全部单元测试通过、源码已推送至 `origin main` 后，必须紧接着同步打包并发布对应的 GitHub Release：
  1. **打包安装程序**：在 `apps/desktop` 使用 `electron-builder` 生成 Windows NSIS 安装包 `SilkWarp-Setup-<version>.exe` 及 `SilkWarp-Setup-<version>.exe.blockmap`（若遇 Electron 解压网络卡顿，优先复用本地 `node_modules\electron\dist`）；
  2. **安装包隐私门禁**：检查 `apps/desktop/release/win-unpacked` 及 `apps/desktop/release/win-unpacked/resources`，确认**未打包** `silkwarp.config.json`、`.env*`（`.env.example` 除外）、私钥或个人服务器配置；始终保持 `apps/desktop/release/` 不被纳入 Git 提交；
  3. **发布公开 Release**：计算 `SilkWarp-Setup-<version>.exe` 的 SHA-256 校验值，使用 GitHub CLI（`gh` / `C:\Program Files\GitHub CLI\gh.exe`）创建 `v<version>` Release（标题 `SilkWarp v<version>`，标记 `--latest`），同步上传 `.exe` 与 `.exe.blockmap`，发布脱敏更新说明（严禁出现个人 IP、域名、凭据或私有机名）；
  4. **网络代理兜底**：若 `git push` 或 `gh release create` 直连 GitHub 被重置，自动读取本机 Windows 系统代理完成推送与附件上传。

## 3. 推送前强制隐私与安全门禁

- 远程仓库为公开仓库，推送前**必须逐项核对** `git status` 与 `git diff --cached --name-only`：
  - **严禁提交任何敏感配置、凭据、构建产物或本地导出文件**：包括但不限于 `silkwarp.config.json`、`apps/desktop/silkwarp.config.json`、`.env` / `.env.*`（`.env.example` 除外）、`secrets/`、`*.pem`、`*.key`、`*.crt`、`*.local.json`、`*.xlsx`、`*.docx`、`docs/SilkWarp_*.docx`、`docs/server-evaluation.md`、`apps/desktop/release/`、`apps/desktop/resources/`、`apps/desktop/dist/`、`apps/desktop/dist-electron/`。
  - **严禁硬编码服务器隐私信息**：源码、脚本、注释、测试及规则文件中不得写入个人服务器公网 IP、私人域名、真实管理员账号/密码或密钥；动态地址统一走本地外置配置或环境变量注入。
- 推送冲突处理：若 `git push` 因远端领先被拒绝，先执行 `git pull --rebase origin main` 合并并确认构建测试仍通过后再推送；**严禁使用 `git push --force`**。

## 4. 执行与交付说明

- 若当前终端默认 `PATH` 未包含 `git`，优先检测本机常见 Git 安装路径（如 `C:\Program Files\Git\cmd\git.exe`、`C:\Program Files\WorkBuddy\resources\vendor\PortableGit\cmd\git.exe` 或 Visual Studio 自带 `git.exe`）完成提交与推送。
- 每次推送或发布完成后，必须在最终回复中明确列出已推送的分支、最新 Commit SHA、本次包含的核心变更，以及 GitHub Release 链接、上传资产清单和安装包 SHA-256 校验值。
