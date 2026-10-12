; Remove only this application's cached installer, retaining unrelated user data.
; Match the desktop policy: every Chinese UI locale uses Simplified Chinese.
!macro selectSystemLanguage
  System::Call 'kernel32::GetUserDefaultUILanguage() i.r0'
  IntOp $0 $0 & 0x3ff
  StrCpy $LANGUAGE 1033
  ${If} $0 = 4
    StrCpy $LANGUAGE 2052
  ${EndIf}
!macroend

!macro customInit
  !insertmacro selectSystemLanguage
!macroend

!macro customUnInit
  !insertmacro selectSystemLanguage
!macroend

!macro customUnInstall
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\multiplane-desktop-updater"
!macroend
