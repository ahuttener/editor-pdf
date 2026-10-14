// Substitui módulos do Node no app (o motor recebe readFile por configuração)
export async function readFile() { throw new Error('sem acesso a arquivos do sistema'); }
export default { readFile };
