!macro customInstallDir
    ; Check if the selected directory has many folders
    StrCpy $R0 $INSTDIR
    StrCpy $R1 0
    
    ${If} ${FileExists} "$R0\*.*"
        ClearErrors
        FindFirst $R2 $R3 "$R0\*.*"
        ${Do}
            ${If} $R3 == ""
                ${Break}
            ${EndIf}
            ${If} $R3 != "."
            ${AndIf} $R3 != ".."
                IntOp $R1 $R1 + 1
            ${EndIf}
            FindNext $R2 $R3
        ${Loop}
        FindClose $R2
        
        ${If} $R1 > 3
            StrCpy $INSTDIR "$R0\Verse"
        ${EndIf}
    ${EndIf}
!macroend

!macro customInit
    ; Set default install dir to include Verse subfolder
    ${If} $INSTDIR == ""
        StrCpy $INSTDIR "$PROGRAMFILES64\Verse"
    ${EndIf}
!macroend

!macro customInstall
    ; Auto-create Verse subfolder if directory has many files
    !insertmacro customInstallDir
!macroend
