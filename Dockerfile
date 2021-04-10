ARG build_arch=amd64

FROM multiarch/alpine:${build_arch}-v3.12

RUN mkdir -p /usr/src/app

WORKDIR /usr/src/app

COPY alarm-clock.js LICENSE package.json /usr/src/app/

RUN apk add --no-cache nodejs tzdata git npm && \
    npm install && \
    apk del git npm

CMD [ "node", "." ]
