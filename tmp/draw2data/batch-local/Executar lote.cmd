@echo off
setlocal
cd /d "%~dp0..\..\.."
"C:\Program Files\nodejs\node.exe" "%~dp0analisar-lote.cjs" --from-scratch=true
echo.
pause

