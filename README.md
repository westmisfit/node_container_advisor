# Usage

```shell
docker run --rm \
    --privileged \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION=YOUR_AWS_DEFAULT_REGION \
    misfit/docker-stats-cloudwatch \
    node index.js --test --dry-run
```

```
--test       put metric data to ECS Custom Test Metrics
--dry-run    only print metric data, do not put to cloudwatch
--once       only put/print metric data once
```

# Build

```shell
docker build -t misfit/docker-stats-cloudwatch .
```
