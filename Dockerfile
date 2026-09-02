# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS frontend-build

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# The frontend imports the backend's server message catalog and per-locale
# JSON through the @server-i18n path alias (frontend/tsconfig.json and
# vite.config.ts), which points at ../backend/src/i18n relative to the
# frontend. Without this copy the container build fails with TS2307.
COPY backend/src/i18n /build/backend/src/i18n
RUN npm run build


FROM node:20-bookworm-slim AS backend-build

WORKDIR /build/backend

COPY backend/package.json backend/package-lock.json backend/.npmrc ./
RUN npm ci

COPY backend/ ./
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN npx prisma generate
RUN npm run build


FROM node:20-bookworm-slim AS backend

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app/backend

# Keep the generated Prisma client and CLI together with the compiled custom
# migrations. The deploy job runs `npm run db:upgrade` as a one-shot container
# before starting the long-lived backend service.
COPY --from=backend-build /build/backend/package.json ./package.json
COPY --from=backend-build /build/backend/node_modules ./node_modules
COPY --from=backend-build /build/backend/dist ./dist
COPY --from=backend-build /build/backend/assets ./dist/assets
COPY --from=backend-build /build/backend/prisma ./prisma
COPY --from=backend-build /build/backend/scripts/db-upgrade.mjs ./scripts/db-upgrade.mjs

EXPOSE 18085

CMD ["node", "dist/src/server.js"]


FROM nginx:1.27-alpine AS frontend

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /build/frontend/dist /usr/share/nginx/html

EXPOSE 8084
