FROM node:22-alpine

RUN apk add --no-cache curl bash

# Install obsidian-headless
RUN npm install -g obsidian-headless

RUN mkdir -p /vault

COPY server.js /server.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
