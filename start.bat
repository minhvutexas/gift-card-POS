@echo off
rem Gift Card POS - double-click to start everything and open the app in your browser.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 (
  echo.
  echo Something went wrong - see the message above.
  pause
)
