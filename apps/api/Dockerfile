FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN npm install --workspace apps/api --include-workspace-root --no-audit --no-fund
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
COPY apps/api/scripts apps/api/scripts
RUN npm --workspace apps/api run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN npm install --omit=dev --workspace apps/api --include-workspace-root --no-audit --no-fund && npm cache clean --force
COPY --from=build /workspace/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/src/server.js"]
