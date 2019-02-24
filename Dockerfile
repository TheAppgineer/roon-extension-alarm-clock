ARG build_arch=amd64

# Use an official node runtime as a parent image
FROM ${build_arch}/node:8.14.1-alpine

RUN mkdir -p /usr/src/app

WORKDIR /usr/src/app

COPY alarm-clock.js LICENSE package.json /usr/src/app/

RUN apk add --no-cache git tzdata && \
    npm install && \
    apk del git

CMD [ "node", "." ]
