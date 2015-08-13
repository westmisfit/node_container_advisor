var through = require('through2')
  , stats = require('docker-stats')
  , allContainers = require('docker-allcontainers')
  , moment = require('moment')
  , AWS = require('aws-sdk')
  , request = require('request')

var containers = {};
var metrics = [];
var instance_id = null;

function getInstanceId(cb) {
  var opts = {
    url: 'http://169.254.169.254/latest/meta-data/instance-id',
    timeout: 1000
  };
  // debug('get instance_id...')
  request(opts, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      instance_id = body;
      // debug("instance_id =", instance_id);
    } else {
      instance_id = null;
      // debug("can't get instance_id.")
    }
    return cb();
  });
}

function init(opts) {
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
    var c = containers[v.id];
    if (!c) { return next(); }
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
      // timestamp format: 2015-08-06T10:14:54.000Z
      timestamp: moment().utc().toISOString()
    };
    // debug(JSON.stringify(m))
    metrics.push(m);
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

  info('namespace:   ', namespace);
  info('region:      ', region);
  info('instance_id: ', instance_id);

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
    
    /**
     * Unit
     *
     * The unit of the metric.
     * 
     * Type: String
     * 
     * Valid Values: Seconds | Microseconds | Milliseconds | Bytes | 
     * Kilobytes | Megabytes | Gigabytes | Terabytes | Bits | Kilobits | 
     * Megabits | Gigabits | Terabits | Percent | Count | Bytes/Second | 
     * Kilobytes/Second | Megabytes/Second | Gigabytes/Second | 
     * Terabytes/Second | Bits/Second | Kilobits/Second | Megabits/Second | 
     * Gigabits/Second | Terabits/Second | Count/Second | None
     */
    var metric_data = [
        { MetricName: "MemoryUsageBytes",
          Dimensions: dimensions,
          Timestamp: m.timestamp,
          Value: m.memory_usage,
          Unit: "Bytes" }
      , { MetricName: "MemoryPercent",
          Dimensions: dimensions,
          Timestamp: m.timestamp,
          Value: m.memory_percent,
          Unit: "Percent" }
      , { MetricName: "CPUPercent",
          Dimensions: dimensions,
          Timestamp: m.timestamp,
          Value: m.cpu_percent,
          Unit: "Percent" }
      , { MetricName: "NetworkInBytes",
          Dimensions: dimensions,
          Timestamp: m.timestamp,
          Value: calculateDeltaValue(m, 'network_rx_bytes'),
          Unit: "Bytes" }
      , { MetricName: "NetworkOutBytes",
          Dimensions: dimensions,
          Timestamp: m.timestamp,
          Value: calculateDeltaValue(m, 'network_tx_bytes'),
          Unit: "Bytes" }
    ];
    // debug(metric_data);
    return metric_data;
  }

  function calculateDeltaValue(m, attr) {
    var c = containers[m.id.substring(0,12)];
    if (!c) { return 0; }
    if (!c.previous) { c.previous = {}; }
    if (!c.previous[attr]) { c.previous[attr] = m[attr]; }
    // debug(c.previous);
    var delta = m[attr] - c.previous[attr];
    c.previous[attr] = m[attr];
    return delta;
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
      return cb(new Error("no metric data to put."), null);
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
    // debug('total %d metrics, left %d metrics after trim', metrics.length, _metrics.length);
    // debug(JSON.stringify(_metrics));
    metrics = [];

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
  var argv = require('minimist')(process.argv.slice(2));
  // debug(argv);
  
  var init_opts = {
      docker: null // here goes options for Dockerode
    , events: null // an instance of docker-allcontainers

    // the following options limit the containers being matched
    // so we can avoid catching logs for unwanted containers
    // , matchByName: /hello/ // optional
    // , matchByImage: /matteocollina/ //optional
    , skipByName: /ecs-agent/ //optional
    // , skipByImage: /.*dockerfile.*/ //optional
  }
  init(init_opts);

  var run_opts = {
    type: "cloudwatch",
    namespace: (argv['test'] ? "ECS Custom Test" : "ECS Custom"),
    dry_run: !!argv['dry-run'],
    once: !!argv['once']
  };

  var interval = (argv['interval'] || 60) * 1000;

  getInstanceId(function () {
    // debug('start...')
    start(run_opts, interval);
  });
}

if (require.main === module) {
  cli();
}
