FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node *.mjs ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node public ./public
COPY --chown=node:node tools ./tools
RUN mkdir /data && chown node:node /data
USER node
ENV OFFICIAL_HOST=0.0.0.0 OFFICIAL_PORT=47830 OFFICIAL_DATA_DIR=/data GUACD_HOST=guacd
EXPOSE 47830
CMD ["node", "server.mjs"]
