/*jshint esversion: 6 */
(function () {
  'use strict';
  
  const config = require("nconf");
  config.file(`${__dirname}/config.json`);
  
  const express = require('express');
  const app = express();
  const request = require('request');
  const statusUtils = require('./statusUtils');
  const util = require('util');
  const async = require('async');
  const mustache = require('mustache');
  const fs = require('fs-extra');
  const exec = require('child_process').exec;
  const spawn = require('child_process').spawn;
  const Watcher = require('./watcher');
  const watcher = new Watcher(config);
  const _ = require('lodash');
  
  const restartQueue = async.queue((group, callback) => {
    restartGroup(group, callback);
  }, 1);

  const FAILSAFE_TYPE = 'failsafe';

  var failsafeProcess = null;
  
  function init() {
    var initialStatus = {
      groups: {},
      hosts: {}
    };
    for (let i = 0; i < config.get("hosts").length; i++) {
      var host = config.get("hosts")[i];
      initialStatus.hosts[host.url] = 'UP';
      if (typeof (initialStatus.groups[host.group]) == 'undefined') {
        initialStatus.groups[host.group] = 'UP';
      }
    }
    statusUtils.saveStatus(config.get("statusPath"), initialStatus);
  }

  function setGroupUp(group) {
    for (let i = 0; i < config.get("hosts").length; i++) {
      var host = config.get("hosts")[i];
      if (group == host.group) {
        watcher.setUp(host);
        console.log(util.format('Forced host %s up', host.url));
      }
    }
  }

  function setGroupDown(group) {
    for (let i = 0; i < config.get("hosts").length; i++) {
      var host = config.get("hosts")[i];
      if (group == host.group) {
        watcher.setDown(host);
        console.log(util.format('Forced host %s down', host.url));
      }
    }
  }

  function updateConfig() {
    var template = fs.readFileSync(config.get("upstreamTemplate"), 'utf8');
    var status = statusUtils.loadStatus(config.get("statusPath"));
    var hostList = [];
    for (var i = 0; i < config.get("hosts").length; i++) {
      var host = config.get("hosts")[i];
      if (status.hosts[host.url] == 'UP') {
        hostList.push(host.url);
      } else {
        hostList.push(util.format('%s down', host.url));
      }
    }
    var upstream = mustache.render(template, { hosts: hostList });
    fs.writeFileSync(config.get("nginxConfigPath"), upstream);
    reloadNginx();
  }

  function createCompareShutdownPriorities() {
    var status = statusUtils.loadStatus(config.get("statusPath"));

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
    for (let i = 0; i < config.get("hosts").length; i++) {
      var host = config.get("hosts")[i];
      if (host.group == group) {
        hosts.push(host);
      }
    }

    return hosts;
  }

  function getFailsafeHost() {
    for (let i = 0; i < config.get("hosts").length; i++) {
      var host = config.get("hosts")[i];
      if (host.type == FAILSAFE_TYPE) {
        return host;
      }
    }
    
    return null;
  }

  function startFailsafeServer(war) {
    var failsafeHost = getFailsafeHost();
    if (failsafeHost) {
      console.log('Starting failsafe server');
      fs.copySync(failsafeHost.properties.configOrig, failsafeHost.properties.configFile);
      failsafeProcess = spawn(failsafeHost.properties.jbossCli);
      failsafeProcess.stdin.setEncoding('utf-8');
      failsafeProcess.stdout.pipe(process.stdout);
      failsafeProcess.stdin.write(util.format('embed-server --admin-only=false --std-out=echo\n'));
      failsafeProcess.stdin.write(util.format('deploy %s/%s\n', failsafeHost.properties.deploymentsPath, war));
    } else {
      console.log('Failsafe host not configured');
    }
  }
  
  function stopFailsafeServer() {
    if (failsafeProcess) {
      failsafeProcess.stdin.setEncoding('utf-8');
      failsafeProcess.stdout.pipe(process.stdout);
      failsafeProcess.stdin.write("exit\n");
      failsafeProcess.kill();
      failsafeProcess = null;
    }
  }

  function prepareForShutdown(group, callback) {
    setGroupDown(group);
    if (config.get("hooks") && config.get("hooks").beforeShutdown) {
      var hosts = getHostsByGroup(group);
      for (let i = 0; i < config.get("hooks").beforeShutdown.length; i++) {
        var beforeShutdownHook = config.get("hooks").beforeShutdown[i];
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
    }
    
    callback();
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
            watcher.clearUpCallbacks(group);
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
  
  function executeScript(script, params) {
    if (!script) {
      return;
    }

    return new Promise((resolve, reject) => {
      const escapedParams = params.map((param) => {
        return `'${param}'`;
      });

      const command = `${script} ${escapedParams ? escapedParams.join(' ') : ''}`;
      const child = exec(command);
  
      child.stdout.on('data', (data) => {
        console.log(data);
      });
  
      child.stderr.on('data', (data) => {
        console.error(data);
      });
  
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(`Process failed with code ${code}`);
        }
      });
    });
  }

  function reloadNginx() {
    const skipReload = config.get("test") === true;
    
    if (skipReload) {
      console.log('Service in TEST mode, skipping nginx reload');
      return;
    }
    
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
  
  async function updateGroups(version) {
    const status = statusUtils.loadStatus(config.get("statusPath"));
    const groups = Object.keys(status.groups);
    const failsafeHost = getFailsafeHost();
    const normalGroups = groups.filter((group) => {
      return !failsafeHost || group !== failsafeHost.group;
    });

    normalGroups.forEach((group) => {
      setGroupDown(group);
    });

    const normalGroupsParam = normalGroups.join(" ");

    await executeScript(config.get("scripts:shutdown"), [ normalGroupsParam, version ]);
    await executeScript(config.get("scripts:prepare-update"), [ normalGroupsParam, version ]);
    await executeScript(config.get("scripts:update"), [ normalGroupsParam, version ]);
    await executeScript(config.get("scripts:finalize-update"), [ normalGroupsParam, version ]);

    normalGroups.forEach((group) => {
      setGroupUp(group);
    });

    await watcher.waitUntilAnyUp(normalGroups);

    console.log(`Successfully updated ${version}`);
    stopFailsafeServer();
  }

  init();

  app.set('port', config.get("port"));

  app.get('/status', (req, res) => {
    res.send(statusUtils.loadStatus(config.get("statusPath")));
  });

  app.get('/health', (req, res) => {
    var hosts = _.filter(config.get("hosts"), (host) => { return host.type !== FAILSAFE_TYPE; });
    var totalHosts = hosts.length;
    var hostsDown = 0;
    var status = statusUtils.loadStatus(config.get("statusPath"));
    
    for (let i = 0; i < totalHosts; i++) {
      if (status.hosts[hosts[i].url] == 'DOWN') {
        hostsDown++;
      }
    }
    
    if (hostsDown == 0) {
      res.send(util.format('OK: %s / %s hosts up.', (totalHosts - hostsDown), totalHosts));
    } else {
      var percentDown = hostsDown / totalHosts;
      if (percentDown >= config.get("criticalTreshold")) {
        res.send(util.format('CRITICAL: %s / %s hosts up.', (totalHosts - hostsDown), totalHosts));
      } else {
        res.send(util.format('WARNING: %s / %s hosts up.', (totalHosts - hostsDown), totalHosts));
      }
    }
    
  });

  app.get('/group/:group/down', (req, res) => {
    var group = req.params.group;
    var status = statusUtils.loadStatus(config.get("statusPath"));
    if (typeof (status.groups[group]) == 'undefined') {
      res.status(404).send();
    } else {
      setGroupDown(group);
      res.send('ok');
    }
  });

  app.get('/group/:group/up', (req, res) => {
    var group = req.params.group;
    var status = statusUtils.loadStatus(config.get("statusPath"));
    if (typeof (status.groups[group]) == 'undefined') {
      res.status(404).send();
    } else {
      setGroupUp(group);
      res.send('ok');
    }
  });

  app.get('/cluster/restart', (req, res) => {
    var status = statusUtils.loadStatus(config.get("statusPath"));
    var groups = Object.keys(status.groups);
    groups.sort(createCompareShutdownPriorities());
    for (let i = 0; i < groups.length; i++) {
      restartQueue.push(groups[i]);
    }

    res.send('ok');
  });

  app.get('/cluster/failsafe/start/:war', (req, res) => {
    var war = req.params.war;
    
    var failsafeHost = getFailsafeHost();
    if(!failsafeHost) {
      console.log('ERROR! Failsafe host not configured, cannot start failsafe server.');
    } else {
      startFailsafeServer(war);
      var timeout = setTimeout(() => {
        console.log('WARNING! Failsafe host was not able to start, skipping update.');
      }, 1000 * 60 * 10);
      
      watcher.waitUntilUp(failsafeHost.group, () => {
        console.log('Failsafe server up');
        clearTimeout(timeout);
      });
    }
    
    res.send('ok');
  });
  
  app.get('/cluster/failsafe/stop', (req, res) => {
    stopFailsafeServer();
    res.send('ok');
  });

  app.get('/cluster/update/:war', (req, res) => {
    var war = req.params.war;
    
    var failsafeHost = getFailsafeHost();
    if (!failsafeHost) {
      console.log('WARNING! Failsafe host not configured, updating without failsafe.');
      updateGroups(war);
    } else {
      startFailsafeServer(war);
      var timeout = setTimeout(() => {
        console.log('WARNING! Failsafe host was not able to start, skipping update.');
        watcher.clearUpCallbacks(failsafeHost.group);
      }, 1000 * 60 * 10);

      watcher.waitUntilUp(failsafeHost.group, () => {
        console.log('Failsafe server up');
        clearTimeout(timeout);
        updateGroups(war);
      });
    }
    
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

  http.listen(config.get("port"), function () {
    console.log(util.format('Listening to %s', config.get("port")));
  });

})();
