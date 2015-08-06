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
      // console.log('add container \n', c, '\n into containers \n', containers);
    })
  });

  // stop & die
  // https://github.com/mcollina/docker-allcontainers/blob/master/allcontainers.js#L69
  ee.on('stop', function(meta, container) {
    // console.log("stop...", meta)
    var c = containers[meta.id.substring(0,12)];
    delete containers[meta.id.substring(0,12)];
    // console.log('remove container \n', c, '\n from containers \n', containers);
  });

  stats({events: ee}).pipe(through.obj(function(v, enc, next) {
    // console.log(JSON.stringify(stat))
    var c = containers[v.id]
    if (!c) { return next(); }
    // timestamp format: 2015-08-06T10:14:54.000Z
    var m = {
      container_name: c.ContainerName,
      image_name: c.ImageName,
      ecs_task_family: c.ECSTaskFamily,
      ecs_container_name: c.ECSContainerName,
      cpu_usage: v.stats.cpu_stats.cpu_usage.total_usage,
      cpu_percent: v.stats.cpu_stats.cpu_usage.cpu_percent.toFixed(2),
      network_rx_bytes: v.stats.network.rx_bytes,
      network_tx_bytes: v.stats.network.tx_bytes,
      memory_usage: v.stats.memory_stats.usage,
      memory_percent: (v.stats.memory_stats.usage / v.stats.memory_stats.limit * 100).toFixed(2),
      timestamp: moment().utc().toISOString()
    }
    // console.log(JSON.stringify(m))
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

  console.log('namespace:', namespace);
  console.log('region:   ', region);

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
        Value: (m.memory_usage/1024/1024).toFixed(0),
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
        Value: (m.network_rx_bytes/1024).toFixed(2),
        Unit: "Kilobytes"
      }
      , {
        MetricName: "NetworkOut",
        Dimensions: dimensions,
        Timestamp: m.timestamp,
        Value: (m.network_tx_bytes/1024).toFixed(2),
        Unit: "Kilobytes"
      }
    ];
    // console.log(metric_data);
    return metric_data;
  }

  ret.save = function() {
    var _metrics = metrics;
    metrics = [];

    var metric_data = [];
    _metrics.forEach(function(m) {
      metric_data = metric_data.concat(toMetricData(m));
    });

    if (opts.dry_run) {
      console.log(JSON.stringify(metric_data));
      if (opts.once) {
        console.log("run only once.");
        process.exit();
      }
    } else {
      // console.log("put metric data to cloudwatch...");
      data = { 
          MetricData: metric_data,
          Namespace: namespace
      };
      cloudwatch.putMetricData(data, function(err, data) {
        if (err) console.log(err, err.stack); // an error occurred
        else     console.log(data);           // successful response
        
        if (opts.once) {
          console.log("run only once.");
          process.exit();
        }
      });
    }
  }

  return ret;
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
