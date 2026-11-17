FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV PORT=25565 DATA_DIR=/data
VOLUME /data
EXPOSE 25565
USER node
CMD ["node", "src/main.ts"]
