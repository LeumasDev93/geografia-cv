FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
COPY dados ./dados
RUN npm install --no-audit --no-fund && npm run build

FROM node:22-slim
ENV NODE_ENV=production PORT=4100
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package*.json ./
COPY dados ./dados
RUN npm install --omit=dev --no-audit --no-fund
EXPOSE 4100
CMD ["node", "dist/servidor.js"]
