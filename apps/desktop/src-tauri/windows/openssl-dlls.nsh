!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\resources\windows\openssl\libcrypto-3-x64.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\resources\windows\openssl\libcrypto-3-x64.dll" "$INSTDIR\libcrypto-3-x64.dll"
  IfFileExists "$INSTDIR\resources\windows\openssl\libssl-3-x64.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\resources\windows\openssl\libssl-3-x64.dll" "$INSTDIR\libssl-3-x64.dll"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\libcrypto-3-x64.dll"
  Delete "$INSTDIR\libssl-3-x64.dll"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$APPDATA\Joyshell"
    RMDir /r "$LOCALAPPDATA\Joyshell"
    RMDir /r "$APPDATA\com.joyshell.desktop"
    RMDir /r "$LOCALAPPDATA\com.joyshell.desktop"
  ${EndIf}
!macroend
