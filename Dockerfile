FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY angular.json tsconfig.*.json ./
COPY server ./server
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/albaintor/network-sync" \
      org.opencontainers.image.description="Multi-source NAS folder sync with Angular UI"
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/server.js"]
