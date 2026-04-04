FROM node:22-slim

RUN apt-get update && apt-get install -y \
    fuse3 curl rsync bash \
    && rm -rf /var/lib/apt/lists/*

# Install tigrisfs (FUSE adapter for S3-compatible storage like R2)
RUN ARCH=$(dpkg --print-architecture) && \
    VERSION=$(curl -s https://api.github.com/repos/tigrisdata/tigrisfs/releases/latest \
      | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) && \
    curl -L "https://github.com/tigrisdata/tigrisfs/releases/download/${VERSION}/tigrisfs_${VERSION#v}_linux_${ARCH}.tar.gz" \
      -o /tmp/tigrisfs.tar.gz && \
    tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ && \
    rm /tmp/tigrisfs.tar.gz

# Install obsidian-headless
RUN npm install -g obsidian-headless

RUN mkdir -p /vault /mnt/r2

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
