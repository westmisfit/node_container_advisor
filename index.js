var through = require('through2')
  , stats = require('docker-stats')
  , allContainers = require('docker-allcontainers')
  , moment = require('moment')
  , AWS = require('aws-sdk')

// const
var per3seconds = 3 * 1000;
var perminute = 60 * 1000;

var containers = {};
var metrics = [];
var instance_id = "ip_192_168_0_1";

function init() {
  var opts = {
      docker: null // here goes options for Dockerode
    , events: null // an instance of docker-allcontainers

    // the following options limit the containers being matched
    // so we can avoid catching logs for unwanted containers
    // , matchByName: /hello/ // optional
    // , matchByImage: /matteocollina/ //optional
    // , skipByName: /.*pasteur.*/ //optional
    // , skipByImage: /.*dockerfile.*/ //optional
  }

  // docker events explain
  // http://gliderlabs.com/blog/2015/04/14/docker-events-explained/
  var ee = allContainers(opts);

  // restore & start
  // https://github.com/mcollina/docker-allcontainers/blob/master/allcontainers.js#L65
  ee.on('start', function(meta, container) {  
    container.inspect(function(err, info) {
      var c = {};
      c.Id = info.Id;
      c.ContainerName = info.Name.substring(1);
      if (info.Config) {
        c.ImageName = info.Config.Image;
        if (info.Config.Labels) {
          c.ECSTaskFamily = info.Config.Labels["com.amazonaws.ecs.task-definition-family"];
          c.ECSContainerName = info.Config.Labels["com.amazonaws.ecs.container-name"];
        }
      }
      containers[meta.id.substring(0,12)] = c;
      // debug('add container \n', c, '\n into containers \n', containers);
    })
  });

  // stop & die
  // https://github.com/mcollina/docker-allcontainers/blob/master/allcontainers.js#L69
  ee.on('stop', function(meta, container) {
    // debug("stop...", meta)
    var c = containers[meta.id.substring(0,12)];
    delete containers[meta.id.substring(0,12)];
    // debug('remove container \n', c, '\n from containers \n', containers);
  });

  stats({events: ee}).pipe(through.obj(function(v, enc, next) {
    // debug(JSON.stringify(stat))
    var c = containers[v.id]
    if (!c) { return next(); }
    // timestamp format: 2015-08-06T10:14:54.000Z
    var m = {
      id: c.Id,
      container_name: c.ContainerName,
      image_name: c.ImageName,
      ecs_task_family: c.ECSTaskFamily,
      ecs_container_name: c.ECSContainerName,
      cpu_usage: v.stats.cpu_stats.cpu_usage.total_usage,
      cpu_percent: Number(v.stats.cpu_stats.cpu_usage.cpu_percent.toFixed(2)),
      network_rx_bytes: v.stats.network.rx_bytes,
      network_tx_bytes: v.stats.network.tx_bytes,
      memory_usage: v.stats.memory_stats.usage,
      memory_percent: Number((v.stats.memory_stats.usage / v.stats.memory_stats.limit * 100).toFixed(2)),
      timestamp: moment().utc().toISOString()
    }
    // debug(JSON.stringify(m))
    metrics.push(m)
    return next();
  }));
}

function start(opts, interval) {
  var storageDriver;
  switch (opts.type) {
    case 'cloudwatch':
      storageDriver = cloudwatchStorageDriver(opts);
      break;
  }
  if (storageDriver) {
    setInterval(storageDriver.save, interval);
  }
}

