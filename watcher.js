"use strict";

(function() {

  var events = require('events');
  var util = require('util');
  var request = require('request');
  var statusUtils = require('./statusUtils');

  class Watcher extends events.EventEmitter {
    constructor(config) {
      super();
      this.hosts = config.hosts;
      this.manuallyDown = [];
      this.checkPath = config.checkPath;
      this.statusPath = config.statusPath;
      this.interval = config.checkInterval || 1000;
      this.index = 0;
    }
    start() {
      this.checkHost();
    }
    setUp(host) {
      var index = manuallyDown.indexOf(host.url);
      if(index > -1) {
        manuallyDown.splice(index, 1);
      }
    }
    setDown(host) {
      this.manuallyDown.push(host.url);
    }
    handleHostUp(host) {
      if (status.hosts[host.url] == 'DOWN') {
        status.hosts[host.url] = 'UP';
        var groupUp = this.checkGroup(host.group, status);
        if (groupUp) {
          status.groups[host.group] = 'UP'
        }
        statusUtils.saveStatus(this.statusPath, status);
        this.emit('host-up', host);
        if (groupUp) {
          this.emit('group-up', host.group);
        }
      }
    }
    handleHostDown(host) {
      if (status.hosts[host.url] == 'UP') {
        status.hosts[host.url] = 'DOWN';
        var groupUp = status.groups[host.group] == 'UP';
        status.groups[host.group] = 'DOWN';
        statusUtils.saveStatus(this.statusPath, status);
        this.emit('host-down', host);
        if (groupUp) {
          this.emit('group-down', host.group);
        }
      }
    }
    checkHost() {
      this.index = this.index % this.hosts.length;
      var host = this.hosts[this.index];
      var options = {
        url: util.format('%s://%s%s', host.protocol, host.url, this.checkPath),
        headers: host.headers
      };
      if (this.manuallyDown.indexOf(host.url) > -1) {
        this.handleHostDown(host);
        this.index++;
        setTimeout(() => this.checkHost(), this.interval)
      } else {
        request(options, (error, response, body) => {
          var status = statusUtils.loadStatus(this.statusPath);
          if (!error && response.statusCode < 300 && response.statusCode >= 200) {
            this.handleHostUp(host);
          } else {
            this.handleHostDown(host);
          }
          this.index++;
          setTimeout(() => this.checkHost(), this.interval);
        });
      }
    }
    checkGroup(group, status) {
      for (var i = 0; i < this.hosts.length; i++) {
        var host = this.hosts[i];
        if (host.group == group && status.hosts[host.url] == 'DOWN') {
          return false;
        }
      }
      return true;
    }
  }

  module.exports = Watcher;

})();
