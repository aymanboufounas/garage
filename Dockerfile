FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node web ./web
RUN mkdir -p /app/data /app/web/assets/host-photos && chown -R node:node /app/data /app/web/assets/host-photos
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["node","server/index.mjs"]
