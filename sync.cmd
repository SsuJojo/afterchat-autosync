@echo off
rem sync.cmd - chat2deja pipeline: scan Downloads/_inbox for new exports, convert, then deja index
setlocal
set "BASE=C:\Users\SsuJo_\Documents\GitHub\afterchat-autosync"
set "PY=C:\Users\SsuJo_\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
set "DEJA_AMP_ROOT=%BASE%\amp-threads"
set "DEJA_GEMINI_ROOT=%BASE%\gemini-home"
set "DEJA_GROK_ROOT=%BASE%\grok-home"
set "LOG=%BASE%\_state\sync.log"

echo ============================================================ >> "%LOG%"
echo [%date% %time%] sync start >> "%LOG%"

if not exist "%PY%" set "PY=python"

"%PY%" "%BASE%\chat2deja.py" >> "%LOG%" 2>&1

where deja >nul 2>&1
if %errorlevel%==0 (
    deja index >> "%LOG%" 2>&1
) else (
    echo [warn] deja not on PATH in this environment ^>^> "%LOG%"
)

rem keep only the last 400 lines of the log
powershell -NoProfile -Command "$p='%LOG%'; $t=Get-Content $p; if($t.Count -gt 400){ $t[-400..-1] | Set-Content -Encoding utf8 $p }" >nul 2>&1

echo [%date% %time%] sync done >> "%LOG%"
endlocal
