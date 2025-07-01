FROM node:18-alpine
WORKDIR /app
COPY package.json ./
# statt `RUN npm ci --only=production`
RUN npm install --only=production
COPY . .
CMD ["node", "index.js"]
