/*jshint esversion: 6 */
(function () {
  'use strict';

  const express = require('express');
  const app = express();
  const request = require('request');
  const statusUtils = require('./statusUtils');
  const config = require('./config');
  const util = require('util');
  const async = require('async');
  const mustache = require('mustache');
  const fs = require('fs');
  const exec = require('child_process').exec;
  const Watcher = require('./watcher');
  const watcher = new Watcher(config);
  const restartQueue = async.queue((group, callback) => {
    restartGroup(group, callback);
  }, 1);

  function init() {
    var initialStatus = {
      groups: {},
      hosts: {}
    };
    for (let i = 0; i < config.hosts.length; i++) {
      var host = config.hosts[i];
      initialStatus.hosts[host.url] = 'UP';
      if (typeof (initialStatus.groups[host.group]) == 'undefined') {
        initialStatus.groups[host.group] = 'UP';
      }
    }
    statusUtils.saveStatus(config.statusPath, initialStatus);
  }

  function setGroupUp(group) {
    for (let i = 0; i < config.hosts.length; i++) {
      var host = config.hosts[i];
      if (group == host.group) {
        watcher.setUp(host);
        console.log(util.format('Forced host %s up', host.url));
      }
    }
  }

  function setGroupDown(group) {
    for (let i = 0; i < config.hosts.length; i++) {
      var host = config.hosts[i];
      if (group == host.group) {
        watcher.setDown(host);
        console.log(util.format('Forced host %s down', host.url));
      }
    }
  }

  function updateConfig() {
    var template = fs.readFileSync(config.upstreamTemplate, 'utf8');
    var status = statusUtils.loadStatus(config.statusPath);
    var hostList = [];
    for (var i = 0; i < config.hosts.length; i++) {
      var host = config.hosts[i];
      if (status.hosts[host.url] == 'UP') {
        hostList.push(host.url);
      } else {
        hostList.push(util.format('%s down', host.url));
      }
    }
    var upstream = mustache.render(template, { hosts: hostList });
    fs.writeFileSync(config.nginxConfigPath, upstream);
    reloadNginx();
  }

  function createCompareShutdownPriorities() {
    var status = statusUtils.loadStatus(config.statusPath);

    return function (group1, group2) {
      if (status.groups[group1] == 'DOWN') {
        return -1;
      } else if (status.groups[group2] == 'DOWN') {
        return 1;
      } else {
        return 0;
      }
    }
  }

  function getHostsByGroup(group) {
    var hosts = [];
    for (let i = 0; i < config.hosts.length; i++) {
      var host = config.hosts[i];
      if (host.group == group) {
        hosts.push(host);
      }
    }

    return hosts;
  }

  function prepareForShutdown(group, callback) {
    setGroupDown(group);
    if (config.hooks && config.hooks.beforeShutdown) {
      var hosts = getHostsByGroup(group);
      for (let i = 0; i < config.hooks.beforeShutdown.length; i++) {
        var beforeShutdownHook = config.hooks.beforeShutdown[i];
        for (let j = 0; j < hosts.length; j++) {
          var host = hosts[j];
          var options = {
            url: util.format('%s://%s%s', host.protocol, host.url, beforeShutdownHook.path),
            headers: host.headers,
            timeout: 10000
          };
          request(options, (error, response, body) => {});
        }
      }
      callback();
    }
  }


  function restartGroup(group, callback) {
    prepareForShutdown(group, () => {
      var child = exec(util.format('/opt/cluster-controller/restart.sh %s', group));

      child.stdout.on('data', function (data) {
        console.log(data);
      });

      child.stderr.on('data', function (data) {
        console.error(data);
      });

      child.on('close', function (code) {
        if (code == 0) {
          setGroupUp(group);

          var timeout = setTimeout(() => {
            console.log(util.format('Left group %s down because of timeout', group));
            callback();
          }, 1000 * 60 * 10);

          watcher.waitUntilUp(group, () => {
            console.log(util.format('successfully restarted group %s', group));
            clearTimeout(timeout);
            callback();
          });
        } else {
          console.log(util.format('Left group %s down because of error code %s', group, code));
          callback();
        }
      });
    });
  }

  function updateGroup(group, war, callback) {
    prepareForShutdown(group, () => {
      var child = exec(util.format('/opt/cluster-controller/update.sh %s %s', group, war));

      child.stdout.on('data', function (data) {
        console.log(data);
      });

      child.stderr.on('data', function (data) {
        console.error(data);
      });

      child.on('close', function (code) {
        if (code == 0) {
          setGroupUp(group);
          
          /*var timeout = setTimeout(() => {
            callback('update timed out');
          }, 1000 * 60 * 10);

          watcher.waitUntilUp(group, () => {
            console.log(util.format('Successfully updated group %s to %s', group, war));
            clearTimeout(timeout);*/
            callback(null, group);
          //});
        } else {
          callback('Update Failed');
        }
      });
    });
  }

  function reloadNginx() {
    var child = exec('service nginx reload');

    child.stdout.on('data', function (data) {
      console.log(data);
    });

    child.stderr.on('data', function (data) {
      console.error(data);
    });

    child.on('close', function (code) {
      console.log(code != 0 ? 'Failed to reload nginx configuration.' : 'Nginx reloaded successfully');
    });
  }

  init();

  //var socket = require('socket.io-client')(config.metadog);

  /*socket.on('server:critical', (data) => {
    var server = data.server;
    for (var i = 0; i < config.hosts.length; i++) {
      var host = config.hosts[i];
      if (host.name == server) {
        restartGroup.push(host.group);
      }
    }
  });*/

  app.set('port', config.port);

  app.get('/status', (req, res) => {
    res.send(statusUtils.loadStatus(config.statusPath));
  });

  app.get('/health', (req, res) => {
    var totalHosts = config.hosts.length;
    var hostsDown = 0;
    var status = statusUtils.loadStatus(config.statusPath);
    for (let i = 0; i < totalHosts; i++) {
      if (status.hosts[config.hosts[i].url] == 'DOWN') {
        hostsDown++;
      }
    }
    if (hostsDown == 0) {
      res.send(util.format('OK: %s / %s hosts up.', (totalHosts - hostsDown), totalHosts));
    } else {
      var percentDown = hostsDown / totalHosts;
      if (percentDown >= config.criticalTreshold) {
        res.send(util.format('CRITICAL: %s / %s hosts up.', (totalHosts - hostsDown), totalHosts));
      } else {
        res.send(util.format('WARNING: %s / %s hosts up.', (totalHosts - hostsDown), totalHosts));
      }
    }
  });

  app.get('/group/:group/down', (req, res) => {
    var group = req.params.group;
    var status = statusUtils.loadStatus(config.statusPath);
    if (typeof (status.groups[group]) == 'undefined') {
      res.status(404).send();
    } else {
      setGroupDown(group);
      res.send('ok');
    }
  });

  app.get('/group/:group/up', (req, res) => {
    var group = req.params.group;
    var status = statusUtils.loadStatus(config.statusPath);
    if (typeof (status.groups[group]) == 'undefined') {
      res.status(404).send();
    } else {
      setGroupUp(group);
      res.send('ok');
    }
  });

  app.get('/cluster/restart', (req, res) => {
    var status = statusUtils.loadStatus(config.statusPath);
    var groups = Object.keys(status.groups);
    groups.sort(createCompareShutdownPriorities());
    for (let i = 0; i < groups.length; i++) {
      restartQueue.push(groups[i]);
    }

    res.send('ok');
  });

  app.get('/cluster/update/:war', (req, res) => {
    var war = req.params.war;
    var status = statusUtils.loadStatus(config.statusPath);
    var groups = Object.keys(status.groups);
    groups.sort(createCompareShutdownPriorities());
    var firstGroup = groups.shift();
    updateGroup(firstGroup, war, (err, updatedGroup) => {
      if (err) {
        console.error('Update Failed');
      } else {
        console.log(util.format('successfully updated group: %s', updatedGroup));
        for (let i = 0; i < groups.length; i++) {
          updateGroup(groups[i], war, (err, updatedGroup) => {
            console.log(util.format('successfully updated group: %s', updatedGroup));
          });
        }
      }
    });

    res.send('ok');
  });

  watcher.on('host-up', (host) => {
    console.log(util.format('Host %s from group %s went UP', host.url, host.group));
    updateConfig();
  });

  watcher.on('host-down', (host) => {
    console.log(util.format('Host %s from group %s went DOWN', host.url, host.group));
    updateConfig();
  });

  watcher.on('group-up', (group) => {
    console.log(util.format('Group %s went UP', group));
  });

  watcher.on('group-down', (group) => {
    console.log(util.format('Group %s went DOWN', group));
  });

  watcher.start();

  var http = require('http').Server(app);

  http.listen(config.port, function () {
    console.log(util.format('Listening to %s', config.port));
  });

})();