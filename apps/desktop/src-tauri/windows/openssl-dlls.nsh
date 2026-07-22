!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\resources\windows\openssl\libcrypto-3-x64.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\resources\windows\openssl\libcrypto-3-x64.dll" "$INSTDIR\libcrypto-3-x64.dll"
  IfFileExists "$INSTDIR\resources\windows\openssl\libssl-3-x64.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\resources\windows\openssl\libssl-3-x64.dll" "$INSTDIR\libssl-3-x64.dll"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  MessageBox MB_ICONQUESTION|MB_YESNO "是否同时删除 Joyshell 本地数据？$\r$\n$\r$\n这会删除本机 SQLite 数据库、服务器列表、加密保存的密码、命令库和布局设置。选择“否”会保留数据，方便后续重新安装或升级。" IDNO keep_joyshell_user_data
    RMDir /r "$APPDATA\dev.joyshell.desktop"
    RMDir /r "$LOCALAPPDATA\dev.joyshell.desktop"
    RMDir /r "$APPDATA\Joyshell"
    RMDir /r "$LOCALAPPDATA\Joyshell"
    RMDir /r "$APPDATA\com.joyshell.desktop"
    RMDir /r "$LOCALAPPDATA\com.joyshell.desktop"
  keep_joyshell_user_data:
  Delete "$INSTDIR\libcrypto-3-x64.dll"
  Delete "$INSTDIR\libssl-3-x64.dll"
!macroend
