FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install -production
COPY src/ ./src/
EXPOSE 5000
EXPOSE 9464
CMD ["npm", "start"]