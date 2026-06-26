@echo off
REM Daily data-refresh wrapper for Windows Task Scheduler.
REM cd into this script's own folder (handles the space in the project path),
REM run the orchestrator, and append everything to refresh.log.
cd /d "%~dp0"
echo. >> refresh.log
echo ===== %DATE% %TIME% ===== >> refresh.log
python refresh_data.py >> refresh.log 2>&1
