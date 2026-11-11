ARG node_version=22

FROM node:${node_version}-alpine

RUN mkdir -p /usr/src/app

WORKDIR /usr/src/app

COPY alarm-clock.js LICENSE package.json /usr/src/app/

RUN apk add --no-cache tzdata git && \
    npm install && \
    apk del git

CMD [ "node", "." ]
