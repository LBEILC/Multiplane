; Remove only this application's cached installer, retaining unrelated user data.
!macro customUnInstall
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\multiplane-desktop-updater"
!macroend
