@echo off
rem 一键启动博客两个本地服务:预览(4321) + 推送控制台(4399)
start "blog-dev" cmd /c "cd /d %~dp0.. && pnpm dev"
start "blog-push-ui" cmd /c "cd /d %~dp0.. && node tools/push-ui.mjs"
