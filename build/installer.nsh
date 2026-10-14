; Tela de boas-vindas com o emblema da CyberSecInfo na lateral (português e inglês)
LangString EdpWelcomeTitle 1046 "Bem-vindo ao Editor PDF"
LangString EdpWelcomeTitle 1033 "Welcome to Editor PDF"
LangString EdpWelcomeText 1046 "Este assistente vai instalar o Editor PDF no seu computador.$\r$\n$\r$\nEdite o texto de PDFs, assine, comente, organize páginas, converta para Word, comprima, proteja com senha e reconheça texto de documentos escaneados.$\r$\n$\r$\nCyberSecInfo — Information Security"
LangString EdpWelcomeText 1033 "This wizard will install Editor PDF on your computer.$\r$\n$\r$\nEdit PDF text, sign, comment, organize pages, convert to Word, compress, password-protect and recognize text in scanned documents.$\r$\n$\r$\nCyberSecInfo — Information Security"
LangString EdpWelcomeNext 1046 "Clique em Próximo para continuar."
LangString EdpWelcomeNext 1033 "Click Next to continue."

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(EdpWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(EdpWelcomeText)"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW EdpWelcomeShow
  !insertmacro MUI_PAGE_WELCOME

; Site e Instagram clicáveis (abrem no navegador)
Function EdpWelcomeShow
  ; O texto do MUI ocupa até o rodapé; encurta para caber os links embaixo
  ShowWindow $mui.WelcomePage.Text ${SW_HIDE}
  ${NSD_CreateLabel} 120u 45u 195u 58u "$(EdpWelcomeText)"
  Pop $0
  SetCtlColors $0 "" "FFFFFF"

  ${NSD_CreateLink} 120u 103u 62u 10u "cybersecinfo.com"
  Pop $0
  SetCtlColors $0 "1F5EFF" "FFFFFF"
  ${NSD_OnClick} $0 EdpOpenSite

  ${NSD_CreateLabel} 183u 103u 8u 10u "·"
  Pop $0
  SetCtlColors $0 "" "FFFFFF"

  ${NSD_CreateLink} 192u 103u 70u 10u "@cyber_secinfo"
  Pop $0
  SetCtlColors $0 "1F5EFF" "FFFFFF"
  ${NSD_OnClick} $0 EdpOpenInstagram

  ${NSD_CreateLabel} 120u 121u 195u 10u "$(EdpWelcomeNext)"
  Pop $0
  SetCtlColors $0 "" "FFFFFF"
FunctionEnd

Function EdpOpenSite
  Pop $0
  ExecShell "open" "https://cybersecinfo.com/"
FunctionEnd

Function EdpOpenInstagram
  Pop $0
  ExecShell "open" "https://www.instagram.com/cyber_secinfo/"
FunctionEnd
!macroend
