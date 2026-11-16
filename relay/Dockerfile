FROM node:24-alpine
WORKDIR /app
COPY package.json server.ts ./
ENV PORT=25565 DATA_DIR=/data
VOLUME /data
EXPOSE 25565
USER node
CMD ["node", "server.ts"]
