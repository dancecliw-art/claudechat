@echo off
rem Starts ClaudeChat in its own app window. Closing the window stops the server.
cd /d "%~dp0"
set CLAUDECHAT_APP=1
start "ClaudeChat server" /min node server.js
