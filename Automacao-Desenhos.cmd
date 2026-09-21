@echo off
setlocal EnableExtensions
title Draw2Data - Automacao de desenhos
cd /d "%~dp0"

echo.
echo  DRAW2DATA - ANALISE E REVISAO DE DESENHOS
echo.
set "SOURCE=U:\"
set "OUTPUT=%USERPROFILE%\Documents\Draw2Data-Resultados\pasta-23101f3e"
set /p "SOURCE=Origem dos PDFs [%SOURCE%]: "
if "%SOURCE%"=="" set "SOURCE=U:\"
set /p "OUTPUT=Pasta de resultados [%OUTPUT%]: "
if "%OUTPUT%"=="" set "OUTPUT=%USERPROFILE%\Documents\Draw2Data-Resultados\pasta-23101f3e"

echo.
echo  1. Continuar desenhos ainda nao analisados
echo  2. Auditar resultados sem analisar novamente
echo  3. Revisar desenhos com zero/poucas cotas, falhas ou evidencias pendentes
echo  4. Atualizar todos os desenhos para o motor atual
echo  5. Corrigir perfis importados na base com o motor atual
echo  6. Sincronizar novos resultados seguros com a base
echo.
choice /C 123456 /N /M "Escolha uma opcao"
if errorlevel 6 goto sync
if errorlevel 5 goto revalidate
if errorlevel 4 goto update
if errorlevel 3 goto review
if errorlevel 2 goto audit
goto analyze

:analyze
node draw2data\batch.cjs analisar --source "%SOURCE%" --output "%OUTPUT%"
goto finish

:audit
node draw2data\batch.cjs auditar --source "%SOURCE%" --output "%OUTPUT%"
goto finish

:review
node draw2data\batch.cjs revisar --source "%SOURCE%" --output "%OUTPUT%"
goto finish

:update
node draw2data\batch.cjs atualizar-motor --source "%SOURCE%" --output "%OUTPUT%"
goto finish

:revalidate
node scripts\revalidate-imported-profiles.cjs --checkpoint "%OUTPUT%\checkpoint.json" --commit
goto finish

:sync
node scripts\import-draw2data-profiles.cjs --checkpoint "%OUTPUT%\checkpoint.json" --commit

:finish
echo.
echo Resultado salvo na pasta informada.
pause
