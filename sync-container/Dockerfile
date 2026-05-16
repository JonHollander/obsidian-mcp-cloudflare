FROM node:22-alpine

RUN apk add --no-cache curl bash

# Install obsidian-headless (vault sync CLI)
RUN npm install -g obsidian-headless

RUN mkdir -p /vault /app
WORKDIR /app

# Install runtime deps (better-sqlite3 for the optional FTS5 index). The
# prebuilt linux-x64-musl binary is downloaded by npm — no compile toolchain
# required on alpine.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
