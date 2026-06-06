; ============================================================
; VersePC Installer - Modern MUI2 Customization
; ============================================================

; Show file extraction details during install/uninstall
ShowInstDetails show
ShowUninstDetails show

; --- Modern UI Settings (use /ifndef to avoid conflicts) ---
!define /ifndef MUI_WELCOMEPAGE_TITLE "欢迎安装 VersePC"
!define /ifndef MUI_WELCOMEPAGE_TEXT "VersePC 是一款新一代 Minecraft 启动器，集成 AI 助手、版本管理、模组下载等功能。$\r$\n$\r$\n点击 [下一步] 开始安装。"

!define /ifndef MUI_FINISHPAGE_TITLE "VersePC 安装完成"
!define /ifndef MUI_FINISHPAGE_TEXT "VersePC 已成功安装到你的电脑。$\r$\n$\r$\n安装大小约 524 MB$\r$\n$\r$\n点击 [完成] 关闭安装向导。"

!define /ifndef MUI_DIRECTORYPAGE_TEXT_TOP "选择 VersePC 的安装目录。建议安装在非系统盘以获得更好的性能。$\r$\n$\r$\n安装后占用约 524 MB 磁盘空间。"

!define /ifndef MUI_STARTMENUPAGE_DEFAULTFOLDER "VersePC"
!define /ifndef MUI_STARTMENUPAGE_TEXT_TOP "选择 VersePC 的开始菜单文件夹。"

!define /ifndef MUI_ABORTWARNING

; --- Custom Install Directory ---
!macro customInstallDir
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
    ${If} $INSTDIR == ""
        StrCpy $INSTDIR "$PROGRAMFILES64\Verse"
    ${EndIf}
    SetDetailsView show
    SetDetailsPrint textonly
    SetAutoClose false
!macroend

!macro customInstall
    !insertmacro customInstallDir
!macroend

; --- Uninstall: no extra prompt, NSIS default handles it ---
!macro customUnInit
    ; No extra confirmation - NSIS already shows a standard uninstall page
!macroend