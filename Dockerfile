FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["npm", "start"]
