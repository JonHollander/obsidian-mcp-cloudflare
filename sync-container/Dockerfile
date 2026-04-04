FROM node:22-slim

RUN mkdir -p /vault /mnt/r2

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 33

ENTRYPOINT ["/entrypoint.sh"]
