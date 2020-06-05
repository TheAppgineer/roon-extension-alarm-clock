# Use an official node runtime as a parent image
FROM node:12.16.3-alpine

RUN mkdir -p /usr/src/app

WORKDIR /usr/src/app

COPY alarm-clock.js LICENSE package.json /usr/src/app/

RUN apk add --no-cache git tzdata && \
    npm install && \
    apk del git

CMD [ "node", "." ]
