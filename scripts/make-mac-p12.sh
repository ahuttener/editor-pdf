#!/usr/bin/env bash
# Junta o certificado Developer ID (.cer da Apple) com a chave privada num .p12 para o GitHub Actions.
# Uso: bash scripts/make-mac-p12.sh "<pasta com developer-id.cer e developer-id.key>"
set -euo pipefail
DIR="$1"
openssl x509 -inform DER -in "$DIR/developer-id.cer" -out "$DIR/developer-id.pem"
PASS="$(openssl rand -base64 24 | tr -d '/+=')"
openssl pkcs12 -export -legacy -inkey "$DIR/developer-id.key" -in "$DIR/developer-id.pem" -out "$DIR/developer-id.p12" -passout "pass:$PASS" -name "Developer ID Application"
printf '%s' "$PASS" > "$DIR/developer-id.p12.senha.txt"
base64 -w0 "$DIR/developer-id.p12" > "$DIR/developer-id.p12.base64.txt"
echo "Pronto: developer-id.p12, a senha e o base64 estão em $DIR"
