!macro customInstall
  CreateDirectory "$INSTDIR\resources\moonlight\Moonlight Game Streaming Project"
  nsExec::ExecToLog 'icacls "$INSTDIR\resources\moonlight\Moonlight Game Streaming Project" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
!macroend
