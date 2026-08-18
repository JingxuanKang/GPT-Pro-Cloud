FROM node:22-alpine
WORKDIR /app
COPY gateway/package.json ./gateway/package.json
RUN cd gateway && npm install --omit=dev
COPY lib ./lib
COPY gateway/server.mjs ./gateway/server.mjs
COPY gateway/web ./gateway/web
WORKDIR /app/gateway
EXPOSE 8080
CMD ["node", "server.mjs"]
