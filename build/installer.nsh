; CodePad installer hooks (electron-builder NSIS, nsis.include).
; 1. Before any file is written: check that the AI model download server can be reached (INetC HEAD probe).
;    The probe is advisory only: when it fails the installer warns, skips the model download and carries on.
; 2. After the files are extracted: CodePad.exe --install-model downloads the model as the real (non-elevated) user.
; The app's own downloader does the work (resume, host allow-list, SHA-256 check); NSIS only probes the network.
; Exit codes of --install-model: 0 ready, 2 cancelled, 3 offline, 4 integrity, 5 disk space, 6 locked, 1 other.
; Installer error levels (silent installs): 6 model failed and install aborted, 7 installed but the model is missing.
; An offline install finishes normally; CodePad downloads the model on first start.
; The install is per-user only (package.json nsis.perMachine=false, allowElevation=false), see SECURITY.md.

!include LogicLib.nsh

; electron-builder compiles this file twice (installer and uninstaller) with -WX (warnings are errors), so
; anything only the installer references must not exist in the uninstaller pass (unused Var/Function warn).
!ifndef BUILD_UNINSTALLER

Var cpOffline

!define CP_PROBE1 "https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa"
!define CP_PROBE2 "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf"

; Runs in .onInit after initMultiUser and before any file is written.
!macro customInit
  StrCpy $cpOffline "0"
  ${IfNot} ${UAC_IsInnerInstance}
    InitPluginsDir
    inetc::head /SILENT /CONNECTTIMEOUT 15 /RECEIVETIMEOUT 20 "${CP_PROBE1}" "$PLUGINSDIR\cp-net.txt" /END
    Pop $0
    ${If} $0 != "OK"
      inetc::head /SILENT /CONNECTTIMEOUT 15 /RECEIVETIMEOUT 20 "${CP_PROBE2}" "$PLUGINSDIR\cp-net.txt" /END
      Pop $0
    ${EndIf}
    ${If} $0 != "OK"
      StrCpy $cpOffline "1"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "The AI model download server could not be reached ($0).$\r$\n$\r$\nCodePad will be installed without the AI model and downloads it on first start once you are online."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Runs as the real user so the model lands in that user's profile (also for per-machine installs).
; This file is included before electron-builder's common.nsh, so APP_EXECUTABLE_FILENAME (defined there as
; "${PRODUCT_FILENAME}.exe") does not exist yet when a Function body is compiled; use the command-line define.
Function cpRunModelInstall
  ${If} ${Silent}
    ExecWait '"$INSTDIR\${PRODUCT_FILENAME}.exe" --install-model --silent' $0
  ${Else}
    ExecWait '"$INSTDIR\${PRODUCT_FILENAME}.exe" --install-model' $0
  ${EndIf}
FunctionEnd

; Runs in the install section after the files are extracted.
!macro customInstall
  ${If} $cpOffline == "1"
    Goto cp_model_done
  ${EndIf}
  cp_model_retry:
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function cpRunModelInstall ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
  ${Else}
    Call cpRunModelInstall
  ${EndIf}
  ${If} $0 != 0
    ${If} ${Silent}
      SetErrorLevel 7
    ${Else}
      MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION "The AI model could not be downloaded (code $0).$\r$\n$\r$\nRetry: try again.$\r$\nIgnore: finish without AI (CodePad downloads it on first start).$\r$\nAbort: cancel the installation." IDRETRY cp_model_retry IDIGNORE cp_model_done
      ExecWait '"$INSTDIR\${UNINSTALL_FILENAME}" /S _?=$INSTDIR'
      Delete "$INSTDIR\${UNINSTALL_FILENAME}"
      RMDir "$INSTDIR"
      SetErrorLevel 6
      Quit
    ${EndIf}
  ${EndIf}
  cp_model_done:
!macroend

!endif ; BUILD_UNINSTALLER

; Settings and sessions are kept on uninstall as before; only the large model file is removed.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    RMDir /r "$APPDATA\${PRODUCT_NAME}\models"
  ${EndIf}
!macroend