function cloudwatchStorageDriver(opts){
  opts = opts || {};
  var namespace = opts.namespace || "ECS Custom";
  var region = process.env['AWS_DEFAULT_REGION'] || 'us-east-1';
  var ret = {};

  info('namespace:', namespace);
  info('region:   ', region);

  AWS.config.update({region: region});

  var cloudwatch = new AWS.CloudWatch();

  function toMetricData(m) {
    var dimensions = [{ Name: "ImageName", Value: m.image_name }];
    if (instance_id) { dimensions.push({ Name: "InstanceId", Value: instance_id }); }
    if (m.ecs_container_name) {
      dimensions.push(
          { Name: "ECSContainerName", Value: m.ecs_container_name || "<no value>" }
        , { Name: "ECSTaskFamily", Value: m.ecs_task_family || "<no value>" }
      );
    } else {
      dimensions.push({ Name: "ContainerName", Value: m.container_name });
    }
    var metric_data = [
      {
        MetricName: "MemoryUsage",
        Dimensions: dimensions,
        Timestamp: m.timestamp,
        Value: Number((m.memory_usage/1024/1024).toFixed(2)),
        Unit: "Megabytes"
      }
      , {
        MetricName: "MemoryPercent",
        Dimensions: dimensions,
        Timestamp: m.timestamp,
        Value: m.memory_percent,
        Unit: "Percent"
      }
      , {
        MetricName: "CPUUtilization",
        Dimensions: dimensions,
        Timestamp: m.timestamp,
        Value: m.cpu_percent,
        Unit: "Percent"
      }
      , {
        MetricName: "NetworkIn",
        Dimensions: dimensions,
        Timestamp: m.timestamp,
        Value: Number((m.network_rx_bytes/1024).toFixed(2)),
        Unit: "Kilobytes"
      }
      , {
        MetricName: "NetworkOut",
        Dimensions: dimensions,
        Timestamp: m.timestamp,
        Value: Number((m.network_tx_bytes/1024).toFixed(2)),
        Unit: "Kilobytes"
      }
    ];
    // debug(metric_data);
    return metric_data;
  }

  function trimMetrics(metrics) {
    // trim duplicated container metric, keep the last
    var map = {};
    metrics.forEach(function(m) {
      map[m.id] = m;
    });
    var _metrics = [];
    for (var k in map) {
      if (map[k]) {
        _metrics.push(map[k]);
      }
    }
    return _metrics;
  }

  function putMetricData(metric_data, cb) {
    // The collection MetricData must not have a size greater than 20.
    var part;
    var data_array = [];

    if (metric_data.length === 0) {
      cb(new Error("no metric data to put."), null);
    }

    (function next(err, data) {
      if (err) { return cb(err); }
      if (data) { data_array.push(data); }
      if (metric_data.length === 0) { return cb(null, data_array); }

      part = metric_data.slice(0,20);
      metric_data = metric_data.slice(20);
      // debug('process %d, left %d', part.length, metric_data.length);

      params = { 
        MetricData: part,
        Namespace: namespace
      };
      cloudwatch.putMetricData(params, next);
      // debug(JSON.stringify(part));
      // next(null, "{\"Response\":\"OK\"}");
    })(null, null);
  }

  ret.save = function() {
    var _metrics = trimMetrics(metrics);
    metrics = [];
    // debug('total %d metrics', _metrics.length)
    // debug(JSON.stringify(_metrics));

    var metric_data = [];
    _metrics.forEach(function(m) {
      metric_data = metric_data.concat(toMetricData(m));
    });

    if (opts.dry_run) {
      info(JSON.stringify(metric_data));
      if (opts.once) {
        info("run only once.");
        process.exit();
      }
    } else {
      putMetricData(metric_data, function(err, data) {
        if (err) error(err, err.stack); // an error occurred
        else     info(data);            // successful response

        if (opts.once) {
          info("run only once.");
          process.exit();
        }
      });
    }
  }

  return ret;
}

function debug() {
  console.log.apply(console, arguments);
}

function info() {
  console.log.apply(console, arguments);
}

function error() {
  console.log.apply(console, arguments);
}

function cli() {
  var argv = require('minimist')(process.argv.slice(2))
  init();
  var opts = {
    type: "cloudwatch",
    namespace: (argv.test ? "ECS Custom Test" : "ECS Custom"),
    dry_run: !!argv['dry-run'],
    once: !!argv['once']
  };
  var interval = (argv.test ? per3seconds : perminute);
  start(opts, interval);
}

if (require.main === module) {
  cli();
}
