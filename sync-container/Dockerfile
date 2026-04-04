FROM node:22-alpine

# System deps (matching official CF FUSE example base)
RUN apk add --no-cache fuse3 curl rsync bash

# Install tigrisfs (FUSE adapter for S3-compatible storage like R2)
# Pinned version avoids flaky GitHub API calls during build
ARG TIGRISFS_VERSION=v1.2.1
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then ARCH="amd64"; fi && \
    if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi && \
    curl -L "https://github.com/tigrisdata/tigrisfs/releases/download/${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION#v}_linux_${ARCH}.tar.gz" \
      -o /tmp/tigrisfs.tar.gz && \
    tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ && \
    rm /tmp/tigrisfs.tar.gz && \
    chmod +x /usr/local/bin/tigrisfs

# Install obsidian-headless
RUN npm install -g obsidian-headless

RUN mkdir -p /vault /mnt/r2

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
