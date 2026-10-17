@echo off
title Iniciar Chrome para Gemini Argon MCP
echo ========================================================
echo  Iniciando Google Chrome (Perfil Gemini Argon) Puerto 9222
echo ========================================================
echo.

:: Verificar si Chrome ya esta en ejecucion en el puerto 9222
powershell -Command "try { $v = (Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 1); if ($v) { exit 0 } } catch { exit 1 }"
if %ERRORLEVEL% EQU 0 (
    echo [OK] Chrome ya esta escuchando en el puerto 9222.
    start "" "https://gemini.google.com/app"
    goto fin
)

echo Lanzando Google Chrome con perfil dedicado y depuracion remota...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="%LOCALAPPDATA%\Google\Chrome\GeminiProfile" "https://gemini.google.com/app"

echo Esperando confirmacion del puerto 9222...
powershell -Command "for ($i=0; $i -lt 15; $i++) { try { $v = (Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 1); if ($v) { Write-Host '[EXITO] Puerto 9222 activo y conectado a Chrome!' -ForegroundColor Green; exit 0 } } catch { Start-Sleep -Milliseconds 500 } }; Write-Host '[AVISO] Revisa la ventana de Chrome abierta.' -ForegroundColor Yellow"

:fin
echo.
echo ========================================================
echo  Instrucciones:
echo  1. Si es la primera vez, inicia sesion con tu cuenta
echo     de Google en la ventana de Chrome que se abrio.
echo  2. Deja esa ventana de Chrome abierta.
echo ========================================================
echo.
echo Presiona una tecla para continuar...
pause >nul
