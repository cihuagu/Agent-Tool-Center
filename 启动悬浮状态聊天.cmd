@echo off
setlocal DisableDelayedExpansion
for /f "tokens=2 delims=:" %%C in ('chcp') do set "ATC_PREVIOUS_CP=%%C"
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 (
  chcp %ATC_PREVIOUS_CP% >nul
  exit /b 1
)
call "%~dp0启动能力选择聊天.cmd" -c "mcp_servers.capability_advisor.env.ATC_STATUS_WINDOW='1'" %*
set "ATC_EXIT_CODE=%errorlevel%"
chcp %ATC_PREVIOUS_CP% >nul
exit /b %ATC_EXIT_CODE%
