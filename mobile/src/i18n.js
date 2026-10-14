// Português é o texto-fonte; o dicionário traz o inglês. Mesmo esquema do app desktop.
const EN = {
  'Início': 'Home',
  'Arquivos': 'Files',
  'Abrir': 'Open',
  'Ferramentas': 'Tools',
  'Ajustes': 'Settings',
  'Edite, assine e organize seus PDFs': 'Edit, sign and organize your PDFs',
  'Tudo no seu celular, sem enviar seus documentos para a internet.': 'All on your phone, without uploading your documents anywhere.',
  'Abrir PDF': 'Open PDF',
  'Atalhos': 'Shortcuts',
  'Anotar': 'Annotate',
  'Assinar': 'Sign',
  'Juntar PDFs': 'Merge PDFs',
  'Imagens em PDF': 'Images to PDF',
  'Recentes': 'Recent',
  'ver todos': 'see all',
  'Nenhum PDF por aqui ainda': 'No PDFs here yet',
  'Abra um PDF do celular para editar, assinar ou organizar as páginas.': 'Open a PDF from your phone to edit, sign or organize its pages.',
  'Seus arquivos': 'Your files',
  'Os PDFs que você salvar no app ficam aqui.': 'PDFs you save in the app live here.',
  'Compartilhar': 'Share',
  'Excluir': 'Delete',
  'Renomear': 'Rename',
  'Cancelar': 'Cancel',
  'Salvar': 'Save',
  'Salvo': 'Saved',
  'OK': 'OK',
  'hoje': 'today',
  'ontem': 'yesterday',
  '{n} páginas': '{n} pages',
  '1 página': '1 page',
  'Junte vários PDFs em um só, na ordem que quiser.': 'Combine several PDFs into one, in any order.',
  'Transforme fotos e imagens em um PDF.': 'Turn photos and images into a PDF.',
  'Organizar páginas': 'Organize pages',
  'Gire, exclua, reordene e adicione páginas.': 'Rotate, delete, reorder and add pages.',
  'Assinar documento': 'Sign document',
  'Desenhe sua assinatura e coloque no PDF.': 'Draw your signature and place it on the PDF.',
  'Anotar e marcar': 'Annotate and mark up',
  'Texto, marca-texto, caneta e tarja para cobrir.': 'Text, highlighter, pen and cover-up box.',
  'Em breve': 'Coming soon',
  'Comprimir PDF': 'Compress PDF',
  'Reconhecer texto (OCR)': 'Recognize text (OCR)',
  'Converter para Word': 'Convert to Word',
  'Idioma': 'Language',
  'Assinatura salva': 'Saved signature',
  'Apagar assinatura salva': 'Delete saved signature',
  'Nenhuma assinatura salva': 'No saved signature',
  'Sobre': 'About',
  'por CyberSecInfo — Information Security': 'by CyberSecInfo — Information Security',
  'Versão {v}': 'Version {v}',
  'Seus documentos não saem do aparelho.': 'Your documents never leave the device.',
  'Páginas': 'Pages',
  'Selecionar': 'Select',
  'Texto': 'Text',
  'Marca-texto': 'Highlight',
  'Caneta': 'Pen',
  'Cobrir': 'Cover',
  'Imagem': 'Image',
  'Cor': 'Color',
  'Assinatura': 'Signature',
  'Data': 'Date',
  'Marcar X': 'Mark X',
  'Duplicar': 'Duplicate',
  'Girar': 'Rotate',
  'Adicionar PDF': 'Add PDF',
  'Adicionar imagem': 'Add image',
  'Toque na página para escrever': 'Tap the page to type',
  'Arraste sobre o texto para marcar': 'Drag over the text to highlight',
  'Desenhe com o dedo': 'Draw with your finger',
  'Arraste para cobrir uma área': 'Drag to cover an area',
  'Toque onde quer colocar': 'Tap where you want to place it',
  'Digite aqui': 'Type here',
  'Desenhe sua assinatura': 'Draw your signature',
  'Limpar': 'Clear',
  'Usar assinatura': 'Use signature',
  'Nova assinatura': 'New signature',
  'Salvando…': 'Saving…',
  'Abrindo…': 'Opening…',
  'Não foi possível abrir este arquivo.': 'This file could not be opened.',
  'Este PDF tem senha. Abra-o no computador para remover a senha.': 'This PDF is password-protected. Remove the password on a computer first.',
  'Salvo na sua biblioteca': 'Saved to your library',
  'Use Compartilhar para mandar por WhatsApp, e-mail ou salvar em outra pasta.': 'Use Share to send it by WhatsApp or email, or save it to another folder.',
  'Descartar alterações?': 'Discard changes?',
  'Você tem alterações que ainda não foram salvas.': 'You have changes that have not been saved yet.',
  'Descartar': 'Discard',
  'Continuar editando': 'Keep editing',
  'Excluir este arquivo?': 'Delete this file?',
  'Ele será apagado do app. Esta ação não pode ser desfeita.': 'It will be removed from the app. This cannot be undone.',
  'Excluir esta página?': 'Delete this page?',
  'O documento precisa ter ao menos uma página.': 'The document must have at least one page.',
  'Escolha ao menos dois PDFs.': 'Choose at least two PDFs.',
  'Juntando…': 'Merging…',
  'Criando PDF…': 'Creating PDF…',
  'Página {n}': 'Page {n}',
  'Nome do arquivo': 'File name',
  'Desfazer': 'Undo',
  'Refazer': 'Redo',
  'Voltar': 'Back',
  'Mais opções': 'More options',
  'Tamanho': 'Size',
  'Mover para a esquerda': 'Move left',
  'Mover para a direita': 'Move right',
  'Fechar': 'Close',
};

const STORE_KEY = 'editorpdf.idioma';
let lang = (() => {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'pt' || saved === 'en') return saved;
  } catch {}
  return /^pt/i.test(navigator.language || '') ? 'pt' : 'en';
})();

export const getLang = () => lang;

export function t(text, vars) {
  let out = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, text) ? EN[text] : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'pt';
  try { localStorage.setItem(STORE_KEY, lang); } catch {}
  document.documentElement.lang = lang === 'en' ? 'en' : 'pt-BR';
}

export const missingTranslations = (list) => list.filter((s) => !Object.prototype.hasOwnProperty.call(EN, s));
