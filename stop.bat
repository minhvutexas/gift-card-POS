@echo off
rem Gift Card POS - stops the web app, API and database started by start.bat.
echo Stopping Gift Card POS...
for %%P in (5173 4000) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do taskkill /PID %%I /T /F >nul 2>&1
)
rem Stop Postgres cleanly so no data is lost.
if exist "%~dp0api\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe" (
  "%~dp0api\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe" stop -D "%~dp0api\.pgdata" -m fast >nul 2>&1
)
taskkill /FI "WINDOWTITLE eq GiftCard -*" /T /F >nul 2>&1
echo Done.
timeout /t 2 >nul
