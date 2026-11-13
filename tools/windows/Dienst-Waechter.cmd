@echo off
rem Dienst-Waechter starten (fragt nach Administrator-Rechten)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dienst-waechter.ps1"
