@echo off
title SahabatAI Billing - Public Tunnel
echo Membuat tunnel publik ke http://localhost:3400 ...
echo (Pastikan server sudah jalan lebih dulu: start.bat)
echo.
echo URL publik akan muncul di bawah, contoh: https://xxxxx.trycloudflare.com
echo Tekan CTRL+C untuk menghentikan tunnel.
echo.
"%~dp0cloudflared.exe" tunnel --url http://localhost:3400
pause
