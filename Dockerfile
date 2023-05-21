FROM node:20-buster-slim

WORKDIR /usr/src/app
COPY . .

RUN npm i

EXPOSE 4200
CMD [ "npm", "run", "dev" ]