# kiji-server

Puerta y relay de la app móvil de Kiji Office (contrato en `PLAN-movil.md`, sección 7). Node >= 22.18, TypeScript
ejecutado directamente (sin compilar). El relay no descifra ni registra el contenido de los mensajes.

## Variables

Comunes: `MODE=gateway|relay`, `PORT` (8080), `PASS_SECRET` (>= 32 caracteres, igual en puerta y relays).

**Puerta (`MODE=gateway`)**
- `GOOGLE_CLIENT_IDS`: client IDs de Google separados por comas (`aud` válido).
- `ALLOWED_EMAILS`: correos permitidos, separados por comas.
- `PROVISIONER=static|coolify`; con `static`, `RELAY_URL` (p. ej. `ws://127.0.0.1:8081/ws`).
- Con `coolify`: `COOLIFY_URL`, `COOLIFY_TOKEN`, `COOLIFY_PROJECT_UUID`, `COOLIFY_SERVER_UUID`,
  `COOLIFY_ENVIRONMENT` (production), `RELAY_IMAGE` (`imagen:tag`), `RELAY_DOMAIN_TEMPLATE` (`https://kiji-{id}.midominio.com`).
- `DATA_DIR`: carpeta de `gateway.db` (./data). Debe ser un volumen persistente.
- `DEV_INSECURE_TOKENS=1`: acepta `idToken = "dev:<correo>"`. Prohibido con `NODE_ENV=production`.

**Relay (`MODE=relay`)**:
- **Relay de un usuario** (lo crea la puerta): `RELAY_KEY` (su clave derivada) y `OWNER_SUB`.
- **Relay compartido** (desarrollo o self-host): `PASS_SECRET`, del que deriva la clave de cada usuario.
- `FCM_SERVICE_ACCOUNT` (JSON). Sin él, el push solo se registra en el log.

## Local

```sh
npm install                      # desde la raíz del repo
cd server
PASS_SECRET=local-local-local-local-local-local-12 MODE=relay PORT=8081 node src/main.ts
# en otra terminal
DEV_INSECURE_TOKENS=1 ALLOWED_EMAILS=yo@example.com PROVISIONER=static RELAY_URL=ws://127.0.0.1:8081/ws \
  PASS_SECRET=local-local-local-local-local-local-12 MODE=gateway node src/main.ts
curl -s localhost:8080/session -H 'content-type: application/json' -d '{"idToken":"dev:yo@example.com","device":"mac"}'
```

Pruebas: `npx vitest run server` (o `npm test` en la raíz). Tipos: `npm run typecheck -w server`.

## Despliegue en Coolify

1. Construye la imagen desde la raíz del repo: `docker build -f server/Dockerfile -t <registro>/kiji-server:<tag> .` y súbela.
2. Puerta: aplicación Docker image con `MODE=gateway`, `PROVISIONER=coolify`, el resto de variables de arriba, un
   volumen en `/data` y el dominio público. El token de Coolify necesita permiso de escritura y despliegue.
3. Los relays los crea la puerta: uno por usuario, con `OWNER_SUB` y su `RELAY_KEY`. `PASS_SECRET` nunca sale de la
   puerta. La imagen arranca como relay por defecto.
4. El dominio comodín de `RELAY_DOMAIN_TEMPLATE` debe apuntar al servidor de Coolify.
