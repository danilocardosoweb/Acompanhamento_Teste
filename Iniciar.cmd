@echo off
cd /d "%~dp0"
start "Painel de Qualidade" /min "C:\Program Files\nodejs\node.exe" "%~dp0server.cjs"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4317"
