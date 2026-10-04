# worthmyfee.com on Cloud Run (service worthmyfee-site); docs/cloud-run.md.
# Build context = the repo root. .dockerignore trims it to the served files
# plus server/ (minus node_modules).

# Stage 1: the site files. server/ is in the context for stage 2, so it is
# removed here rather than in .dockerignore.
FROM node:22.12-slim AS site
COPY . /site
RUN rm -rf /site/server

# Stage 2: the server, then the site from stage 1. The npm layer comes first
# so a content-only push reuses it.
FROM node:22.12-slim
WORKDIR /app
ENV NODE_ENV=production SITE_DIR=/site
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=site /site /site
EXPOSE 8080
# Never root at runtime; the image is read-only for the server.
USER node
CMD ["node", "server.mjs"]
