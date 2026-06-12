# Aptible builds from this Dockerfile on `git push aptible main`.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Aptible routes to the container PORT; default 3000 (overridable via env).
EXPOSE 3000
CMD ["node", "dist/index.js"]
