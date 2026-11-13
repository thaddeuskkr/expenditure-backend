FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8091

WORKDIR /app
COPY --chown=node:node apns.mjs configuration.mjs healthcheck.mjs server.mjs ./

USER node
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["node", "server.mjs"]
