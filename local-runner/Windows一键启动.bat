@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 gpt56_vnext_web.py --port 8756 --no-browser
) else (
  python gpt56_vnext_web.py --port 8756 --no-browser
)
if errorlevel 1 pause
