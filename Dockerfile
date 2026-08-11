FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend
COPY frontend ./frontend
COPY docs ./docs
RUN npm run build --prefix frontend

FROM node:22-bookworm-slim AS backend-build
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    APP_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    ENABLE_API_DOCS=false \
    FRONTEND_DIST_DIR=/app/public
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=backend-build /build/backend/dist ./dist
COPY backend/migrations ./migrations
COPY scoring-releases/gpt56-v4 /app/scoring-releases/gpt56-v4
COPY registry /app/registry
COPY --from=frontend-build /build/frontend/dist /app/public
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
