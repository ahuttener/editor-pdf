; Tela de boas-vindas com o emblema da CyberSecInfo na lateral (português e inglês)
LangString EdpWelcomeTitle 1046 "Bem-vindo ao Editor PDF"
LangString EdpWelcomeTitle 1033 "Welcome to Editor PDF"
LangString EdpWelcomeText 1046 "Este assistente vai instalar o Editor PDF no seu computador.$\r$\n$\r$\nEdite o texto de PDFs, assine, comente, organize páginas, converta para Word, comprima, proteja com senha e reconheça texto de documentos escaneados.$\r$\n$\r$\nCyberSecInfo — Information Security$\r$\ncybersecinfo.com  ·  @cybersecinfo$\r$\n$\r$\nClique em Próximo para continuar."
LangString EdpWelcomeText 1033 "This wizard will install Editor PDF on your computer.$\r$\n$\r$\nEdit PDF text, sign, comment, organize pages, convert to Word, compress, password-protect and recognize text in scanned documents.$\r$\n$\r$\nCyberSecInfo — Information Security$\r$\ncybersecinfo.com  ·  @cybersecinfo$\r$\n$\r$\nClick Next to continue."

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(EdpWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(EdpWelcomeText)"
  !insertmacro MUI_PAGE_WELCOME
!macroend
