# node_container_advisor

put container stats to cloudwatch.

# Usage

## quickly start test

```shell
docker run --rm \
    --net=host \
    --privileged \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION=YOUR_AWS_DEFAULT_REGION \
    misfit/node_container_advisor \
    node index.js \
    --test \
    --dry-run \
    --once \
    --interval=3
```

## command line arguments

```shell
--test         put metric data to ECS Custom Test Metrics, default is false
--dry-run      only print metric data, do not put to cloudwatch default is false
--once         only put/print metric data once, default is false
--interval     put/print metric data interval, unit is second, default is 60
```

## run on server

```shell
docker run -d --name node_container_advisor \
    --net=host \
    --privileged \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION=YOUR_AWS_DEFAULT_REGION \
    misfit/node_container_advisor \
    node index.js
```
