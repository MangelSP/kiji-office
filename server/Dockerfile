# Imagen única para la puerta (MODE=gateway) y el relay (MODE=relay, por defecto). Contexto de build: la raíz del repo.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
# Solo el workspace del servidor, sin dependencias de desarrollo.
RUN npm ci --omit=dev -w server --ignore-scripts
COPY server/src server/src
ENV NODE_ENV=production MODE=relay PORT=8080 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
WORKDIR /app/server
CMD ["node", "src/main.ts"]
