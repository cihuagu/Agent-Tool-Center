@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 exit /b 1
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found in PATH. Use the configured developer terminal.
  exit /b 1
)
where codex.cmd >nul 2>&1
if errorlevel 1 (
  echo Codex Windows wrapper codex.cmd was not found in PATH.
  exit /b 1
)
call codex.cmd -c "mcp_servers.capability_advisor.command='node'" -c "mcp_servers.capability_advisor.args=['%~dp0src\capability-mcp.mjs']" -c "mcp_servers.capability_advisor.enabled=true" -c "mcp_servers.capability_advisor.enabled_tools=['compare_capabilities','select_capability','report_capability_use','list_capabilities','refresh_capabilities','report_task_status']" -c "mcp_servers.capability_advisor.tools.compare_capabilities.approval_mode='approve'" -c "mcp_servers.capability_advisor.tools.select_capability.approval_mode='approve'" -c "mcp_servers.capability_advisor.tools.report_capability_use.approval_mode='approve'" -c "mcp_servers.capability_advisor.tools.list_capabilities.approval_mode='approve'" -c "mcp_servers.capability_advisor.tools.refresh_capabilities.approval_mode='approve'" -c "mcp_servers.capability_advisor.tools.report_task_status.approval_mode='approve'" %*
exit /b %errorlevel%
