# One image for all the Node services; docker-compose.yml picks the entry point.
FROM node:22.17.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.17.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The pager keeps its log in /data. Creating it here, owned by node, means a
# new named volume mounted there is writable by the non-root user.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/ingest/main.js"]
