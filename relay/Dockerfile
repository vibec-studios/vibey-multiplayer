FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV PORT=25565 DATA_DIR=/data
VOLUME /data
EXPOSE 25565 24454/udp 19200-19299/udp
USER node
CMD ["node", "src/main.ts"]
