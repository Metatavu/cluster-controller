
/*jshint esversion: 6 */
(function () {
  'use strict';

  const express = require('express');
  const app = express();
  const statusUtils = require('./statusUtils');
  const config = require('./config');
  const util = require('util');
  const mustache = require('mustache');
  const fs = require('fs');
  const exec = require('child_process').exec;
  const Watcher = require('./watcher');
  const watcher = new Watcher(config);

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

  app.set('port', config.port);

  app.get('/status', (req, res) => {
    res.send(statusUtils.loadStatus(config.statusPath));
  });

  app.get('/health', (req, res) => {
    var totalHosts = config.hosts.length;
    var hostsDown = 0;
    var status = statusUtils.loadStatus(config.statusPath);
    for (let i = 0; i < totalHosts; i++) {
      if (status.hosts[hosts[i].url] == 'DOWN') {
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
      for (let i = 0; i < config.hosts.length; i++) {
        var host = config.hosts[i];
        if (group == host.group) {
          watcher.setDown(host);
          console.log(util.format('Forced host %s down', host.url));
        }
      }
      res.send('ok');
    }
  });

  app.get('/group/:group/up', (req, res) => {
    var group = req.params.group;
    var status = statusUtils.loadStatus(config.statusPath);
    if (typeof (status.groups[group]) == 'undefined') {
      res.status(404).send();
    } else {
      for (let i = 0; i < config.hosts.length; i++) {
        var host = config.hosts[i];
        if (group == host.group) {
          watcher.setUp(host);
          console.log(util.format('Forced host %s up', host.url));
        }
      }
      res.send('ok');
    }
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