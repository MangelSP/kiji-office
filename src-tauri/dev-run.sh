#!/bin/sh
# Firma el binario de desarrollo con una identidad estable antes de ejecutarlo.
# Sin esto la firma es ad hoc y cambia en cada compilación: macOS la trata como otra app y vuelve a pedir la
# contraseña del llavero. Identidad: $KIJI_DEV_SIGN o el primer certificado "Apple Development" válido.
# ponytail: si no hay certificado se ejecuta sin firmar (el llavero seguirá preguntando tras cada build).
id="${KIJI_DEV_SIGN:-$(security find-identity -v -p codesigning 2>/dev/null | grep -v REVOKED | sed -n 's/.*\([0-9A-F]\{40\}\) "Apple Development.*/\1/p' | head -1)}"
if [ -n "$id" ]; then
  codesign -f -s "$id" -i com.kiji.office --entitlements "$(dirname "$0")/Entitlements.plist" "$1" 2>/dev/null \
    || echo "[dev-run] no se pudo firmar; el llavero volverá a preguntar" >&2
fi
exec "$@"
