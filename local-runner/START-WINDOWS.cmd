@echo off
setlocal
cd /d "%~dp0"
set "PYTHONPATH=%~dp0src;%PYTHONPATH%"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m model_observatory_runner serve
) else (
  python -m model_observatory_runner serve
)
if errorlevel 1 (
  echo.
  echo Python 3.10 or newer is required.
  pause
)
