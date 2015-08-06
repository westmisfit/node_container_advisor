# docker-stats-cloudwatch

put docker container cpu memory network stats to cloudwatch.

# Usage

## quickly start test

```shell
docker run --rm \
    --privileged \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION=YOUR_AWS_DEFAULT_REGION \
    misfit/docker-stats-cloudwatch \
    node index.js \
    --test \
    --dry-run \
    --once \
    --interval=3 \
    --instance-id=$(wget -q -O - http://169.254.169.254/latest/meta-data/instance-id)
```

## command line arguments

```shell
--test         put metric data to ECS Custom Test Metrics, default is false
--dry-run      only print metric data, do not put to cloudwatch default is false
--once         only put/print metric data once, default is false
--interval     put/print metric data interval, unit is second, default is 60
--instance-id  aws ec2 instance id
```

## run on server

```shell
docker run -d --name docker-stats-cloudwatch \
    --privileged \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION=YOUR_AWS_DEFAULT_REGION \
    misfit/docker-stats-cloudwatch \
    node index.js \
    --instance-id=$(wget -q -O - http://169.254.169.254/latest/meta-data/instance-id)
```
